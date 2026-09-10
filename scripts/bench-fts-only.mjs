#!/usr/bin/env node
/**
 * The control arm: what does retrieval score with the vectors switched off?
 *
 * `bench-retrieval.mjs` measures the shipped hybrid retriever. This measures
 * the same corpus with the semantic branch removed, which is the only way to
 * know what the embedding apparatus actually buys. That apparatus is not free:
 * the launch probe, the index stamp, the writer lease, the per-identity vector
 * rows and the reindex-on-model-change all exist to keep vectors consistent.
 * A number that says they buy two points is a different roadmap from one that
 * says they buy twenty.
 *
 * It runs in-process against `.umbra/memory.db`, loading the **same compiled
 * modules** the server loads, so the ranking rule cannot drift from the shipped
 * one. It deliberately does **not** launch the MCP binary: there is no server
 * flag for "no vectors", and adding one so a benchmark could ask for it would
 * widen the tool surface for a test's convenience (ADR-024). The consequence is
 * that its latency excludes the transport, the readiness gate and the query
 * embedding, and is therefore **not comparable** to `p95LatencyMs` in a
 * `bench-retrieval` report. Compare the hit rates; read the latency only
 * against the other arm here.
 *
 * ## Two arms, because removing the vectors changes two things at once
 *
 * `policy`  - `hasGroundedEvidence` as it ships. With no semantic ranking,
 *             `evidence: 'hybrid'` is unreachable, so grounding can only come
 *             from `lexicalExact`. Abstention gets stricter by omission rather
 *             than by decision.
 * `ranking` - the same candidates with the grounding gate lifted, which
 *             isolates ranking quality from that policy side effect.
 *
 * Reporting only the first would credit the vectors for a policy artefact.
 *
 * Usage:
 *   node scripts/bench-fts-only.mjs
 *   node scripts/bench-fts-only.mjs --root ../other-repo --output report.json
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WINDOWS_SEPARATOR = String.fromCharCode(92);
const CANDIDATE_LIMIT = 12;
const RESULT_LIMIT = 4;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/bench-fts-only.mjs [--root <dir>] [--corpus <file>] ' +
      '[--split calibration|holdout|all] [--allow-holdout] [--output <file>]',
  );
  process.exit(0);
}

const root = path.resolve(valueAfter(args, '--root') ?? repoRoot);
const split = valueAfter(args, '--split') ?? 'calibration';
if (!['calibration', 'holdout', 'all'].includes(split)) {
  console.error('Benchmark blocked: unknown split ' + split + '.');
  process.exit(2);
}
if ((split === 'holdout' || split === 'all') && !args.includes('--allow-holdout')) {
  console.error(
    'Benchmark blocked: split ' + split + ' reads the holdout. Pass --allow-holdout only when ' +
      'this run is the pre-release read, and record the result.',
  );
  process.exit(2);
}

const corpusPath = path.resolve(
  valueAfter(args, '--corpus') ??
    path.join(repoRoot, 'docs/benchmarks/embedding-retrieval-corpus.json'),
);
const databasePath = path.join(root, '.umbra', 'memory.db');

for (const [label, target] of [
  ['corpus file', corpusPath],
  ['index database', databasePath],
  ['compiled retrieval metrics', path.join(repoRoot, 'dist/core/rag/retrieval-metrics.js')],
]) {
  if (!fs.existsSync(target)) {
    console.error(
      'Benchmark blocked: ' + label + ' does not exist: ' + target + '. Run `npm run build` first.',
    );
    process.exit(2);
  }
}

const compiled = (relative) => import(pathToFileURL(path.join(repoRoot, 'dist', relative)).href);
const { findLexicalCandidates, hasExactLexicalEvidence } = await compiled(
  'core/rag/lexical-index.js',
);
const { findUnknownTerms } = await compiled('core/rag/unknown-terms.js');
const { fuseRankings, hasGroundedEvidence } = await compiled('core/rag/hybrid-ranking.js');
const { scoreCase, summarizeRun, assessCorpusCoverage } = await compiled(
  'core/rag/retrieval-metrics.js',
);
const { normalizeRetrievalTerms } = await compiled('core/rag/retrieval-memory.js');
const { default: Database } = await import('better-sqlite3');

const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const cases = corpus.queries.filter((item) => split === 'all' || item.split === split);
if (cases.length === 0) {
  console.error('Benchmark blocked: corpus has no cases in split ' + split + '.');
  process.exit(2);
}

const db = new Database(databasePath, { readonly: true });

// Approved aliases are operator state, not repository state. A run that
// inherited them would report a number nobody else can reproduce, so this
// refuses rather than silently measuring one machine's vocabulary.
const aliasCount = db.prepare('SELECT COUNT(*) AS total FROM retrieval_aliases').get().total;
if (aliasCount > 0) {
  console.error(
    'Benchmark blocked: ' + aliasCount + ' approved retrieval alias(es) are stored for this ' +
      'root. They expand every query, so the result would not be reproducible elsewhere.',
  );
  db.close();
  process.exit(2);
}

/** Reproduces `RetrievalMemoryService#expand` for an empty alias store. */
const expand = (query) => {
  const terms = [...normalizeRetrievalTerms(query)];
  return terms.length === 0 ? query : terms.join(' ');
};

const toPosix = (value) => value.split(WINDOWS_SEPARATOR).join('/');

const indexedPaths = db
  .prepare('SELECT DISTINCT file_path FROM code_chunks')
  .all()
  .map((row) => toPosix(row.file_path));
const coverage = assessCorpusCoverage(cases, indexedPaths);

// Recorded because the coverage preflight cannot stand in for it. Adding one
// source file that is not an expected path leaves `reachableHitCeiling` at 1.0
// and still moves the result: BM25 is corpus-relative, so a new document shifts
// IDF and every candidate rank behind it. Measured on this repository, going
// from 169 to 170 indexed files moved this arm's `policy` hit rate 0.667 to
// 0.644 and flipped one case out of grounded. Two reports are comparable only
// when these two numbers match.
const indexSize = {
  files: indexedPaths.length,
  chunks: db.prepare('SELECT COUNT(*) AS total FROM code_chunks').get().total,
};

const outcomes = { policy: [], ranking: [] };
const trace = [];

for (const corpusCase of cases) {
  const retrievalQuery = expand(corpusCase.query);
  const started = process.hrtime.bigint();

  const paths = [];
  let reason = 'answered';

  const unknown = findUnknownTerms(db, retrievalQuery, new Set());
  if (unknown.length > 0) {
    reason = 'unknown-term:' + unknown.join(',');
  } else {
    const lexical = findLexicalCandidates(db, retrievalQuery, CANDIDATE_LIMIT);
    const rows =
      lexical.length === 0
        ? []
        : db
            .prepare(
              'SELECT id, file_path, metadata FROM code_chunks WHERE id IN (' +
                lexical.map(() => '?').join(', ') +
                ')',
            )
            .all(...lexical.map((candidate) => candidate.chunkId));
    const byId = new Map(rows.map((row) => [row.id, row]));

    const fused = fuseRankings(
      [],
      lexical.map((candidate) => {
        const row = byId.get(candidate.chunkId);
        // `RetrieverService` compares against the re-serialized metadata object
        // rather than the stored string. Parse and restringify so the term set
        // this sees is the term set the server sees.
        let metadata = row?.metadata ?? '';
        try {
          metadata = JSON.stringify(JSON.parse(metadata));
        } catch {
          /* not JSON in this row; compare the raw column */
        }
        return {
          id: candidate.chunkId,
          lexicalExact:
            row !== undefined &&
            hasExactLexicalEvidence(retrievalQuery, row.file_path ?? '', metadata),
        };
      }),
      RESULT_LIMIT,
    );

    for (const candidate of fused) {
      const stored = byId.get(candidate.id)?.file_path;
      const filePath = stored === undefined ? undefined : toPosix(stored);
      if (filePath !== undefined && !paths.includes(filePath)) paths.push(filePath);
    }

    if (fused.length === 0) reason = 'no-lexical-candidates';
    else if (!hasGroundedEvidence(fused)) reason = 'ungrounded';
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  outcomes.policy.push(scoreCase(corpusCase, reason === 'answered' ? paths : [], elapsedMs));
  outcomes.ranking.push(scoreCase(corpusCase, paths, elapsedMs));
  trace.push({
    id: corpusCase.id,
    reason,
    expectedPaths: corpusCase.expectedPaths,
    returnedPaths: paths,
  });
}

db.close();

/**
 * Records which code state produced these numbers.
 *
 * The same reasoning as `bench-retrieval.mjs`: a number whose commit cannot be
 * recovered is an anecdote with a schema, and a dirty tree is recorded rather
 * than refused so a mid-change run is still usable — just never mistakable for
 * a run of the commit it sits on.
 *
 * @returns Short SHA and whether the tree had uncommitted changes.
 */
function codeVersion() {
  const run = (command) =>
    childProcess
      .execSync(command, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim();

  try {
    return {
      commit: run('git rev-parse --short HEAD'),
      dirty: run('git status --porcelain').length > 0,
    };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

const code = codeVersion();
const report = {
  arm: 'fts-only',
  corpusVersion: corpus.version ?? null,
  split,
  ranAt: new Date().toISOString(),
  commit: code.commit,
  dirtyWorkingTree: code.dirty,
  root,
  latencyExcludes: ['mcp transport', 'readiness gate', 'query embedding'],
  indexSize,
  coverage,
  summaries: { policy: summarizeRun(outcomes.policy), ranking: summarizeRun(outcomes.ranking) },
  trace,
};

// Same naming rule as the hybrid runner, with `fts-only` in the providers slot,
// so the two arms of one comparison sort next to each other.
const stamp = code.commit + (code.dirty ? '-dirty' : '');
const defaultOutput = path.join(
  repoRoot,
  'docs/benchmarks/results',
  new Date().toISOString().slice(0, 10) + '-fts-only-' + split + '-' + stamp + '.json',
);
const outputPath = path.resolve(valueAfter(args, '--output') ?? defaultOutput);
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

console.log('fts-only - ' + cases.length + ' cases, split ' + split);
console.log(
  'index covers ' + coverage.coveredPaths + '/' + coverage.expectedPaths + ' expected paths - ' +
    'reachable hit ceiling ' + (coverage.reachableHitCeiling * 100).toFixed(0) + '%',
);
console.log('index size ' + indexSize.files + ' files, ' + indexSize.chunks + ' chunks');
for (const [arm, summary] of Object.entries(report.summaries)) {
  const row = summary.find((entry) => entry.split === split) ?? summary[0];
  const correct = row.correctAbstentionRate;
  console.log(
    arm.padEnd(8) +
      ' hit ' + row.hitRate.toFixed(3) +
      '  mrr ' + row.mrr.toFixed(3) +
      '  false abstention ' + row.falseAbstentionRate.toFixed(3) +
      '  correct abstention ' + (correct === null ? 'null' : correct.toFixed(3)) +
      '  p50 ' + row.medianLatencyMs.toFixed(2) + ' ms' +
      '  p95 ' + row.p95LatencyMs.toFixed(2) + ' ms',
  );
}
console.log('Report written to ' + outputPath);
