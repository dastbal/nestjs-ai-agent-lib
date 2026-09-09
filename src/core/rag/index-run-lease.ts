import * as crypto from 'crypto';
import Database from 'better-sqlite3';

/** The sole durable lease name for a root-owned semantic index. */
const SEMANTIC_INDEX_LEASE = 'semantic-index';

/** A lease heartbeat older than this may be recovered by another process. */
export const INDEX_LEASE_STALE_AFTER_MS = 90_000;

/** One active or stale cross-process index lease observed by `doctor --index`. */
export interface IndexLeaseSnapshot {
  /** Whether an indexer currently owns the lease. */
  readonly active: boolean;
  /** Whether an active lease has stopped heartbeating and may be recovered. */
  readonly stale: boolean;
  /** Owner identity, retained only for diagnostics. */
  readonly ownerId?: string;
  /** Provider currently writing vectors. */
  readonly provider?: string;
  /** Model currently writing vectors. */
  readonly model?: string;
  /** Last owner heartbeat as an epoch timestamp. */
  readonly heartbeatAt?: number;
}

/** Options used to acquire the one writer lease. */
export interface AcquireIndexLeaseOptions {
  /** Embedding provider that will write into `chunk_vectors`. */
  readonly provider: string;
  /** Embedding model that will write into `chunk_vectors`. */
  readonly model: string;
  /** Injectable owner for deterministic tests. */
  readonly ownerId?: string;
  /** Injectable clock for deterministic tests. */
  readonly now?: number;
  /** Injectable staleness threshold for deterministic tests. */
  readonly staleAfterMs?: number;
}

/**
 * Creates the SQLite table that serializes semantic-index writers.
 *
 * @param db - Workspace database that owns the lease.
 * @returns Nothing.
 */
export function ensureIndexLeaseSchema(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS index_lease (
      lease_name   TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL,
      provider     TEXT NOT NULL,
      model        TEXT NOT NULL,
      acquired_at  INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    )
  `).run();
}

/**
 * Cross-process ownership of one root's semantic-index write path.
 *
 * SQLite atomically accepts the first caller and only allows a later caller to
 * replace a lease whose heartbeat is stale. A second live client must wait for
 * the first one instead of embedding the same files into the same database.
 */
export class IndexRunLease {
  private readonly db: Database.Database;
  private readonly ownerId: string;

  private constructor(db: Database.Database, ownerId: string) {
    this.db = db;
    this.ownerId = ownerId;
  }

  /**
   * Acquires the durable writer lease when none is live.
   *
   * @param db - Workspace database whose lease table was initialized.
   * @param options - Identity and deterministic test controls.
   * @returns The owned lease, or `undefined` when another live process owns it.
   */
  public static acquire(
    db: Database.Database,
    options: AcquireIndexLeaseOptions,
  ): IndexRunLease | undefined {
    ensureIndexLeaseSchema(db);
    const now = options.now ?? Date.now();
    const ownerId = options.ownerId ?? crypto.randomUUID();
    const staleBefore = now - (options.staleAfterMs ?? INDEX_LEASE_STALE_AFTER_MS);
    const result = db.prepare(`
      INSERT INTO index_lease (lease_name, owner_id, provider, model, acquired_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(lease_name) DO UPDATE SET
        owner_id = excluded.owner_id,
        provider = excluded.provider,
        model = excluded.model,
        acquired_at = excluded.acquired_at,
        heartbeat_at = excluded.heartbeat_at
      WHERE index_lease.heartbeat_at <= ?
    `).run(
      SEMANTIC_INDEX_LEASE,
      ownerId,
      options.provider,
      options.model,
      now,
      now,
      staleBefore,
    );

    return result.changes === 1 ? new IndexRunLease(db, ownerId) : undefined;
  }

  /** Refreshes the lease only while this process still owns it. */
  public heartbeat(now = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE index_lease SET heartbeat_at = ?
      WHERE lease_name = ? AND owner_id = ?
    `).run(now, SEMANTIC_INDEX_LEASE, this.ownerId);
    return result.changes === 1;
  }

  /** Releases only this owner's lease, never another process's replacement. */
  public release(): void {
    this.db.prepare(`
      DELETE FROM index_lease WHERE lease_name = ? AND owner_id = ?
    `).run(SEMANTIC_INDEX_LEASE, this.ownerId);
  }
}

/**
 * Reads the current lease without changing it.
 *
 * @param db - Workspace database to inspect.
 * @param now - Injectable clock for deterministic tests.
 * @returns A status suitable for MCP and `doctor --index`.
 */
export function inspectIndexLease(db: Database.Database, now = Date.now()): IndexLeaseSnapshot {
  const exists = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'index_lease'",
  ).get() as { present: number } | undefined;
  if (exists === undefined) return { active: false, stale: false };
  const row = db.prepare(`
    SELECT owner_id AS ownerId, provider, model, heartbeat_at AS heartbeatAt
    FROM index_lease WHERE lease_name = ?
  `).get(SEMANTIC_INDEX_LEASE) as {
    ownerId: string;
    provider: string;
    model: string;
    heartbeatAt: number;
  } | undefined;
  if (row === undefined) return { active: false, stale: false };
  return {
    active: true,
    stale: now - row.heartbeatAt > INDEX_LEASE_STALE_AFTER_MS,
    ownerId: row.ownerId,
    provider: row.provider,
    model: row.model,
    heartbeatAt: row.heartbeatAt,
  };
}
