#!/usr/bin/env node
/**
 * What can `query_dependency_graph` not see?
 *
 * The tool answers *what breaks if I change this*, and an incomplete answer to
 * that question is worse than a slow one: a refactor trusts it. Its edges come
 * from `NestChunker#extractDependencies`, which visits `ImportDeclaration` nodes
 * whose specifier starts with `.` and resolves them by probing three shapes.
 * Everything outside that description contributes no edge, silently.
 *
 * This builds the dependency graph independently — every file in the tree, every
 * import-like construct, resolved by probing more shapes than the indexer does —
 * and diffs it against the `dependency_graph` table the tool actually reads.
 * Recall is reported **per construct**, following the precedent
 * `nest-wiring-shapes.json` set for `query_nest_graph`: name the shapes the tool
 * goes blind to rather than publishing one number that hides them.
 *
 * ## Two kinds of miss, and only one is a defect
 *
 * A file excluded by ADR-030's discovery scope — a spec, a `.d.ts`, a story —
 * has no chunks, so it can never be a `source` row. That is a recorded decision
 * whose *consequence* for this tool was not recorded until ADR-030's 2026-09-10
 * amendment. It is reported separately from a construct the indexer walks past
 * inside a file it did index, which is a plain gap.
 *
 * ## What it cannot measure here
 *
 * Two suspected holes need a repository this one is not. `resolveModulePath`
 * never probes `.tsx`, and discovery admits `.tsx` as source — but this tree has
 * no `.tsx` file, so the hole is unobservable rather than absent. Likewise
 * tsconfig path aliases: `extractDependencies` keeps only specifiers starting
 * with `.`, and this repository declares no `paths` and uses none. Both are
 * reported as `unmeasurable-here` rather than as passing.
 *
 * Usage:
 *   node scripts/bench-graph-recall.mjs
 *   node scripts/bench-graph-recall.mjs --root ../other-repo --output report.json
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

/** Extensions the indexer probes, and the extras it does not. */
const INDEXER_PROBES = ['', '.ts', '/index.ts'];
const EXTRA_PROBES = ['.tsx', '/index.tsx', '.mts', '.cts', '.js', '/index.js'];

/** Suffixes `isIndexableSource` drops, so a file carrying one is never a source row. */
const EXCLUDED_BY_SCOPE = /\.(d|spec|test)\.ts$|\.stories\.tsx?$/i;

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/bench-graph-recall.mjs [--root <dir>] [--output <file>]');
  process.exit(0);
}

const root = path.resolve(valueAfter(args, '--root') ?? repoRoot);
const databasePath = path.join(root, '.umbra', 'memory.db');
if (!fs.existsSync(databasePath)) {
  console.error('Blocked: no index at ' + databasePath + '. Run the MCP server once first.');
  process.exit(2);
}

const { Project, SyntaxKind } = await import(
  pathToFileURL(path.join(repoRoot, 'node_modules/ts-morph/dist/ts-morph.js')).href
);
const { default: Database } = await import(
  pathToFileURL(path.join(repoRoot, 'node_modules/better-sqlite3/lib/index.js')).href
);

const toPosix = (value) => value.split(path.sep).join('/');
const relative = (absolute) => toPosix(path.relative(root, absolute));

/**
 * Resolves a relative specifier to a file on disk.
 *
 * @param fromFile - Absolute path of the importing file.
 * @param specifier - The module specifier as written.
 * @returns The resolved repo-relative path and which probe list found it, or
 * `undefined` when nothing on disk matches.
 */
function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const suffix of INDEXER_PROBES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { target: relative(candidate), probe: 'indexer' };
    }
  }
  for (const suffix of EXTRA_PROBES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { target: relative(candidate), probe: 'extra' };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- ground truth

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
  compilerOptions: { allowJs: false },
});
project.addSourceFilesAtPaths([
  path.join(root, 'src/**/*.ts'),
  path.join(root, 'src/**/*.tsx'),
]);

const sourceFiles = project.getSourceFiles();
const truth = [];
let externalSpecifiers = 0;
let unresolvable = 0;

// Counted per construct so a construct that exists in the tree but produced no
// in-repo edge is reported as *measured zero* rather than vanishing from the
// table, where its absence reads as "does not occur here".
const seenByConstruct = new Map();
const callsSeen = new Map();
const callsComputed = new Map();
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

for (const sourceFile of sourceFiles) {
  const from = sourceFile.getFilePath();
  const fromRelative = relative(from);

  /** Records one candidate edge, classified by the construct that produced it. */
  const record = (specifier, construct) => {
    if (specifier === undefined || specifier.length === 0) return;
    bump(seenByConstruct, construct);
    if (!specifier.startsWith('.')) {
      externalSpecifiers += 1;
      return;
    }
    const resolved = resolveSpecifier(from, specifier);
    if (resolved === undefined) {
      unresolvable += 1;
      return;
    }
    truth.push({
      source: fromRelative,
      target: resolved.target,
      construct,
      probe: resolved.probe,
      sourceExcludedByScope: EXCLUDED_BY_SCOPE.test(fromRelative),
      specifier,
    });
  };

  for (const declaration of sourceFile.getImportDeclarations()) {
    const construct = declaration.isTypeOnly() ? 'import-type' : 'import';
    record(declaration.getModuleSpecifierValue(), construct);
  }

  for (const declaration of sourceFile.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === undefined) continue; // `export { local }` re-exports nothing
    record(specifier, declaration.isNamespaceExport() ? 'export-star' : 'export-named');
  }

  // `import()` and `require()` are call expressions, which `extractDependencies`
  // never visits. Read from the text of the call rather than the type system,
  // because a computed specifier has no static answer and should not be counted.
  //
  // The kind comes from the enum, not from a number: this loop was first written
  // with a hardcoded `213` and silently matched nothing, so the two constructs it
  // exists to measure were reported as absent from a tree that contains both.
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expressionText = call.getExpression().getText();
    if (expressionText !== 'import' && expressionText !== 'require') continue;
    const construct = expressionText === 'import' ? 'dynamic-import' : 'require';
    bump(callsSeen, construct);
    const [firstArgument] = call.getArguments();
    if (firstArgument === undefined) continue;
    const literal = /^['"](.+)['"]$/.exec(firstArgument.getText());
    if (literal === null) {
      // A computed specifier has no static answer, so no graph could carry it.
      // Counted rather than skipped, because "we found none" and "we found some
      // and could not resolve them" are different claims about the same tree.
      bump(callsComputed, construct);
      continue;
    }
    record(literal[1], construct);
  }
}

// ------------------------------------------------------------------- the index

const db = new Database(databasePath, { readonly: true });
const graphRows = db.prepare('SELECT source, target FROM dependency_graph').all();
const indexedSources = new Set(
  db.prepare('SELECT DISTINCT file_path FROM code_chunks').all().map((row) => toPosix(row.file_path)),
);
db.close();

const graphEdges = new Set(graphRows.map((row) => toPosix(row.source) + ' -> ' + toPosix(row.target)));

// -------------------------------------------------------------------- scoring

const byConstruct = new Map();
for (const edge of truth) {
  const key = edge.construct;
  const bucket = byConstruct.get(key) ?? { construct: key, total: 0, found: 0, missingBecauseScope: 0, missingInsideIndexedFile: 0, examples: [] };
  bucket.total += 1;
  if (graphEdges.has(edge.source + ' -> ' + edge.target)) {
    bucket.found += 1;
  } else if (edge.sourceExcludedByScope) {
    bucket.missingBecauseScope += 1;
  } else {
    bucket.missingInsideIndexedFile += 1;
    if (bucket.examples.length < 3) {
      bucket.examples.push(edge.source + ' -> ' + edge.target + '  (' + edge.specifier + ')');
    }
  }
  byConstruct.set(key, bucket);
}

const constructs = [...byConstruct.values()].sort((a, b) => b.total - a.total);

// Inbound is the question the tool is asked. Score it per target file.
const truthInbound = new Map();
for (const edge of truth) {
  const set = truthInbound.get(edge.target) ?? new Set();
  set.add(edge.source);
  truthInbound.set(edge.target, set);
}
const graphInbound = new Map();
for (const row of graphRows) {
  const target = toPosix(row.target);
  const set = graphInbound.get(target) ?? new Set();
  set.add(toPosix(row.source));
  graphInbound.set(target, set);
}

let filesWithCompleteInbound = 0;
let filesWithPartialInbound = 0;
const worstInbound = [];
for (const [target, expected] of truthInbound) {
  if (!indexedSources.has(target)) continue; // not a file the tool can be asked about
  const reported = graphInbound.get(target) ?? new Set();
  const missing = [...expected].filter((source) => !reported.has(source));
  if (missing.length === 0) filesWithCompleteInbound += 1;
  else {
    filesWithPartialInbound += 1;
    worstInbound.push({ target, expected: expected.size, reported: reported.size, missing: missing.length });
  }
}
worstInbound.sort((a, b) => b.missing - a.missing);

const allFiles = sourceFiles.map((file) => relative(file.getFilePath()));
const excludedFiles = allFiles.filter((file) => EXCLUDED_BY_SCOPE.test(file));

// A construct the tree contains whose every occurrence points outside the
// repository contributes no edge either way, so its recall is undefined rather
// than perfect. Saying so is the difference between "captured" and "untested".
const constructsWithNoLocalEdges = [...seenByConstruct.entries()]
  .filter(([construct]) => !byConstruct.has(construct))
  .map(([construct, occurrences]) => ({
    hole: construct + ' with a relative specifier',
    why: 'extractDependencies visits ImportDeclaration nodes only, so this construct contributes no edge',
    status: 'unmeasurable-here',
    detail:
      occurrences + ' occurrence(s) in this tree, every one resolving outside the repository or to a computed specifier',
  }));

// `import()` and `require()` are reported by occurrence as well as by edge. A
// call with a computed specifier has no static target, so no graph could carry
// it — but "we found none" and "we found some and none were resolvable" are
// different claims, and only one of them is a clean bill of health.
// Both are listed unconditionally, including at zero. A construct that silently
// drops out of a table reads as covered, and these two are the ones the indexer
// provably cannot see: a grep for `import(` in this tree returns a `typeof
// import('fs')` type position and a mention inside a TSDoc comment, neither of
// which is a call. Zero occurrences is a fact about the repository, not about
// the tool.
const callConstructs = ['dynamic-import', 'require'].map((construct) => ({
  construct,
  seen: callsSeen.get(construct) ?? 0,
  computedSpecifier: callsComputed.get(construct) ?? 0,
  relativeEdges: byConstruct.get(construct)?.total ?? 0,
}));

const unmeasurable = [
  ...constructsWithNoLocalEdges,
  {
    hole: 'relative specifier resolving to a .tsx file',
    why: 'resolveModulePath probes only the exact path, +.ts and +/index.ts, while discovery admits .tsx as source',
    status: allFiles.some((file) => file.endsWith('.tsx')) ? 'measurable' : 'unmeasurable-here',
    detail: 'this tree holds ' + allFiles.filter((f) => f.endsWith('.tsx')).length + ' .tsx files',
  },
  {
    hole: 'tsconfig path alias',
    why: 'extractDependencies keeps only specifiers starting with a dot',
    status: 'unmeasurable-here',
    detail: 'this repository declares no compilerOptions.paths and uses no alias specifiers',
  },
];

function codeVersion() {
  const run = (command) =>
    childProcess.execSync(command, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return { commit: run('git rev-parse --short HEAD'), dirty: run('git status --porcelain').length > 0 };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

const code = codeVersion();
const totals = constructs.reduce(
  (acc, c) => ({
    total: acc.total + c.total,
    found: acc.found + c.found,
    scope: acc.scope + c.missingBecauseScope,
    inside: acc.inside + c.missingInsideIndexedFile,
  }),
  { total: 0, found: 0, scope: 0, inside: 0 },
);

const report = {
  arm: 'graph-recall',
  ranAt: new Date().toISOString(),
  commit: code.commit,
  dirtyWorkingTree: code.dirty,
  root,
  tree: {
    sourceFiles: allFiles.length,
    excludedByScope: excludedFiles.length,
    indexedSources: indexedSources.size,
  },
  edges: {
    groundTruth: totals.total,
    inGraph: totals.found,
    recall: totals.total === 0 ? null : totals.found / totals.total,
    missingBecauseSourceExcludedByScope: totals.scope,
    missingInsideAnIndexedFile: totals.inside,
    externalSpecifiersIgnored: externalSpecifiers,
    unresolvableSpecifiers: unresolvable,
  },
  byConstruct: constructs,
  callConstructs,
  inbound: {
    filesAsked: filesWithCompleteInbound + filesWithPartialInbound,
    complete: filesWithCompleteInbound,
    partial: filesWithPartialInbound,
    worst: worstInbound.slice(0, 10),
  },
  unmeasurable,
};

const stamp = code.commit + (code.dirty ? '-dirty' : '');
const outputPath = path.resolve(
  valueAfter(args, '--output') ??
    path.join(repoRoot, 'docs/benchmarks/results', new Date().toISOString().slice(0, 10) + '-graph-recall-' + stamp + '.json'),
);
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

// ---------------------------------------------------------------------- output

const percent = (part, whole) => (whole === 0 ? 'n/a' : ((part / whole) * 100).toFixed(1) + '%');

console.log('graph recall - ' + allFiles.length + ' source files, ' + indexedSources.size + ' indexed');
console.log(
  '  ' + excludedFiles.length + ' files are outside the discovery scope (ADR-030), so they can never be a graph source',
);
console.log();
console.log('edges: ' + totals.found + ' of ' + totals.total + ' present  -> recall ' + percent(totals.found, totals.total));
console.log('  missing because the importing file is out of scope: ' + totals.scope);
console.log('  missing inside a file that IS indexed:              ' + totals.inside);
console.log();
console.log('by construct:');
console.log('  construct        total   in graph   recall    out-of-scope   gap');
for (const c of constructs) {
  console.log(
    '  ' + c.construct.padEnd(16) +
      String(c.total).padStart(5) +
      String(c.found).padStart(11) +
      percent(c.found, c.total).padStart(9) +
      String(c.missingBecauseScope).padStart(15) +
      String(c.missingInsideIndexedFile).padStart(6),
  );
}
console.log();
console.log('inbound, the question the tool is asked:');
console.log(
  '  ' + report.inbound.complete + ' of ' + report.inbound.filesAsked + ' indexed files report every importer  (' +
    percent(report.inbound.complete, report.inbound.filesAsked) + ')',
);
console.log(
  '  ' + report.inbound.partial + ' report an incomplete list  (' +
    percent(report.inbound.partial, report.inbound.filesAsked) + ')',
);
if (worstInbound.length > 0) {
  console.log('  worst:');
  for (const entry of worstInbound.slice(0, 5)) {
    console.log('    ' + entry.reported + ' of ' + entry.expected + ' importers  ' + entry.target);
  }
}
console.log();
console.log('constructs with a gap inside an indexed file:');
const gaps = constructs.filter((c) => c.missingInsideIndexedFile > 0);
if (gaps.length === 0) console.log('  none');
for (const c of gaps) {
  console.log('  ' + c.construct + ': ' + c.missingInsideIndexedFile + ' edges');
  for (const example of c.examples) console.log('      ' + example);
}
console.log();
console.log('not measurable on this repository:');
for (const item of unmeasurable.filter((i) => i.status === 'unmeasurable-here')) {
  console.log('  ' + item.hole + ' - ' + item.detail);
}
for (const entry of callConstructs) {
  console.log(
    '  ' + entry.construct + ' - ' + entry.seen + ' call(s) in the tree, ' +
      entry.computedSpecifier + ' with a computed specifier, ' +
      entry.relativeEdges + ' resolving inside the repository',
  );
}
console.log();
console.log('Report written to ' + outputPath);
