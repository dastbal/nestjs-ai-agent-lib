#!/usr/bin/env node
/**
 * Builds the committed retrieval fixture that lets CI score ranking and
 * abstention with no provider, no network, and no credentials.
 *
 * ## Why a fixture at all
 *
 * `bench-retrieval` launches the compiled MCP binary, which resolves a live
 * embedding provider at startup. In GitHub Actions that means either an Ollama
 * daemon or Vertex credentials, and neither exists there — so every quality
 * number this project produces is a local, manual observation that nobody is
 * obliged to take. A regression reaches `main` unnoticed and is found, if at
 * all, the next time someone remembers to run the benchmark by hand.
 *
 * ## What is frozen, and what that costs
 *
 * The fixture stores the chunks, their vectors, and **one pre-computed vector
 * per corpus query**. That makes the run fully offline and exactly repeatable,
 * at the price of freezing the query set: a new corpus case needs the fixture
 * rebuilt, which is a deliberate, visible act rather than a silent drift.
 *
 * It measures ranking, rank fusion and the abstention policy. It does **not**
 * measure the embedding model — the vectors are fixed, so a model change is
 * invisible here and belongs in the live paired benchmark.
 *
 * ## Why vectors are a separate binary file
 *
 * 175 vectors of 768 float32 components are ~525 KB. As base64 inside JSON that
 * becomes ~700 KB of unreadable text that git diffs line by line. A `.bin`
 * beside a small readable manifest is honest about being an artifact.
 *
 * Usage:
 *   node scripts/build-retrieval-fixture.mjs [--positives 15] [--distractors 40]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'docs/benchmarks/fixture');

function valueAfter(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const positiveCount = valueAfter('--positives', 15);
const distractorCount = valueAfter('--distractors', 40);

const dbPath = path.join(repoRoot, '.umbra', 'memory.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Fixture blocked: no index at ${dbPath}. Run \`umbra index\` first.`);
  process.exit(2);
}

const { default: Database } = await import('better-sqlite3');

const corpus = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'docs/benchmarks/embedding-retrieval-corpus.json'), 'utf8'),
);

const db = new Database(dbPath, { readonly: true });

const identity = db
  .prepare('SELECT provider, model, dimensions FROM chunk_vectors LIMIT 1')
  .get();
if (identity === undefined) {
  console.error('Fixture blocked: the index holds no vectors.');
  process.exit(2);
}

const normalise = (value) => value.split('\\').join('/');

// Every negative is kept. They are the whole reason the gate exists: the
// abstention policy is what broke, and a subset without them would score the
// half that was never in doubt.
const calibration = corpus.queries.filter((item) => item.split === 'calibration');
const negatives = calibration.filter((item) => item.expectedPaths.length === 0);
const positives = calibration
  .filter((item) => item.expectedPaths.length > 0)
  .slice(0, positiveCount);
const cases = [...positives, ...negatives];

const wanted = new Set();
for (const item of positives) {
  for (const expected of item.expectedPaths) wanted.add(normalise(expected));
}

const allChunks = db
  .prepare('SELECT id, file_path, chunk_type, content, metadata FROM code_chunks ORDER BY id')
  .all();

const isExpected = (chunk) =>
  [...wanted].some((expected) => normalise(chunk.file_path).endsWith(expected));

const kept = allChunks.filter(isExpected);
const keptIds = new Set(kept.map((chunk) => chunk.id));

// Distractors sampled at a fixed stride rather than at random: a fixture that
// changes between builds cannot be the baseline of a regression gate.
const others = allChunks.filter((chunk) => !keptIds.has(chunk.id));
const stride = Math.max(1, Math.floor(others.length / distractorCount));
for (let i = 0; i < others.length && kept.length < keptIds.size + distractorCount; i += stride) {
  kept.push(others[i]);
}

const vectorRow = db.prepare(
  'SELECT vector FROM chunk_vectors WHERE chunk_id = ? AND provider = ? AND model = ?',
);

const vectors = [];
const chunks = [];
for (const chunk of kept) {
  const row = vectorRow.get(chunk.id, identity.provider, identity.model);
  if (row === undefined) continue;
  chunks.push({
    id: chunk.id,
    filePath: normalise(chunk.file_path),
    chunkType: chunk.chunk_type,
    content: chunk.content,
    metadata: chunk.metadata,
    vector: vectors.length,
  });
  vectors.push(Buffer.from(row.vector));
}

console.error(
  `Fixture: ${chunks.length} chunks, ${cases.length} cases ` +
    `(${positives.length} positive, ${negatives.length} negative).`,
);
console.error('Query vectors must be embedded live; run this with the same provider that built the index.');

// The query vectors are the one part that cannot be copied out of the index —
// nothing has ever embedded these strings and stored the result. They are
// produced here, once, and frozen.
// Production embeds the *expanded* query, not the raw one: RetrieverService
// runs it through retrieval memory first. Freezing a vector of the raw string
// would score a string production never sends. Both sides import the same
// function so they cannot drift apart.
const { normalizeRetrievalTerms } = await import(
  `file://${path.join(repoRoot, 'dist/core/rag/retrieval-memory.js').replace(/\\/g, '/')}`
);
const { resolveEmbeddings } = await import(
  `file://${path.join(repoRoot, 'dist/core/rag/embeddings/embeddings-resolver.js').replace(/\\/g, '/')}`
);
const port = resolveEmbeddings().port;
if (port.identity.provider !== identity.provider || port.identity.model !== identity.model) {
  console.error(
    `Fixture blocked: the index holds ${identity.provider}/${identity.model} but the active ` +
      `provider is ${port.identity.provider}/${port.identity.model}. A query vector from one ` +
      'space cannot rank chunks from another (ADR-025).',
  );
  process.exit(2);
}

const queries = [];
for (const item of cases) {
  const vector = await port.embedQuery([...normalizeRetrievalTerms(item.query)].join(' '));
  queries.push({ id: item.id, vector: vectors.length });
  vectors.push(Buffer.from(new Float32Array(vector).buffer));
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'retrieval-fixture.vectors.bin'), Buffer.concat(vectors));
fs.writeFileSync(
  path.join(outDir, 'retrieval-fixture.json'),
  `${JSON.stringify(
    {
      version: 1,
      builtAt: new Date().toISOString(),
      corpusVersion: corpus.version,
      // Recorded, never used to rank: the fixture is its own vector space and
      // must never be compared with a live provider's rows (ADR-025).
      sourceIdentity: { provider: identity.provider, model: identity.model },
      dimensions: identity.dimensions,
      cases,
      chunks,
      queries,
    },
    null,
    2,
  )}\n`,
);

db.close();
console.error(`Wrote ${outDir}`);
