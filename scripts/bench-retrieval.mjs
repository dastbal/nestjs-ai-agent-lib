#!/usr/bin/env node
/**
 * Retrieval-quality benchmark for Umbra's hybrid RAG.
 *
 * Runs every corpus case through the **compiled MCP binary**, exactly as a
 * client would, and writes a versioned report. The binary is the integration
 * boundary on purpose: an in-process mock cannot prove launch pinning, the
 * published tool schema, and the abstention contract together (ADR-028).
 *
 * Scoring is not implemented here. It lives in `src/core/rag/retrieval-metrics.ts`
 * so the rule is type-checked and covered by the jest suite — a metric that
 * drifts silently turns every later number into a false report of progress.
 *
 * Usage:
 *   node scripts/bench-retrieval.mjs --providers ollama
 *   node scripts/bench-retrieval.mjs --providers ollama,vertex --split holdout --allow-holdout
 *
 * Flags:
 *   --providers <list>  Required. `ollama`, `vertex`, or both, comma separated.
 *   --split <name>      `calibration` (default), `holdout`, or `all`.
 *   --allow-holdout     Required to read the holdout. See the note below.
 *   --root <dir>        Repository to benchmark. Defaults to this repository.
 *   --corpus <file>     Corpus file. Defaults to the versioned corpus.
 *   --output <file>     Report path. Defaults under `docs/benchmarks/results/`.
 *   --index             Let the server index on launch. Off by default: a run
 *                       that reindexes is measuring a different index.
 *
 * ## Why the holdout needs a flag
 * A holdout only means anything while it stays unread. Fifteen cases seen once
 * a week are calibration cases with extra steps. The flag is not security, it
 * is friction placed exactly where the mistake is easy and invisible.
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function usage() {
  console.log(
    'Usage: node scripts/bench-retrieval.mjs --providers ollama[,vertex] ' +
      '[--split calibration|holdout|all] [--allow-holdout] [--root <dir>] ' +
      '[--corpus <file>] [--output <file>] [--index]',
  );
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  usage();
  process.exit(0);
}

const providersArg = valueAfter(args, '--providers');
if (!providersArg) {
  usage();
  process.exit(2);
}

const providers = providersArg
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
if (providers.some((provider) => provider !== 'vertex' && provider !== 'ollama')) {
  console.error('Benchmark blocked: providers must be `ollama` and/or `vertex`.');
  process.exit(2);
}

const split = valueAfter(args, '--split') ?? 'calibration';
if (!['calibration', 'holdout', 'all'].includes(split)) {
  console.error(`Benchmark blocked: unknown split \`${split}\`.`);
  process.exit(2);
}
if ((split === 'holdout' || split === 'all') && !args.includes('--allow-holdout')) {
  console.error(
    `Benchmark blocked: split \`${split}\` reads the holdout. Pass --allow-holdout ` +
      'only when this run is the pre-release read, and record the result.',
  );
  process.exit(2);
}

const root = path.resolve(valueAfter(args, '--root') ?? repoRoot);
const corpusPath = path.resolve(
  valueAfter(args, '--corpus') ?? path.join(repoRoot, 'docs/benchmarks/embedding-retrieval-corpus.json'),
);
const cliPath = path.join(root, 'dist', 'bin', 'cli.js');
const metricsPath = path.join(repoRoot, 'dist', 'core', 'rag', 'retrieval-metrics.js');

for (const [label, target] of [
  ['corpus file', corpusPath],
  ['compiled Umbra CLI', cliPath],
  ['compiled retrieval metrics', metricsPath],
]) {
  if (!fs.existsSync(target)) {
    console.error(
      `Benchmark blocked: ${label} does not exist: ${target}. Run \`npm run build\` first.`,
    );
    process.exit(2);
  }
}

const { scoreCase, summarizeRun } = await import(pathToFileURL(metricsPath).href);

const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
if (!Array.isArray(corpus.queries) || corpus.queries.length === 0) {
  throw new Error('Corpus must contain a non-empty queries array.');
}
const cases = corpus.queries.filter((item) => split === 'all' || item.split === split);
if (cases.length === 0) {
  console.error(`Benchmark blocked: corpus has no cases in split \`${split}\`.`);
  process.exit(2);
}

/** Pulls the paths Umbra reported, in rank order, from one `ask_codebase` answer. */
function extractPaths(text) {
  return [...text.matchAll(/\*\*FILE:\*\*\s*([^\r\n]+)/g)].map((match) =>
    match[1].trim().replaceAll('\\', '/'),
  );
}

/**
 * Confirms the answer was produced by the provider this run selected.
 *
 * Without it a misconfigured launch silently benchmarks the other provider's
 * vectors and reports the result under the wrong name — the exact failure
 * ADR-025 made unrepresentable in storage and which remains representable here.
 */
function provesActiveProvider(text, provider) {
  return text.includes(`[embeddings: ${provider}/`) || text.includes(`queried with ${provider}/`);
}

function startServer(provider) {
  const serverArgs = ['dist/bin/cli.js', 'mcp', '--root', root, '--embeddings', provider];
  if (!args.includes('--index')) serverArgs.push('--no-index');

  const child = childProcess.spawn(process.execPath, serverArgs, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let startupError;
  child.once('error', (error) => {
    startupError = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        request.resolve(message);
      }
    }
  });

  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      if (startupError) {
        reject(startupError);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  return { child, call };
}

const READINESS_TIMEOUT_MS = 15 * 60 * 1000;
const READINESS_POLL_MS = 3000;

/**
 * Blocks until the server reports durable vector coverage, or gives up loudly.
 *
 * Umbra's handshake returns before its index is usable, and `ask_codebase`
 * refuses until the stamp proves durable coverage (ADR-030). Querying through
 * that window does not measure poor retrieval, it measures a warm-up — and the
 * refusal text looks nothing like a benchmark failure, so a runner without
 * this gate produces either a crash or, worse, a run of zeros that reads as a
 * quality regression.
 *
 * @param server - The live MCP child and its call function.
 * @param provider - The provider under test, for the error message.
 * @returns The final status text, once ready.
 */
async function waitForIndex(server, provider) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastStatus = '(no status returned)';
  let announced = false;
  let unavailablePolls = 0;

  while (Date.now() < deadline) {
    const response = await server.call('tools/call', {
      name: 'get_index_status',
      arguments: {},
    });
    lastStatus = response.result?.content?.map((content) => content.text).join('\n') ?? lastStatus;

    if (/^state:\s*ready\b/m.test(lastStatus)) return lastStatus;

    if (/^state:\s*skipped\b/m.test(lastStatus)) {
      throw new Error(
        `${provider}: the index has no durable vector coverage and warm-up was skipped. ` +
          `Re-run with --index, or build it once with \`umbra index --embeddings ${provider}\`.\n\n${lastStatus}`,
      );
    }

    // A provider that is down is not a warm-up, and waiting fifteen minutes
    // for it helps nobody. One poll of tolerance covers a blip under load —
    // which is exactly how this was first observed, with the benchmark and the
    // jest suite competing for the same local daemon.
    if (/^state:\s*unavailable\b/m.test(lastStatus)) {
      unavailablePolls += 1;
      if (unavailablePolls > 1) {
        throw new Error(`${provider}: the embedding provider is unavailable.\n\n${lastStatus}`);
      }
    } else {
      unavailablePolls = 0;
    }

    if (!announced) {
      console.error(`${provider}: waiting for durable vector coverage...`);
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_MS));
  }

  throw new Error(
    `${provider}: the index was still not ready after ${READINESS_TIMEOUT_MS / 60000} minutes.\n\n${lastStatus}`,
  );
}

async function runProvider(provider) {
  const server = startServer(provider);
  try {
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    server.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );

    const listed = await server.call('tools/list', {});
    const tools = listed.result?.tools ?? [];
    if (!tools.some((tool) => tool.name === 'ask_codebase')) {
      throw new Error(`${provider}: ask_codebase was not published.`);
    }

    const indexStatus = await waitForIndex(server, provider);

    const outcomes = [];
    for (const item of cases) {
      const startedAt = performance.now();
      const response = await server.call('tools/call', {
        name: 'ask_codebase',
        arguments: { query: item.query },
      });
      const elapsedMs = performance.now() - startedAt;

      const result = response.result;
      const text = result?.content?.map((content) => content.text).join('\n') ?? '';
      // The tool's own text is the only description of what went wrong. The
      // previous runner dropped it and reported a bare corpus id, which is a
      // failure you cannot act on without re-running by hand.
      if (result?.isError === true) {
        throw new Error(
          `${provider}: ask_codebase returned an error for corpus id ${item.id}: ${text.trim()}`,
        );
      }
      if (!provesActiveProvider(text, provider)) {
        throw new Error(
          `${provider}: the answer for corpus id ${item.id} does not name the active provider.`,
        );
      }

      outcomes.push(scoreCase(item, extractPaths(text), elapsedMs));
    }

    return {
      provider,
      cases: outcomes.length,
      // Verbatim, so a later reader can tell whether two reports were taken
      // against the same index rather than assuming it.
      indexStatus,
      summaries: summarizeRun(outcomes),
      outcomes,
    };
  } finally {
    server.child.stdin.end();
    server.child.kill();
  }
}

const report = {
  corpusVersion: corpus.version,
  split,
  ranAt: new Date().toISOString(),
  root,
  providers: [],
};
for (const provider of providers) report.providers.push(await runProvider(provider));

const day = report.ranAt.slice(0, 10);
const outputPath = path.resolve(
  valueAfter(args, '--output') ??
    path.join(repoRoot, 'docs/benchmarks/results', `${day}-${providers.join('-')}-${split}.json`),
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

// The headline is deliberately the per-split table, never one fused number.
for (const providerReport of report.providers) {
  console.log(`\n${providerReport.provider} — ${providerReport.cases} cases`);
  console.table(
    providerReport.summaries.map((summary) => ({
      split: summary.split,
      positives: summary.positives,
      negatives: summary.negatives,
      'hit@4': summary.hitRate,
      mrr: summary.mrr,
      'false abstention': summary.falseAbstentionRate,
      'correct abstention': summary.correctAbstentionRate,
      'p95 ms': summary.p95LatencyMs,
    })),
  );
}
console.log(`\nReport written to ${outputPath}`);
