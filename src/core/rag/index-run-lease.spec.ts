import Database from 'better-sqlite3';

import {
  ensureIndexLeaseSchema,
  IndexRunLease,
  inspectIndexLease,
} from './index-run-lease';

describe('IndexRunLease', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureIndexLeaseSchema(db);
  });

  afterEach(() => db.close());

  it('allows exactly one live writer and lets it heartbeat', () => {
    const first = IndexRunLease.acquire(db, {
      provider: 'ollama', model: 'nomic-embed-text', ownerId: 'first', now: 100,
    });
    const second = IndexRunLease.acquire(db, {
      provider: 'ollama', model: 'nomic-embed-text', ownerId: 'second', now: 101,
    });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(first?.heartbeat(120)).toBe(true);
    expect(inspectIndexLease(db, 121)).toMatchObject({ active: true, stale: false, ownerId: 'first' });
  });

  it('recovers only a stale lease and leaves a fresh one untouched', () => {
    IndexRunLease.acquire(db, {
      provider: 'ollama', model: 'nomic-embed-text', ownerId: 'first', now: 0,
    });

    const recovered = IndexRunLease.acquire(db, {
      provider: 'vertex', model: 'text-embedding-004', ownerId: 'second', now: 90_001,
    });

    expect(recovered).toBeDefined();
    expect(inspectIndexLease(db, 90_001)).toMatchObject({
      active: true, stale: false, ownerId: 'second', provider: 'vertex',
    });
  });

  it('cannot release a lease that was recovered by a different process', () => {
    const first = IndexRunLease.acquire(db, {
      provider: 'ollama', model: 'nomic-embed-text', ownerId: 'first', now: 0,
    });
    const second = IndexRunLease.acquire(db, {
      provider: 'vertex', model: 'text-embedding-004', ownerId: 'second', now: 90_001,
    });

    first?.release();

    expect(second).toBeDefined();
    expect(inspectIndexLease(db, 90_002)).toMatchObject({ active: true, ownerId: 'second' });
  });
});
