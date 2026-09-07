import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { inspectIndexIntegrity } from './index-integrity';
import { writeIndexStamp } from './index-stamp';

describe('inspectIndexIntegrity', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-index-integrity-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.writeFileSync(path.join(rootDir, 'package.json'), '{"name":"fixture"}', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'tsconfig.json'), '{"include":["src/**/*.ts"]}', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');

    const stateDir = path.join(rootDir, '.umbra');
    fs.mkdirSync(stateDir);
    const db = new Database(path.join(stateDir, 'memory.db'));
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE file_registry (
        path TEXT PRIMARY KEY, hash TEXT NOT NULL, last_indexed INTEGER NOT NULL,
        skeleton_signature TEXT, index_state TEXT NOT NULL DEFAULT 'indexed', skip_reason TEXT
      );
      CREATE TABLE code_chunks (
        id TEXT PRIMARY KEY, file_path TEXT NOT NULL, chunk_type TEXT NOT NULL,
        content TEXT NOT NULL, metadata TEXT,
        FOREIGN KEY(file_path) REFERENCES file_registry(path)
      );
      CREATE TABLE chunk_vectors (
        chunk_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        dimensions INTEGER NOT NULL, vector BLOB NOT NULL,
        PRIMARY KEY(chunk_id, provider, model),
        FOREIGN KEY(chunk_id) REFERENCES code_chunks(id)
      );
      CREATE TABLE index_lease (
        lease_name TEXT PRIMARY KEY, owner_id TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL
      );
    `);
    db.prepare(`INSERT INTO file_registry VALUES (?, ?, 1, NULL, 'indexed', NULL)`).run(
      'src/a.ts', hashFile(path.join(rootDir, 'src', 'a.ts')),
    );
    db.prepare(`INSERT INTO file_registry VALUES (?, ?, 1, NULL, 'indexed', NULL)`).run(
      'src/b.ts', hashFile(path.join(rootDir, 'src', 'b.ts')),
    );
    db.exec(`
      INSERT INTO code_chunks VALUES ('a', 'src/a.ts', 'file', 'a', '{}'), ('b', 'src/b.ts', 'file', 'b', '{}');
      INSERT INTO chunk_vectors VALUES ('a', 'ollama', 'nomic-embed-text', 3, X'000000000000000000000000');
    `);
    db.close();
    writeIndexStamp(rootDir, {
      provider: 'ollama', model: 'nomic-embed-text', dimensions: 3, column: 'vector_ollama_json',
    }, { filesIndexed: 2, discoveredFiles: 2, coveredFiles: 2, status: 'complete' });
  });

  afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  it('reports registered files separately from missing vectors for the selected identity', () => {
    const report = inspectIndexIntegrity(rootDir, { provider: 'ollama', model: 'nomic-embed-text' });

    expect(report.schemaValid).toBe(true);
    expect(report.discoveryValid).toBe(true);
    expect(report.files).toBe(2);
    expect(report.chunks).toBe(2);
    expect(report.missingVectors).toBe(1);
    expect(report.missingPaths).toEqual(['src/b.ts']);
    expect(report.stampConsistent).toBe(true);
    expect(report.healthy).toBe(false);
  });

  it('detects a fresh registry row that has no chunks', () => {
    const db = new Database(path.join(rootDir, '.umbra', 'memory.db'));
    db.prepare(`DELETE FROM code_chunks WHERE id = 'b'`).run();
    db.close();

    const report = inspectIndexIntegrity(rootDir, { provider: 'ollama', model: 'nomic-embed-text' });

    expect(report.chunklessPaths).toEqual(['src/b.ts']);
    expect(report.healthy).toBe(false);
  });

  it('detects a changed source that the stamp still claims to cover', () => {
    fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), 'export const a = 99;\n', 'utf8');

    const report = inspectIndexIntegrity(rootDir, { provider: 'ollama', model: 'nomic-embed-text' });

    expect(report.stalePaths).toEqual(['src/a.ts']);
    expect(report.healthy).toBe(false);
  });

  it('reports an absent workspace database as an invalid index instead of an empty valid one', () => {
    fs.rmSync(path.join(rootDir, '.umbra', 'memory.db'));
    const report = inspectIndexIntegrity(rootDir, { provider: 'ollama', model: 'nomic-embed-text' });

    expect(report.databaseExists).toBe(false);
    expect(report.healthy).toBe(false);
    expect(report.diagnostic).toMatch(/No .umbra\/memory.db/);
  });
});

/** Hashes fixture content the same way the file registry does. */
function hashFile(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath, 'utf8')).digest('hex');
}
