# ADR-031 — Measure before building, and freeze what is not on the path

| | |
|---|---|
| **Category** | Quality · Evaluation · Roadmap · Cost |
| **Author** | David Balladares (decision) · Claude (record) |
| **Date** | 2026-09-08 |
| **Status** | ✅ **Accepted** — phases 1, 2 and 3 implemented; phase 1 measured, phase 3 not yet |
| **Refines** | ADR-019, ADR-024, ADR-028 |

---

## Context

An external review of this repository produced three criticisms. Checked
against the code, **two of them were wrong**, and recording why matters as much
as recording the plan — the wrong ones would have sent three months of work at
problems that are already solved.

**"Cosine similarity is mixed across providers, justified by a dimension
coincidence."** Not true here, and defended in three independent places.
`chunk_vectors` has the primary key `(chunk_id, provider, model)` (ADR-026);
both `RetrieverService#rankInSql` and `RetrieverService#rankInJavaScript`
filter `WHERE v.provider = ? AND v.model = ?`; and `cosineSimilarity` in
`src/core/rag/math.ts` throws on a length mismatch — a guard, not a
justification. `RetrieverService#query` raises `EmbeddingsIndexMismatchError`
when a model changes its output shape inside one provider, which is the harder
version of the same failure. The review described a defect this repository had
already closed deliberately.

**"There is no token counting before the call."** Also not accurate as stated.
`ContextCompressor.estimateTokens` is a pre-call estimate, and
`ChatSession#checkAndCompressContext` uses `ContextCompressor.isOverBudget` to
fire compression proactively at 80,000 estimated tokens.

**The third was right, and the first two being wrong made the real gap
sharper.** The genuine problems are narrower and worse than the ones reported:

1. **The abstention trade-off ADR-028 accepted has never been measurable.** The
   record states plainly that conceptual questions with only a semantic
   neighbour now abstain, and that this "must be measured before release". It
   shipped unmeasured — not through neglect, but because the corpus made it
   structurally impossible. All **ten** negative cases in
   `docs/benchmarks/embedding-retrieval-corpus.json` sat in the `holdout`
   split; `calibration` held 45 positives and zero negatives. Measuring the
   abstention policy therefore required burning the holdout, so it was never
   measured at all.

2. **The scoring fused failures that are fixed by opposite changes.** The audit
   runner reduced every case to one `hitAt4` average, in which a positive that
   returned four wrong files and a positive that returned nothing are both
   `hit: 0`. The first is a ranking defect; the second is the evidence policy
   being too strict. It also read each case's `split` field and never
   aggregated by it, folding the holdout into the headline number.

3. **The results could not be committed.** The runner defaulted its output to
   `.umbra/audits/embedding-benchmark-<Date.now()>.json`, and `.umbra/` is in
   `.gitignore`. Every measurement this project has ever taken was written to a
   path that cannot enter the repository. The one surviving number — 30% Hit@4,
   in ADR-027 and ADR-028 — exists only as prose, which proves a measurement
   happened once and can never show whether a change helped.

4. **`estimateTokens` does not count the prompt.** It sums `msg.content` and
   nothing else: not tool-call arguments, not the system prompt, not the tool
   schemas, which for a deep agent are thousands of fixed tokens on every
   request. The number compared against the 80,000 threshold is a subset of the
   visible history, and `chars / 4` is a heuristic rather than a tokenizer.
   Meanwhile `safe_read_file` in `src/core/tools/file-tools.ts` returns whole
   files with no ceiling, which is the actual mechanism by which a turn
   explodes.

5. **`chat-session.ts` is 1,418 lines** while the domain and RAG layers stayed
   small — the ordinary shape of a project where one layer gets attention and
   the other merely has to work.

CI (`.github/workflows/test.yml`) runs type-check, jest and build. No retrieval
quality gate exists at any point in the pipeline.

## Decision

**Work is ordered by what can be measured, and anything off that path is frozen
rather than allowed to grow.** These are one decision, not two: a freeze is how
"not now" stops being a wish. Without it the deferred work grows while the
measured work proceeds, and the deferral quietly becomes permanent.

### Phase 1 — Retrieval evaluation becomes a first-class artifact *(implemented)*

1. **Calibration gets its own negatives.** Ten new negative cases join
   `calibration` in `docs/benchmarks/embedding-retrieval-corpus.json`
   (corpus version 4, 70 cases). They are deliberately **different subjects**
   from the holdout negatives — Prometheus, GraphQL, Kafka, Terraform and so on
   rather than the holdout's Redis, Kubernetes and Stripe — because reusing a
   subject leaks the holdout through the calibration set. Each term was
   verified absent from `src/` before being added.

2. **Scoring moves into `src/core/rag/retrieval-metrics.ts`, under test.** The
   scoring rule is the one part of an evaluation that must not drift silently,
   because a number that moved for metric reasons reads exactly like progress.
   `scoreCase` reports `falseAbstention` and `falsePositive` as fields distinct
   from `hit`; `summarizeSplit` computes `hitRate` and `mrr` over positives
   only, and returns **`null` rather than `0`** for a rate with an empty
   denominator — `correctAbstentionRate: null` says the policy was not tested,
   which is a different claim from failing every case, and conflating the two
   is what hid this gap. `summarizeRun` reports per split with `all` last.

3. **The runner lives in the repository**, at `scripts/bench-retrieval.mjs`,
   behind `npm run bench:retrieval`. It keeps the compiled MCP binary as the
   integration boundary (ADR-028), adds `waitForIndex` so a warm-up window
   cannot be recorded as a quality regression, and reports the tool's own error
   text instead of a bare corpus id.

4. **The holdout needs a flag.** `--split holdout` and `--split all` refuse to
   run without `--allow-holdout`. This is friction, not security, placed where
   the mistake is easy and invisible.

5. **Reports are committed**, to `docs/benchmarks/results/`, named by date,
   providers and split. `docs/benchmarks/results/README.md` states how to read
   one and why the `all` row is never the headline.

### Phase 2 — Counting the prompt before paying for it *(ordered, not built)*

A `TokenCounterPort` in the domain with per-provider adapters — Anthropic's
`count_tokens` endpoint, Gemini's `countTokens`, a local tokenizer for Ollama —
resolved and pinned the way ADR-025 resolves an embedding identity, never
inferred from a model string. It must count the **whole request**: system
prompt, tool schemas, history, and tool-call arguments. The fixed part is
counted once per session and only the delta per turn.

It unlocks four things that are impossible with a post-hoc count, and only the
first exists in any form today:

- a compression threshold that is a real share of the context window;
- a ceiling applied to `safe_read_file` output **before** injection;
- routing by size, so an oversized prompt goes to the cloud model rather than
  the local one;
- rejecting a prompt that exceeds the window without paying for the round trip.

LangSmith and `TurnGovernor` are unaffected: they answer what a turn cost, and
this answers what a turn will cost. The open question this phase must also
settle is whether the embedding adapters emit any trace at all — they implement
Umbra's own `embeddings.port.ts` rather than LangChain's `Embeddings`, so a
large `umbra index` is likely invisible to LangSmith.

### Phase 3 — `query_dependency_graph` over NestJS modules *(ordered, not built)*

The MCP surface is where Umbra is infrastructure for someone else's agent
rather than a competitor to it, and a dependency graph that understands
modules, providers and injection is what generic tooling does badly. It draws
on the RAG layer, which is the best-built part of the repository, and needs
nothing from the CLI. It comes third because building it before phase 1 means
shipping it with no way to show it beats `grep`.

### The freeze

`src/presentation/cli/module-size-ceiling.spec.ts` fails if
`chat-session.ts` exceeds 1,418 lines — its size on the day of this record.
Existing size is grandfathered; new size is not. A second assertion fails once
the file drops 50 lines below its ceiling without the ceiling being lowered in
the same commit, so a reduction cannot be spent on later growth.

This is explicitly **not** a refactor. Splitting a 1,418-line session
controller is a large change with thin test coverage, competing for attention
with the measurement work above. Stopping the growth costs one spec file.

## Trade-offs actually considered

| Option | Pros | Cons | Decision |
|---|---|---|---|
| **Study embeddings first** (the review's recommendation) | Closes a knowledge gap; the reviewer's diagnosis of *why* the gap exists is fair | Aimed at a defect ADR-025/026 already made unrepresentable. Would produce reading, not a number | ❌ Rejected on evidence |
| **Evaluation first** | The harness mostly existed; the ADR-028 debt is live and unmeasured; every later phase gets a number instead of a belief | Least visible progress — no feature ships | ✅ **Chosen** |
| **Token counting first** | Self-contained; unlocks real cost control | Nothing tells you whether the compression it triggers helps or hurts retrieval quality. Needs phase 1 to be judged | ⏭ Second |
| **Refactor `chat-session.ts` now** | Removes the most visible ugliness | Large, risky, thinly covered, and fixes the layer that is not the bottleneck. The tempting work rather than the useful work | ❌ Deferred, with a ceiling instead |
| **Raise the ceiling when needed** | No friction | A ceiling that moves is a comment | ❌ Rejected |

## Consequences

### Positive

- The ADR-028 abstention trade-off becomes measurable without touching the
  holdout, for the first time since it was accepted.
- A false abstention and a wrong ranking are now distinguishable, so a result
  points at which lever to pull.
- Retrieval quality acquires a committed history instead of a remembered number.
- The holdout is protected by a flag rather than by intent.
- `chat-session.ts` cannot get worse while the work above happens.

### Neutral

- Corpus version 4 supersedes version 3. Reports produced against version 3 are
  not comparable case-for-case; the `corpusVersion` field in every report says
  which was used.

### Negative

- `retrieval-metrics.ts` is compiled into `dist/` and therefore ships to
  consumers, who will never call it. The alternative — scoring beside the
  script — puts the rule outside `type-check` and outside jest, which is the
  failure mode this decision exists to prevent. A few kilobytes is the cheaper
  side of that trade.
- The benchmark still requires a local Ollama or Vertex credentials, so it
  cannot run in CI as written. A fixture index with pre-computed vectors would
  make the ranking and abstention policy testable offline and deterministically;
  it is the remaining phase 1 step and is **not** implemented by this record.
- Two runner implementations now exist. `scripts/bench-retrieval.mjs` is
  canonical for metrics; the copy in
  `.agents/skills/umbra-embedding-retrieval-audit/scripts/run-benchmark.mjs`
  keeps its provider-authorization preflight and is left untouched rather than
  deleted. That divergence is real and should be closed by making the skill
  script delegate to this one.
- Phases 2 and 3 are recorded here as ordering only. Neither is built, and this
  record must not be read as evidence that either works.

## Verification Evidence

**The corpus gap is real, and now closed.** Before, counted directly from the
file:

```
calibration/positive: 45   calibration/negative: 0
holdout/positive:      5   holdout/negative:    10
```

After, at corpus version 4: `calibration/negative: 10`, 70 cases, 70 unique ids.

**The metrics module.** `npx jest src/core/rag/retrieval-metrics.spec.ts` →
`10 passed, 10 total`. The suite asserts the distinctions the previous scoring
could not express: a wrong path versus an abstention on the same positive case,
`null` versus `0` for an untested rate, and calibration reported apart from
holdout.

**The ceiling.** `npx jest src/presentation/cli/module-size-ceiling.spec.ts` →
`2 passed`. `chat-session.ts` is 1,418 lines by `wc -l`.

**Nothing else moved.** `npm run type-check` clean; the full suite
`813 passed, 5 skipped, 93 of 94 suites`.

**The readiness gate was written against an observed failure, not a predicted
one.** The first live run of the runner failed on the first case with
`Semantic search is not ready: Checking the configured embedding provider.`
A direct `get_index_status` probe against the compiled binary showed why:

```
state:           skipped
chunks:          999
missing vectors: 0
stamp:           missing, partial, or mismatch
```

Vectors were complete and the stamp was stale, because this session added
source files. Without the gate the runner would have crashed on a warm index
or, worse, recorded a run of zeros as a quality regression.

A second live run produced the other failure the gate now handles. With the
jest suite competing for the machine, `get_index_status` reported
`state: unavailable — Ollama is not reachable at http://localhost:11434` while
`curl` against `127.0.0.1:11434` answered immediately. Measured from Node,
`localhost` takes 887 ms against 154 ms for `127.0.0.1` — Windows resolves
`::1` first and Ollama binds IPv4 only. The gate now fails fast on a second
consecutive `unavailable` instead of waiting fifteen minutes. Changing the
default base URL is a separate matter and is **not** done here.

**The old runner's output path is gitignored.** `.umbra/` is listed in
`.gitignore`, and the previous default output was `.umbra/audits/`.
`git check-ignore` confirms the new paths are not ignored.

### Not verified

- No Vertex run. This record authorises no provider call; a paired comparison
  needs explicit approval for its exact query count, as ADR-027 established.
- The holdout was not read.
- No claim is made about phase 2 or phase 3 behaviour.

## Related Files

- `docs/benchmarks/embedding-retrieval-corpus.json` — corpus v4, calibration negatives
- `docs/benchmarks/results/README.md` — how to read a report, and why `all` is not the headline
- `src/core/rag/retrieval-metrics.ts` — `scoreCase`, `summarizeSplit`, `summarizeRun`
- `src/core/rag/retrieval-metrics.spec.ts` — the assertions that pin the scoring rule
- `scripts/bench-retrieval.mjs` — `waitForIndex`, `runProvider`, `provesActiveProvider`
- `src/presentation/cli/module-size-ceiling.spec.ts` — `CEILINGS`, `SLACK`, `lineCountOf`
- `package.json` — `bench:retrieval`
- `src/core/agent/context-compressor.ts` — `estimateTokens`, `isOverBudget` — what phase 2 replaces
- `src/core/tools/file-tools.ts` — `safe_read_file`, unbounded until phase 2
- `src/presentation/cli/chat-session.ts` — `ChatSession#checkAndCompressContext`, the frozen file
- `src/core/rag/retriever.ts` — `RetrieverService#query`, `#rankInSql`, `#rankInJavaScript` — the subject of the measurement
- `src/core/rag/math.ts` — `cosineSimilarity`, the dimension guard the review misread
- `docs/adr/ADR-028-hybrid-retrieval-requires-evidence.md` — the unmeasured trade-off
- `.agents/skills/umbra-embedding-retrieval-audit/scripts/run-benchmark.mjs` — the superseded runner, kept for its preflight

---

## Amendment — 2026-09-08 · Phase 1 produced its first number, and it changed two beliefs

The measurement this record was written to make possible has been taken. It
required repairing the index first, which is itself part of the finding.

**Two index defects had to be fixed before any number meant anything.**

`IGNORED_DIRECTORIES` in `WorkspaceDiscoveryService` did not list `.claude`,
and `.claude/worktrees/<name>/` is a complete second checkout of this
repository — 241 TypeScript files. Discovery walked it, so the index held the
repository twice: `file_registry` carried 309 rows for 157 files, and
`code_chunks` held 1,005 rows of which 439 were the duplicate set. The same
hole existed in `jest.config.ts`, where the suite was silently running twice —
183 suites and 1,633 tests instead of 97 and 818.

Separately, 206 registry rows claimed `index_state = 'indexed'` with **zero
chunks**: files the chunker skipped before `fix(rag): index classless source
modules`, which `FileRegistry#isFileChanged` can never revisit because it
compares only the stored hash. The current chunker was verified correct by
calling `NestChunker#analyze` directly — one `file` chunk each for `math.ts`,
`hybrid-ranking.ts`, `embeddings-resolver.ts`, `vector-codec.ts` and
`turn-governor.ts`. The defect is the missing repair path, not the chunker, and
it is not fixed here.

The consequence for the historical number: **24 of the 43 distinct expected
paths in the corpus had no chunk at all.** The reachable hit ceiling was ~44%,
so the 30% Hit@4 recorded in ADR-027 and ADR-028 was never a measurement of
retrieval quality. It measured index coverage.

**The number, on a clean index.** 55 calibration cases, Ollama
`nomic-embed-text`, through the compiled MCP binary, coverage 43/43 so the
ceiling is 100%:

| | |
|---|---|
| Hit@4 (45 positives) | **88.9%** |
| MRR | 0.706 |
| False abstention | **0%** |
| Correct abstention (10 negatives) | **0%** |
| p95 latency | 827 ms |

Ranking is strong. The abstention policy is broken in the direction nobody
was watching — see the 2026-09-08 amendment to
[ADR-028](./ADR-028-hybrid-retrieval-requires-evidence.md). Both facts were
invisible until the split-aware, coverage-checked harness existed, and the
second one was structurally unmeasurable while every negative case lived in the
holdout.

This is the argument of this record, demonstrated on the day it was written: the
belief that was defended in prose (abstention is too strict) was false, and the
defect nobody suspected (abstention never fires) was sitting in production.

### Phase 2, first slice — implemented

`TokenCounterPort` with `LocalTokenCounter`, `requestTextOf`, and a ceiling on
`safe_read_file`. `ContextCompressor.estimateTokens` now counts the whole
request rather than `msg.content`: tool-call arguments, per-message framing,
and — when a caller supplies them — the system prompt and tool schemas.

Not yet done in phase 2: no call site passes `overhead` yet, so the compressor
still under-counts by the fixed cost of the tool catalog; and routing by size
and early rejection are not implemented.

### Still not verified

- No Vertex run. No paired comparison.
- The holdout has not been read.
- The abstention correction is described, not built.

---

## Amendment — 2026-09-09 · Phase 3 is implemented, and this repository could barely test it

`query_nest_graph` is published. `analyzeNestGraph` reads the wiring,
`nest_bindings` / `nest_injections` / `nest_scan` store it, and the tool answers
three questions: which module binds a token, which classes inject it, and what
one module binds.

### What the repository turned out to be

Phase 3 was written on the assumption that a NestJS module graph is what this
repository has most of. It is not. Three files mention `@Module(`, five carry
`@Injectable`, and the root module's decorator is literally `@Module({})`.

That last fact stopped the work for an hour and is the most useful thing this
phase found. The first probe of `@Module({ ... })` returned an object literal
with **zero properties** and looked like a parser bug. It was not: both of this
repository's modules are **dynamic modules**, whose real wiring lives in a
`forRoot()` return value. So does every configurable NestJS module in existence
— every `forRoot`, `forRootAsync`, `register`. A tool that reads only the
decorator reports "no providers" for exactly the modules that matter most, and
reports it confidently.

A generic tool getting that wrong is the argument for this phase, stated more
precisely than the original record managed: the value is not "a dependency graph
for NestJS", it is *understanding the shapes NestJS actually ships in*.

### Two defects found by running it, not by testing it

**Injections were recorded for every class with a constructor.** The unit tests
passed; the first live run over this repository recorded `IndexerService` — an
ordinary class — as needing `EmbeddingsPort` and `(progress: string) => void`.
The second is not a token at all. Nest injects only into `@Injectable` and
`@Controller` classes, and the extractor now says so.

**The graph would have shipped empty.** `FileRegistry#isFileChanged` compares
content hashes, so an already-indexed repository re-runs the indexer and
processes nothing: the new tables would have stayed empty forever while the tool
answered "no modules". This is the third appearance today of one defect shape —
derived data with no path back for an index that already exists. `nest_scan`
records the registry's own hash so the backfill has one definition of "changed",
and reading costs no embedding call.

### Verified through the compiled binary

Six tools published, and the answers below are live output, not fixtures:

```
provides(AI_AGENT)
  AiAgentModule exports it — only when registered dynamically
  AiAgentModule provides it (factory) — only when registered dynamically
injects(AI_AGENT)
  AiAgentHttpService (@Inject)  src/presentation/http/ai-agent-http.module.ts
module(AiAgentHttpModule)
  controllers: AiAgentHttpController [dynamic]
  providers: AGENT_HTTP_OPTIONS (value) [dynamic], AiAgentHttpService [dynamic]
```

`AGENT_HTTP_OPTIONS` is a string constant. It belongs to no file, so no
file-import graph — and no `grep` for an import — can say where it comes from.
That single row is the whole argument for the feature.

### Honest limits

- **This repository cannot validate the feature at scale.** Two modules is not
  a monorepo. The unit tests cover the shapes; nothing here covers a hundred
  modules, `forwardRef` cycles, or re-exported modules.
- **No cross-file token resolution.** `findUnexportedInjections` reports a
  suspicion, never a verdict: Nest resolves a provider without an export inside
  one module, so presenting its output as a defect list would overstate it.
- **The retrieval corpus does not cover it.** Every measurement in this record
  is about `ask_codebase`. `query_nest_graph` has tests and a live check, and
  **no benchmark** — which is precisely the gap this ADR exists to complain
  about. A wiring corpus is the obvious next measurement.
- One full-suite run failed once, immediately after a live `umbra index`, and
  did not reproduce across four subsequent runs. Recorded rather than dismissed.
