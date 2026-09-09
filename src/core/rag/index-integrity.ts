import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { agentPath } from '../config/agent-directory';
import { WorkspaceDiscoveryService } from '../config/workspace-discovery';
import type { EmbeddingsIdentity } from './embeddings/embeddings.port';
import { IndexLeaseSnapshot, inspectIndexLease } from './index-run-lease';
import { IndexStamp, readIndexStamp } from './index-stamp';

/** Vector population grouped by its immutable provider/model identity. */
export interface VectorIdentityCoverage {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly vectors: number;
}

/** Read-only evidence about the semantic index stored for one workspace root. */
export interface IndexIntegrityReport {
  readonly databasePath: string;
  readonly databaseExists: boolean;
  readonly schemaValid: boolean;
  readonly discoveryValid: boolean;
  readonly discoveredFiles: number;
  readonly files: number;
  readonly indexedFiles: number;
  readonly skippedFiles: number;
  readonly chunks: number;
  readonly vectors: readonly VectorIdentityCoverage[];
  readonly missingVectors: number;
  readonly missingPaths: readonly string[];
  readonly chunklessPaths: readonly string[];
  readonly pendingPaths: readonly string[];
  readonly stalePaths: readonly string[];
  readonly dimensionConflictIdentities: readonly string[];
  readonly lease: IndexLeaseSnapshot;
  readonly stamp?: IndexStamp;
  readonly stampConsistent: boolean;
  readonly selectedIdentity?: Pick<EmbeddingsIdentity, 'provider' | 'model'>;
  readonly healthy: boolean;
  readonly diagnostic?: string;
}

/** Required schema pieces for proving an index rather than merely reading it. */
const REQUIRED_TABLES = ['file_registry', 'code_chunks', 'chunk_vectors', 'index_lease'];
const REQUIRED_FILE_COLUMNS = ['path', 'hash', 'last_indexed', 'skeleton_signature', 'index_state', 'skip_reason'];

/**
 * Inspects the durable index without starting a provider or writing a database.
 *
 * @param rootDir - Root owning the `.umbra` workspace.
 * @param selectedIdentity - Optional provider/model whose coverage must be complete.
 * @returns Counts and concrete missing paths suitable for CLI and MCP diagnostics.
 */
export function inspectIndexIntegrity(
  rootDir: string,
  selectedIdentity?: Pick<EmbeddingsIdentity, 'provider' | 'model'>,
): IndexIntegrityReport {
  const resolvedRoot = path.resolve(rootDir);
  const databasePath = agentPath(resolvedRoot, 'memory.db');
  const discovery = discoverSources(resolvedRoot);
  const stamp = readIndexStamp(resolvedRoot);
  if (!fs.existsSync(databasePath)) {
    return emptyReport(
      databasePath,
      selectedIdentity,
      discovery,
      stamp,
      'No .umbra/memory.db exists for this root.',
    );
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    const fileColumns = tables.has('file_registry')
      ? new Set(
        (db.prepare('PRAGMA table_info(file_registry)').all() as { name: string }[])
          .map((column) => column.name),
      )
      : new Set<string>();
    const schemaValid = REQUIRED_TABLES.every((table) => tables.has(table)) &&
      REQUIRED_FILE_COLUMNS.every((column) => fileColumns.has(column));
    if (!schemaValid) {
      return {
        ...emptyReport(
          databasePath,
          selectedIdentity,
          discovery,
          stamp,
          'The index schema is missing required tables or explicit file-outcome columns. Run `umbra index` to migrate it.',
        ),
        databaseExists: true,
      };
    }

    const files = count(db, 'SELECT COUNT(*) AS total FROM file_registry');
    const indexedFiles = count(db, "SELECT COUNT(*) AS total FROM file_registry WHERE index_state = 'indexed'");
    const skippedFiles = count(db, "SELECT COUNT(*) AS total FROM file_registry WHERE index_state = 'skipped'");
    const chunks = count(db, 'SELECT COUNT(*) AS total FROM code_chunks');
    const vectors = db.prepare(
      `SELECT provider, model, dimensions, COUNT(*) AS vectors
         FROM chunk_vectors GROUP BY provider, model, dimensions ORDER BY provider, model, dimensions`,
    ).all() as VectorIdentityCoverage[];
    const missingWhere = selectedIdentity === undefined
      ? 'NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.chunk_id = c.id)'
      : 'NOT EXISTS (SELECT 1 FROM chunk_vectors v WHERE v.chunk_id = c.id AND v.provider = ? AND v.model = ?)';
    const parameters = selectedIdentity === undefined ? [] : [selectedIdentity.provider, selectedIdentity.model];
    const missingVectors = count(db, `SELECT COUNT(*) AS total FROM code_chunks c WHERE ${missingWhere}`, parameters);
    const missingPaths = paths(
      db,
      `SELECT DISTINCT c.file_path AS path FROM code_chunks c WHERE ${missingWhere} ORDER BY c.file_path LIMIT 20`,
      parameters,
    );
    const chunklessPaths = paths(
      db,
      `SELECT f.path AS path FROM file_registry f
       WHERE f.index_state = 'indexed'
         AND NOT EXISTS (SELECT 1 FROM code_chunks c WHERE c.file_path = f.path)
       ORDER BY f.path LIMIT 20`,
    );
    const rows = db.prepare(
      'SELECT path, hash, index_state AS state FROM file_registry',
    ).all() as Array<{ path: string; hash: string; state: 'indexed' | 'skipped' }>;
    const rowsByPath = new Map(rows.map((row) => [row.path, row]));
    const pendingPaths: string[] = [];
    const stalePaths: string[] = [];
    for (const source of discovery.sourceFiles) {
      const row = rowsByPath.get(source.relativePath);
      if (row === undefined) {
        pushLimited(pendingPaths, source.relativePath);
        continue;
      }
      const hash = hashFile(source.absolutePath);
      if (hash === undefined || row.hash !== hash) pushLimited(stalePaths, source.relativePath);
    }
    const dimensionConflictIdentities = conflictingDimensions(vectors);
    const lease = inspectIndexLease(db);
    const stampConsistent = matchesStamp(stamp, discovery.sourceFiles.length, indexedFiles + skippedFiles);
    const healthy =
      discovery.valid &&
      discovery.sourceFiles.length > 0 &&
      files > 0 &&
      chunks > 0 &&
      missingVectors === 0 &&
      chunklessPaths.length === 0 &&
      pendingPaths.length === 0 &&
      stalePaths.length === 0 &&
      dimensionConflictIdentities.length === 0 &&
      !lease.active &&
      stampConsistent;
    return {
      databasePath,
      databaseExists: true,
      schemaValid: true,
      discoveryValid: discovery.valid,
      discoveredFiles: discovery.sourceFiles.length,
      files,
      indexedFiles,
      skippedFiles,
      chunks,
      vectors,
      missingVectors,
      missingPaths,
      chunklessPaths,
      pendingPaths,
      stalePaths,
      dimensionConflictIdentities,
      lease,
      stamp,
      stampConsistent,
      selectedIdentity,
      healthy,
      diagnostic: discovery.diagnostic,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...emptyReport(databasePath, selectedIdentity, discovery, stamp, `Could not inspect index database: ${message}`),
      databaseExists: true,
    };
  } finally {
    db?.close();
  }
}

/** Renders the stable operator-facing form shared by doctor and MCP resources. */
export function formatIndexIntegrity(report: IndexIntegrityReport): string {
  const lines = [
    `database:       ${report.databasePath}`,
    `schema:         ${report.schemaValid ? 'valid' : 'invalid'}`,
    `discovery:      ${report.discoveryValid ? `${report.discoveredFiles} source files` : 'invalid'}`,
    `files:          ${report.files} (${report.indexedFiles} indexed, ${report.skippedFiles} skipped)`,
    `chunks:         ${report.chunks}`,
    `missing vectors: ${report.missingVectors}`,
    `stamp:          ${report.stampConsistent ? 'consistent' : 'missing, partial, or mismatched'}`,
    `lease:          ${formatLease(report.lease)}`,
    `health:         ${report.healthy ? 'healthy' : 'incomplete'}`,
  ];
  if (report.selectedIdentity !== undefined) lines.push(`selected:       ${report.selectedIdentity.provider}/${report.selectedIdentity.model}`);
  for (const vector of report.vectors) lines.push(`vectors:        ${vector.provider}/${vector.model} · ${vector.vectors} × ${vector.dimensions}d`);
  appendPaths(lines, 'missing paths', report.missingPaths);
  appendPaths(lines, 'chunkless', report.chunklessPaths);
  appendPaths(lines, 'pending paths', report.pendingPaths);
  appendPaths(lines, 'stale paths', report.stalePaths);
  if (report.dimensionConflictIdentities.length > 0) lines.push(`dimension conflicts: ${report.dimensionConflictIdentities.join(', ')}`);
  if (report.diagnostic !== undefined) lines.push(`diagnostic:     ${report.diagnostic}`);
  return lines.join('\n');
}

/** Returns source declarations without allowing a discovery failure to crash a doctor report. */
function discoverSources(rootDir: string): {
  valid: boolean;
  sourceFiles: readonly { absolutePath: string; relativePath: string }[];
  diagnostic?: string;
} {
  try {
    const discovery = new WorkspaceDiscoveryService(rootDir).discover();
    return { valid: true, sourceFiles: discovery.sourceFiles };
  } catch (error: unknown) {
    return {
      valid: false,
      sourceFiles: [],
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Creates an incomplete report without pretending that an absent database is empty-but-valid. */
function emptyReport(
  databasePath: string,
  selectedIdentity: IndexIntegrityReport['selectedIdentity'],
  discovery: ReturnType<typeof discoverSources>,
  stamp: IndexStamp | undefined,
  diagnostic: string,
): IndexIntegrityReport {
  return {
    databasePath,
    databaseExists: false,
    schemaValid: false,
    discoveryValid: discovery.valid,
    discoveredFiles: discovery.sourceFiles.length,
    files: 0,
    indexedFiles: 0,
    skippedFiles: 0,
    chunks: 0,
    vectors: [],
    missingVectors: 0,
    missingPaths: [],
    chunklessPaths: [],
    pendingPaths: [],
    stalePaths: [],
    dimensionConflictIdentities: [],
    lease: { active: false, stale: false },
    stamp,
    stampConsistent: false,
    selectedIdentity,
    healthy: false,
    diagnostic,
  };
}

/** Counts a query whose only returned field is `total`. */
function count(db: Database.Database, sql: string, parameters: readonly string[] = []): number {
  return (db.prepare(sql).get(...parameters) as { total: number }).total;
}

/** Reads at most twenty ordered affected paths. */
function paths(db: Database.Database, sql: string, parameters: readonly string[] = []): string[] {
  return (db.prepare(sql).all(...parameters) as { path: string }[]).map((row) => row.path);
}

/** Adds a path to a bounded diagnostic list. */
function pushLimited(paths: string[], value: string): void {
  if (paths.length < 20) paths.push(value);
}

/** Hashes one source file without allowing an unreadable file to crash doctor. */
function hashFile(filePath: string): string | undefined {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(filePath, 'utf8')).digest('hex');
  } catch {
    return undefined;
  }
}

/** Lists provider/model identities that store inconsistent vector dimensions. */
function conflictingDimensions(vectors: readonly VectorIdentityCoverage[]): string[] {
  const dimensionsByIdentity = new Map<string, Set<number>>();
  for (const vector of vectors) {
    const identity = `${vector.provider}/${vector.model}`;
    const dimensions = dimensionsByIdentity.get(identity) ?? new Set<number>();
    dimensions.add(vector.dimensions);
    dimensionsByIdentity.set(identity, dimensions);
  }
  return [...dimensionsByIdentity.entries()]
    .filter(([, dimensions]) => dimensions.size > 1)
    .map(([identity]) => identity)
    .sort();
}

/** Checks the persisted run marker against the discovered source set. */
function matchesStamp(
  stamp: IndexStamp | undefined,
  discoveredFiles: number,
  coveredFiles: number,
): boolean {
  if (stamp === undefined || stamp.status !== 'complete') return false;
  if (stamp.discoveredFiles !== undefined && stamp.discoveredFiles !== discoveredFiles) return false;
  if (stamp.coveredFiles !== undefined && stamp.coveredFiles !== coveredFiles) return false;
  return true;
}

/** Formats a lease without exposing its random owner id in normal success output. */
function formatLease(lease: IndexLeaseSnapshot): string {
  if (!lease.active) return 'idle';
  const identity = lease.provider !== undefined && lease.model !== undefined
    ? `${lease.provider}/${lease.model}`
    : 'unknown writer';
  return lease.stale ? `stale (${identity})` : `active (${identity})`;
}

/** Appends one bounded path group only when it contains affected source files. */
function appendPaths(lines: string[], label: string, affected: readonly string[]): void {
  if (affected.length > 0) lines.push(`${label}:  ${affected.join(', ')}`);
}
