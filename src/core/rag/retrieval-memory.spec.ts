import Database from 'better-sqlite3';
import {
  RetrievalMemoryService,
  ensureRetrievalMemory,
  normalizeRetrievalTerms,
} from './retrieval-memory';

describe('retrieval memory', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureRetrievalMemory(db);

    // `approve` checks context terms against the lexical index, because one the
    // index has never contained poisons every query matching its trigger. The
    // check reads `code_chunks_fts` and nothing else, so a bare FTS table
    // holding this fixture's "repository vocabulary" is the whole dependency —
    // no `code_chunks`, no triggers.
    db.exec(
      `CREATE VIRTUAL TABLE code_chunks_fts USING fts5(
         chunk_id UNINDEXED, file_path, metadata, content, tokenize = 'unicode61'
       )`,
    );
    db.prepare(
      `INSERT INTO code_chunks_fts (chunk_id, file_path, metadata, content)
       VALUES (?, ?, ?, ?)`,
    ).run('chunk-1', 'src/core/rag/retriever.ts', '{}', 'retriever service embeddings');
  });

  afterEach(() => db.close());

  it('drops conversational filler before an alias can be stored', () => {
    expect(normalizeRetrievalTerms('bello, dale buscame files del RAG por favor'))
      .toEqual(['files', 'rag']);
  });

  it('expands a later query only from explicitly approved local evidence', () => {
    const memory = new RetrievalMemoryService(db);

    expect(memory.expand('files RAG')).toBe('files rag');
    expect(memory.approve({
      triggerTerms: ['files', 'RAG'],
      contextTerms: ['retriever service', 'embeddings'],
      verifiedPaths: ['src/core/rag/retriever.ts'],
    })).toBe(true);

    expect(memory.expand('bello files RAG')).toBe('files rag retriever service embeddings');
  });

  it('refuses aliases without verified source paths', () => {
    const memory = new RetrievalMemoryService(db);

    expect(memory.approve({
      triggerTerms: ['rag'],
      contextTerms: ['retriever'],
      verifiedPaths: [],
    })).toBe(false);
  });

  // The trap this closes: `expand` appends context terms to the query the
  // abstention gate probes, and `knownTerms` exempts trigger terms only. An
  // approved alias carrying a term the index has never contained therefore
  // makes every query on its trigger abstain, permanently — and the
  // clarification retry re-expands, so nothing recovers it.
  it('refuses an alias whose context term the index has never contained', () => {
    const memory = new RetrievalMemoryService(db);

    expect(memory.approve({
      triggerTerms: ['rag'],
      contextTerms: ['retriever', 'prometheus'],
      verifiedPaths: ['src/core/rag/retriever.ts'],
    })).toBe(false);
  });

  it('leaves a query unexpanded after refusing, because nothing was stored', () => {
    const memory = new RetrievalMemoryService(db);

    memory.approve({
      triggerTerms: ['rag'],
      contextTerms: ['prometheus'],
      verifiedPaths: ['src/core/rag/retriever.ts'],
    });

    expect(memory.expand('rag files')).toBe('rag files');
  });

  // A context term below the gate's minimum length is never probed by it, so it
  // cannot poison anything and must not be grounds for refusal. Validating with
  // the gate's own function is what makes the two agree by construction.
  it('accepts a short context term the gate would never examine', () => {
    const memory = new RetrievalMemoryService(db);

    expect(memory.approve({
      triggerTerms: ['rag'],
      contextTerms: ['embeddings', 'zzz'],
      verifiedPaths: ['src/core/rag/retriever.ts'],
    })).toBe(true);
  });
});
