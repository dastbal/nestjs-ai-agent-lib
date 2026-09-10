# Retrieval cost and latency report — 2026-09-10

## Objective

Establish what the embedding apparatus buys, where `ask_codebase` latency
actually goes, and what an answer is made of — after an external audit of the
published 2.2.5 package proposed three defects, two of which turned out to be
decisions this repository had already recorded and measured.

The audit's own conclusions are corrected here rather than repeated. That is the
point of the report: the second external review in a row produced three findings
of which two did not survive contact with the records, which is a fact about the
review process and is recorded as such in the amendment to ADR-031.

## What changed

| Control | Implementation | Audit signal |
| --- | --- | --- |
| Control arm | `scripts/bench-fts-only.mjs`, `npm run bench:fts-only` — the same corpus with the semantic branch removed | `arm: 'fts-only'` reports under `docs/benchmarks/results/` |
| Two-arm reporting | `policy` (abstention as shipped) and `ranking` (grounding gate lifted) | `summaries.policy` / `summaries.ranking` |
| Latency honesty | The control arm declares what its clock excludes instead of inviting a false comparison | `latencyExcludes` in every control-arm report |
| Same-index baseline | A clean hybrid run at the same commit and index as the control arm | `2026-09-10-ollama-calibration-e72d7a8.json` |

Nothing in `src/` changed. This report is measurement only.

## Measurement history

### Preflight — which code was measured

The audit drove the MCP server the way a client does, through
`npx -y @dastbal/umbra`, which runs the **published tarball** and not `src/`.
Every root cause it names was read from `src/`. Those are two different artifacts
and the distinction was load-bearing, so it was checked first.

`dastbal-umbra-2.2.5.tgz` was extracted and its `dist/` compared against the
local `dist/`, which was built after every `src/` file's last modification with a
clean tree:

```
diff -rq <tarball>/package/dist dist   ->   0 differing files
```

Byte-identical across the whole tree. The measurements and the attributions
describe the same code, and no finding below carries an asterisk for it.

### The control arm — what the vectors buy

Calibration split, 55 cases, commit `e72d7a8`, clean tree, index at 169 files and
1,022 chunks. Both arms passed the same preflights: coverage 43/43 expected paths
for a 100% reachable ceiling, and 10 of 10 negatives still able to test
abstention, none rotted.

| Arm | hit@4 | mrr | false abstention | correct abstention |
| --- | --- | --- | --- | --- |
| hybrid | **0.867** | 0.683 | 0.022 | 1.000 |
| fts-only, `policy` | 0.667 | 0.585 | 0.044 | 1.000 |
| fts-only, `ranking` | 0.689 | 0.607 | 0.022 | 1.000 |

Twenty points of hit rate, and the **shape** of the loss decides the roadmap. Of
the nine positives only the vectors rescue, **eight were answered by the lexical
arm** — it returned files, confidently, and they were the wrong ones. One
(`embedding-default`) abstained as ungrounded. So the vectors are not buying
recall; they are buying the difference between a confident wrong answer and a
right one, which is the failure mode that matters most to a consuming agent.

In 45 positives there was **no case where fusion displaced a correct lexical
hit**. Rank fusion is not costing anything measurable here.

The gap between the two fts-only arms is one case. Removing the vectors makes the
`hybrid` evidence class unreachable, so `hasGroundedEvidence` can only ground on
`lexicalExact` and abstention tightens by omission rather than by decision. That
side effect is 2.2 points of the 20; the remaining 17.8 are ranking.

Six positives are missed by both arms — `lexical-index`, `abstention-report`,
`file-registry`, `cosine-math`, `vertex-provider`, `chunk-types`. Those are the
corpus's genuinely hard cases and neither retriever reaches them.

**Conclusion: the embedding apparatus is justified by evidence and stays.** The
proposal to remove it is closed, and `docs/deferred-work.md` records the two
candidates that were waiting on exactly this number.

### Where the latency goes

The hybrid arm's median round trip is 293.6 ms (p95 427.5 ms). Decomposed by
timing each stage directly against the same index:

| Stage | Median in isolation |
| --- | --- |
| `inspectIndexIntegrity` — the readiness gate | 202.4 ms (6 runs, 173.5–316.1) |
| Ollama `embedQuery` — one query vector | 87.2 ms (warm) |
| FTS + vector ranking + fusion — **the search itself** | 2.2–5.6 ms |
| **sum of the three** | **~295 ms** |

The three isolated stages sum to slightly more than the 293.6 ms observed median,
so between them they account for the entire round trip and there is no large
unexplained component left to look for. The corollary is that transport, chunk
loading and rendering are inside the measurement noise of the two big stages, and
that the exact per-stage shares cannot be stated more finely than this — 202 ms
against 5 ms is robust, 69% against 30% is not.

`readReadiness` calls `inspectIndexIntegrity` on **every** `ask_codebase` call,
and that opens a second SQLite connection, re-runs workspace discovery and
md5-hashes every discovered source file. It re-derives what
`.umbra/index.identity.json` already records. The graph tools do not pass through
that gate, which is the whole explanation for the two-orders-of-magnitude latency
gap the audit observed between them and `ask_codebase` — the audit attributed it
to the embedding call, and the embedding call is the smaller half.

One incidental result: the first `embedQuery` of a process took 1,617 ms against
87 ms for every later one. That is Ollama loading the model, and it explains the
p95 of 1,219 ms in the 2026-09-09 report against 427 ms here, with the model
already warm. A cold p95 is measuring the daemon, not the retriever.

### What an answer is made of

Measured across all 169 stored skeletons in `file_registry.skeleton_signature` —
the column `RetrieverService#getFileSkeleton` reads back and interpolates raw
into the answer, so this is the shipped payload rather than a reconstruction:

| Component | Tokens | Share of skeleton |
| --- | --- | --- |
| External package import statements (211) | 2,234 | 14.2% |
| Relative, first-party imports (387) | 6,675 | 42.5% |
| JSON envelope and remaining fields | 6,801 | 43.3% |

Mean 93 tokens per file, so at four files an answer carries up to ~372 tokens of
skeleton. **On this repository the external-import share is 14.2% of a small
block, not the 28% the audit reported** — that figure was measured against a
consumer repository importing `@zohocrm/typescript-sdk-2.0`, where a single file
carries roughly sixty named imports from one package and one answer reached 65%.
The defect is real and repository-independent; its *cost* scales with how much
the target repository imports from fat external SDKs, and reporting a single
percentage for it would overstate it for most repositories.

The duplication is worse than the share suggests. `NestChunker#extractClassContext`
prepends every import declaration to each `class_signature` chunk, so the same
statements travel twice in one answer — once as skeleton JSON, once inside the
snippet. For `src/core/llm/provider.ts` that chunk is 289 tokens of which 136,
**47%**, are the import block.

Three lines above the skeleton block, `RetrieverService` renders the
graph-derived import list capped at five and already filtered to first-party
paths. The asymmetry inside one function is the evidence that the uncapped
sibling is an omission rather than a design.

## How to audit the next session

```bash
npm run build
npm run bench:retrieval -- --providers ollama --split calibration
npm run bench:fts-only
```

Both write to `docs/benchmarks/results/`. Compare **hit rates only** across the
two arms: the control arm runs in-process and its `latencyExcludes` field lists
the transport, the readiness gate and the query embedding, none of which it pays.

Before believing any difference, apply the four checks in that directory's
README in order — same `corpusVersion`, same `reachableHitCeiling`, same
`negativeHealth.provable`, and only then credit the commit. Applied to the
2026-09-09 and 2026-09-10 hybrid reports, all three preconditions match, and the
0.844 → 0.867 difference is **one case out of 45** from a run whose tree was
dirty. It is not a change worth crediting to anything.

To re-derive the latency split, time `inspectIndexIntegrity(root, identity)` from
`dist/core/rag/index-integrity.js` directly against a repository whose index is
healthy. It needs no server and no provider.

## Current limitations and follow-up metric

**The corpus is 45 positives.** One case is 2.2 points. Every difference smaller
than about three points in this report is inside the resolution of the
instrument, and the 20-point control-arm gap is the only one comfortably outside
it.

**Latency was decomposed by isolation, not by instrumentation.** The stages were
timed individually against the same index; nothing traced a single real request
end to end. The ordering is robust — 202 ms against 5 ms is not a measurement
artefact — but the exact shares are not.

**The cost of an answer is measured on the corpus of one repository plus recalled
figures from another.** The consumer-repository numbers (a bimodal token
distribution clustering at ~1.4k and ~3.7k, a 65% peak external-import share, a
13–16 s boot, a sub-250 ms readiness race, and a `.spec.ts` omission in
`query_dependency_graph` verified twice) come from earlier sessions whose raw
captures did not survive the session that produced them. They are reported as
prior observations, not as reproducible measurements, and the harness committed
here is what makes the next round reproducible instead.

**The follow-up metric is response cost.** The quality gate has floors and no
ceiling, so nothing in CI would have noticed the skeleton block growing. Until
`measureResponseCost` exists beside `retrieval-metrics.ts` and the gate carries a
token ceiling calibrated against more than one repository, the size of an answer
remains something an audit finds rather than something the build reports.

## Related

- `docs/benchmarks/results/README.md` — the report format and the comparison protocol.
- `docs/adr/ADR-028-hybrid-retrieval-requires-evidence.md` — the abstention rule the audit mistook for a defect.
- `docs/adr/ADR-030-discovery-based-indexing-and-decision-catalogs.md` — the discovery scope, and the consequence for `query_dependency_graph` it does not record.
- `docs/adr/ADR-031-measure-before-building.md` — why this directory exists, and the review-process amendment.
- `docs/deferred-work.md` — the candidates this measurement unblocks or closes.
