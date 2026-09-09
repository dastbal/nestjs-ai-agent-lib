/**
 * @module NestGraphStore
 *
 * Persists what {@link analyzeNestGraph} extracted, and answers the questions
 * a NestJS developer asks about wiring.
 *
 * ## Why two tables rather than rows in `dependency_graph`
 *
 * `dependency_graph` is keyed `(source, target)` over **file paths**. Nest
 * wiring is not file-to-file: one file declares a module that binds a token,
 * and the token is often a string constant that belongs to no file. Forcing it
 * into the existing table would mean inventing a fake path for every string
 * token, and would make a query for "who provides `AI_AGENT`" indistinguishable
 * from "which file imports `AI_AGENT`" — two different questions with two
 * different answers.
 *
 * ## Why the file path is part of both keys
 *
 * It is what makes a re-index correct. A file that stops declaring a provider
 * must lose that row, and the cheapest way to guarantee that is to delete this
 * file's rows before writing its new ones, inside the same transaction that
 * writes its chunks. The foreign key onto `file_registry` then removes them
 * again when the file itself disappears — the same cascade ADR-028 relied on to
 * stop stale lexical text outliving its chunks.
 */

import type Database from 'better-sqlite3';
import type { NestGraph } from '../tools/ast/nest-graph';

/** A module that binds a token, as stored. */
export interface StoredBinding {
  readonly filePath: string;
  readonly module: string;
  readonly kind: string;
  readonly token: string;
  readonly useKind?: string;
  readonly dynamic: boolean;
}

/** A class that asks for a token, as stored. */
export interface StoredInjection {
  readonly filePath: string;
  readonly consumer: string;
  readonly token: string;
  readonly explicit: boolean;
}

/**
 * Creates the Nest wiring tables.
 *
 * Safe to call on every connection; the statements are `IF NOT EXISTS`.
 *
 * @param db - The connection that owns `file_registry`.
 * @returns Nothing.
 */
export function ensureNestGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nest_bindings (
      file_path TEXT NOT NULL,
      module    TEXT NOT NULL,
      kind      TEXT NOT NULL,
      token     TEXT NOT NULL,
      use_kind  TEXT,
      dynamic   INTEGER NOT NULL,
      PRIMARY KEY (file_path, module, kind, token, dynamic),
      FOREIGN KEY (file_path) REFERENCES file_registry(path) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nest_injections (
      file_path TEXT NOT NULL,
      consumer  TEXT NOT NULL,
      token     TEXT NOT NULL,
      explicit  INTEGER NOT NULL,
      PRIMARY KEY (file_path, consumer, token),
      FOREIGN KEY (file_path) REFERENCES file_registry(path) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nest_scan (
      file_path TEXT PRIMARY KEY,
      hash      TEXT NOT NULL,
      FOREIGN KEY (file_path) REFERENCES file_registry(path) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_nest_bindings_token ON nest_bindings(token);
    CREATE INDEX IF NOT EXISTS idx_nest_bindings_module ON nest_bindings(module);
    CREATE INDEX IF NOT EXISTS idx_nest_injections_token ON nest_injections(token);
  `);
}

/**
 * Analyzes every registered file whose wiring has not been read at its current
 * content.
 *
 * ## Why a backfill is not optional
 *
 * This graph is derived data, like the FTS index ADR-028 added — and ADR-028
 * backfilled that from existing chunks for exactly this reason. Without a
 * backfill the feature would ship dead: `FileRegistry#isFileChanged` compares
 * content hashes, so an already-indexed repository re-runs the indexer and
 * processes nothing, and the Nest tables stay empty forever while
 * `query_dependency_graph` confidently answers "no modules". That is the same
 * shape of defect found in this repository's own index earlier the same day —
 * a file recorded as indexed, with nothing derived from it, and no path back.
 *
 * Reading is cheap: parsing costs no embedding call and no network. A file that
 * declares nothing still records its hash, so it is read once rather than on
 * every run.
 *
 * @param db - The connection.
 * @param files - Registered files with their absolute path on disk.
 * @param analyze - Extractor, injected so this module needs no AST import.
 * @param readFile - Reads a file; injected for testing.
 * @returns How many files were analyzed by this call.
 */
export function backfillNestGraph(
  db: Database.Database,
  files: readonly { readonly relativePath: string; readonly absolutePath: string }[],
  analyze: (filePath: string, source: string) => NestGraph,
  readFile: (absolutePath: string) => string,
): number {
  // The registry's own hash is reused rather than recomputed. It is already an
  // MD5 of the exact content the file was indexed at, so a scan recorded
  // against it is stale in precisely the cases the indexer also considers
  // stale — one definition of "changed", not two that can disagree.
  const stale = db.prepare(`
    SELECT r.path AS path, r.hash AS hash
      FROM file_registry r
      LEFT JOIN nest_scan s ON s.file_path = r.path
     WHERE s.hash IS NULL OR s.hash <> r.hash
  `).all() as { path: string; hash: string }[];

  if (stale.length === 0) return 0;

  const pending = new Map(stale.map((row) => [row.path, row.hash]));
  let analyzed = 0;
  for (const file of files) {
    const hash = pending.get(file.relativePath);
    if (hash === undefined) continue;

    let source: string;
    try {
      source = readFile(file.absolutePath);
    } catch {
      // A file that vanished between discovery and this pass is not an error
      // worth failing an index run over; the next run will not find it either.
      continue;
    }

    db.transaction(() => {
      replaceNestGraphForFile(db, file.relativePath, analyze(file.relativePath, source), hash);
    })();
    analyzed += 1;
  }

  return analyzed;
}

/**
 * Replaces one file's Nest wiring.
 *
 * Deletes before inserting, so a file that stopped declaring a provider stops
 * reporting one. Called inside the caller's transaction: a graph committed
 * separately from the chunks it belongs to can be half-applied, and a wiring
 * row that outlives its file is exactly the kind of stale confidence ADR-017
 * was written about.
 *
 * @param db - The connection.
 * @param filePath - Repository-relative path being re-indexed.
 * @param graph - What the file declares now.
 * @param hash - Content hash to record against the scan, when the caller has one.
 * @returns Nothing.
 */
export function replaceNestGraphForFile(
  db: Database.Database,
  filePath: string,
  graph: NestGraph,
  hash?: string,
): void {
  db.prepare('DELETE FROM nest_bindings WHERE file_path = ?').run(filePath);
  db.prepare('DELETE FROM nest_injections WHERE file_path = ?').run(filePath);

  // Recorded even when the file declares nothing, so a file with no NestJS
  // constructs is read once rather than on every backfill.
  if (hash !== undefined) {
    db.prepare('INSERT OR REPLACE INTO nest_scan (file_path, hash) VALUES (?, ?)').run(filePath, hash);
  }

  if (graph.bindings.length === 0 && graph.injections.length === 0) return;

  const insertBinding = db.prepare(`
    INSERT OR REPLACE INTO nest_bindings (file_path, module, kind, token, use_kind, dynamic)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const binding of graph.bindings) {
    insertBinding.run(
      filePath,
      binding.module,
      binding.kind,
      binding.token,
      binding.useKind ?? null,
      binding.dynamic ? 1 : 0,
    );
  }

  const insertInjection = db.prepare(`
    INSERT OR REPLACE INTO nest_injections (file_path, consumer, token, explicit)
    VALUES (?, ?, ?, ?)
  `);
  for (const injection of graph.injections) {
    insertInjection.run(filePath, injection.consumer, injection.token, injection.explicit ? 1 : 0);
  }
}

/** Maps a stored row back to its typed form. */
function toBinding(row: Record<string, unknown>): StoredBinding {
  return {
    filePath: String(row.file_path),
    module: String(row.module),
    kind: String(row.kind),
    token: String(row.token),
    useKind: row.use_kind === null || row.use_kind === undefined ? undefined : String(row.use_kind),
    dynamic: row.dynamic === 1,
  };
}

/** Maps a stored row back to its typed form. */
function toInjection(row: Record<string, unknown>): StoredInjection {
  return {
    filePath: String(row.file_path),
    consumer: String(row.consumer),
    token: String(row.token),
    explicit: row.explicit === 1,
  };
}

/**
 * Normalises a token for lookup.
 *
 * A token is stored exactly as written, which means `'AI_AGENT'` with quotes
 * when the source wrote a string literal and `AI_AGENT` when it wrote a
 * constant. A caller asking about `AI_AGENT` means both, and should not have to
 * know which spelling the file used.
 *
 * @param token - The token as the caller typed it.
 * @returns The token without surrounding quotes.
 */
export function normalizeToken(token: string): string {
  return token.trim().replace(/^['"`]|['"`]$/g, '');
}

/**
 * Finds every module that binds a token, in any position.
 *
 * @param db - The connection.
 * @param token - Token to look up; quoting is ignored.
 * @returns Matching bindings.
 */
export function findBindingsForToken(
  db: Database.Database,
  token: string,
): readonly StoredBinding[] {
  const bare = normalizeToken(token);
  const rows = db
    .prepare(
      `SELECT * FROM nest_bindings
        WHERE token = ? OR token = '''' || ? || ''''
           OR REPLACE(REPLACE(token, '''', ''), '"', '') = ?
        ORDER BY module, kind, token`,
    )
    .all(bare, bare, bare) as Record<string, unknown>[];
  return rows.map(toBinding);
}

/**
 * Finds everything one module binds.
 *
 * @param db - The connection.
 * @param module - Module class name.
 * @returns Its bindings, grouped by kind through the ORDER BY.
 */
export function findBindingsForModule(
  db: Database.Database,
  module: string,
): readonly StoredBinding[] {
  const rows = db
    .prepare('SELECT * FROM nest_bindings WHERE module = ? ORDER BY kind, token')
    .all(module) as Record<string, unknown>[];
  return rows.map(toBinding);
}

/**
 * Finds every class that asks for a token.
 *
 * This is the "what breaks if I remove this" query: a token that no module
 * exports but several classes inject is a runtime failure waiting for the
 * module tree to change.
 *
 * @param db - The connection.
 * @param token - Token to look up; quoting is ignored.
 * @returns Matching injections.
 */
export function findInjectionsForToken(
  db: Database.Database,
  token: string,
): readonly StoredInjection[] {
  const bare = normalizeToken(token);
  const rows = db
    .prepare(
      `SELECT * FROM nest_injections
        WHERE REPLACE(REPLACE(token, '''', ''), '"', '') = ?
        ORDER BY consumer`,
    )
    .all(bare) as Record<string, unknown>[];
  return rows.map(toInjection);
}

/**
 * Finds tokens that are injected somewhere but exported by no module.
 *
 * Reported as a *suspicion*, never a verdict. Nest resolves a provider without
 * an export when the injector is in the same module, and a token can be
 * supplied by a `useFactory` in a module this pass never linked. The value is
 * in narrowing a search, so a caller that presents this as a defect list would
 * be overstating it.
 *
 * @param db - The connection.
 * @returns Tokens injected with no matching export or provider binding.
 */
export function findUnexportedInjections(db: Database.Database): readonly StoredInjection[] {
  const rows = db
    .prepare(
      `SELECT i.* FROM nest_injections i
        WHERE NOT EXISTS (
          SELECT 1 FROM nest_bindings b
           WHERE b.kind IN ('provider', 'export')
             AND REPLACE(REPLACE(b.token, '''', ''), '"', '')
               = REPLACE(REPLACE(i.token, '''', ''), '"', '')
        )
        ORDER BY i.consumer, i.token`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(toInjection);
}
