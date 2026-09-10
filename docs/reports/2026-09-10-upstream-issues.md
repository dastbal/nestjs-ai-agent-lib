# Issue drafts — retrieval audit of 2.2.5

One section per finding, written to be pasted into an issue. Every claim here is
either measured on this repository or read from source and labelled as such.
Measurements are reproducible with `npm run bench:retrieval`,
`npm run bench:fts-only` and `npm run bench:graph`; the reports are committed
under `docs/benchmarks/results/`.

Preflight, because it decided whether anything was attributable: the audit drove
the server through `npx -y @dastbal/umbra`, which runs the **published tarball**,
while every root cause was read from `src/`. Those are two artifacts. The
tarball's `dist/` was extracted and compared tree-wide against the local `dist/`
at a clean tree — **zero differing files** — so the measurements and the
attributions describe the same code.

---

## Read this first: three findings that do not hold

An audit of the published package reported three defects. Two were decisions this
repository had already recorded and measured, and the third was real but aimed at
the least important member of its family. Filing them as bugs would have asked
the project to reject its own design.

**1. "The unknown-term gate is a hard AND — one absent word aborts the query."**
Accurate about the mechanism, wrong about it being a defect.
[ADR-028](../adr/ADR-028-hybrid-retrieval-requires-evidence.md)'s 2026-09-08
amendment installed it deliberately, priced it — correct abstention 0% → 100% for
false abstention 0% → 2.2%, p95 halved — and rejected the alternative of a tuned
score threshold on the grounds that term presence is a property the index answers
about itself, with no constant to fit.

What *is* reportable is narrower and is issue 4 below: the residual gap has two
classes and the record names only one.

**2. "`.spec.ts` files are excluded from the dependency graph."**
True, recorded in
[ADR-030](../adr/ADR-030-discovery-based-indexing-and-decision-catalogs.md), and
measured now: **it is not where the graph loses edges.** Ordinary imports inside
an indexed file are captured perfectly, zero gap across 369 edges. All 53 genuine
misses are re-exports. See issue 5.

**3. "Roughly 28% of an `ask_codebase` response is external SDK import paths."**
Real, and the number does not travel. That figure came from a consumer repository
whose single Zoho SDK import list runs to about sixty names. On this repository
the same block is 14.2% of a 93-token-per-file payload. The defect is
repository-independent; its price is not, and a single percentage overstates it
for most repositories. **Fixed** — see the closed section at the end.

---

## 1 — The server misses its own client's connect deadline · P0

**What happens.** `umbra mcp` does not finish starting before an MCP client gives
up. Observed as `MCP server umbra connection timed out after 30000ms`, against a
boot measured at 13–16 s in earlier sessions. A tool that does not connect has no
retrieval quality at all, which makes this the first thing to fix regardless of
everything below.

**Root cause, read from source.** Four costs sit on the boot path, and the last
two are unbounded:

- `src/core/state/db.ts:164` — `enrichExistingTSDoc` re-parses **every indexed
  `.ts` file** through `ts-morph` inside one transaction, on the event loop, so
  it blocks request handling while it runs. One-shot per install, unbounded in
  duration.
- `src/presentation/mcp/start-mcp-server.ts:237` — a full `indexProject()` runs on
  every boot even when the index is complete, which md5-hashes every file and
  re-analyses the Nest graph.
- `probeEmbeddings` — up to ~12 s worst case: a 3 s timeout, two attempts, two
  endpoints.
- `npx -y @dastbal/umbra` — package resolution plus a `better-sqlite3` native
  load, unbounded on a cold npm cache.

**Why it is not simply "make it faster".** The ordering is deliberate and
documented at `start-mcp-server.ts:55-63`: the transport connects *before*
provider probing and index work, precisely so the handshake is not blocked. The
mechanism is right and two things escape it — `enrichExistingTSDoc` because the
`AgentDB` singleton initialises synchronously inside whichever request touches it
first, and `indexProject()` because it runs unconditionally.

**Proposed fix.** Move `enrichExistingTSDoc` off the synchronous DB-init path,
and make the boot-time `indexProject()` conditional on the stamp reporting
anything to do. Both are inside the existing warm-up pattern, which already runs
in the background after `connect`.

**Verification.** Time `umbra mcp --root <repo>` from spawn to the first
successful `ask_codebase` reply, on a warm and a cold npm cache. The number to
beat is a client's default connect timeout, not a percentage.

---

## 2 — The readiness gate hashes the whole repository on every call · P0

**What happens.** Every `ask_codebase` call re-runs a full index integrity sweep
before answering. Measured on this repository at 169 files:

| Stage | Median in isolation |
| --- | --- |
| readiness gate | **202.4 ms** (6 runs, 173.5–316.1) |
| query embedding, warm | 87.2 ms |
| FTS + vector ranking + fusion — the search | 2.2–5.6 ms |
| sum | ~295 ms against a 293.6 ms observed median |

The three account for the whole round trip. **The search is about one percent of
it.** The cost scales with the file count of the repository being served, not
with the question.

**Root cause, read from source.** `readReadiness`
(`src/presentation/mcp/start-mcp-server.ts:276`) calls `inspectIndexIntegrity`,
which opens a second SQLite connection, re-runs
`WorkspaceDiscoveryService.discover()` and md5-hashes every discovered source
file (`src/core/rag/index-integrity.ts:134-142`) — to re-derive facts
`.umbra/index.identity.json` already records.

**It also explains a misattribution.** The graph tools do not pass through this
gate and `ask_codebase` does. That, not the embedding call, is the
two-orders-of-magnitude latency gap between them.

**Proposed fix.** The hot path reads the stamp plus the lease
(`src/core/rag/index-stamp.ts`, `src/core/rag/index-run-lease.ts` — ADR-030
already names the lease as the invalidation signal). The full sweep moves to
`umbra doctor --index` and `get_index_status`.

**The question to answer before writing code** is not *how do we cache it* but
**what must still invalidate it**: a lease becoming active, a stamp whose file
counts moved, a schema change. Anything that can go stale without one of those
firing becomes a wrong answer with a fast response time — which is the failure
ADR-025 exists to prevent. Scoped in `docs/deferred-work.md` under *The readiness
gate should answer from the stamp*.

**Verification.** Re-time the three stages. A change that does not move the 202 ms
did not do what it was for.

---

## 3 — An approved alias can make a query abstain forever · P1

**What happens.** A retrieval alias whose *context* terms are absent from the
index makes **every** query matching its trigger abstain, permanently, with no
recovery path.

**Root cause, read from source.** Three facts in `src/core/rag/retrieval-memory.ts`
combine:

1. `expand()` appends `context_terms` into the query string.
2. That expanded string is what `RetrieverService` hands to `findUnknownTerms`.
3. `knownTerms()` exempts only `trigger_terms` — not `context_terms`.

And `approve()` validates that `verifiedPaths` is non-empty but never validates
that the context terms exist in the index. The clarification retry re-expands, so
it cannot recover either.

**Repro.** Approve an alias whose context terms include a word absent from the
indexed source, then ask anything matching its trigger. Every such query abstains
naming a term the operator supplied.

**Proposed fix.** `approve()` rejects an alias whose context terms are not present
in the index — the same probe `findUnknownTerms` already uses. Optionally, exempt
context terms in `knownTerms()` as well; rejecting bad input is the smaller change
and the safer one.

**Note.** This must be fixed before anything writes aliases through the MCP
surface, or a latent trap becomes a reachable one.

**Verification.** A spec that approves such an alias and asserts `approve()`
refuses it.

---

## 4 — The unknown-term gate has two morphology classes, and reaches only one · P1

**What happens.** A query abstains over an ordinary English word the repository
expresses differently.

| Query term | What the repository writes | Why the probe misses it |
| --- | --- | --- |
| `globally` | `global` | `-ly` is derivation; `INFLECTIONS` covers `ing`, `ed`, `es`, `s` |
| `synchronized` | `sync` | already named in ADR-028 |
| `resume` | `checkpoint` | not morphology — a synonym |

**Root cause, read from source.** `src/core/rag/unknown-terms.ts` bridges
**inflection** and the gap is **derivation**. No ending added to `INFLECTIONS`
turns it into a stemmer; `-ly`, `-ion` and `-ance` need a different mechanism or
an explicit closed set.

The third row is a different problem with an existing answer: a synonym is what
ADR-029's approved aliases are for, and **nothing on the MCP surface can reach
`approve()`**. The abstention names the missing term and offers the caller no
route to resolve it.

**Proposed fix.** Two separable pieces. For derivation, decide between a light
stemmer and a closed suffix set — and measure, because this gate's whole value is
that it has no tuned constant. For synonyms, see *An abstention that asks instead
of refusing* in `docs/deferred-work.md`; it contradicts ADR-024 and needs a record
before code.

**Verification.** `npm run bench:fts-only` isolates this without a provider. The
gate's false-abstention cap is the guard.

---

## 5 — `export * from` is invisible to the dependency graph · P1

**What happens.** `query_dependency_graph` answers *what breaks if I change this*
with a tidy, short and confident list. Measured on this repository:

| Construct | Total | In graph | Recall | Out of scope | Gap |
| --- | --- | --- | --- | --- | --- |
| `import` | 537 | 369 | 68.7% | 168 | **0** |
| `export * from` | 48 | 0 | **0.0%** | 0 | **48** |
| `import type` | 29 | 23 | 79.3% | 6 | **0** |
| `export { x } from` | 7 | 2 | 28.6% | 0 | **5** |
| **edges** | **622** | **394** | **63.3%** | 175 | **53** |

Inbound, which is the question actually asked: **24 of 164 indexed files report
every importer; 140 report an incomplete list.**

**The scope is not the problem.** Ordinary imports inside an indexed file are
captured perfectly — zero gap across 369 edges — so ADR-030's discovery exclusion
accounts for 175 edges by design and nothing here argues against it. Every
genuine miss is a re-export.

**The consequence that reads worst.** `src/index.ts` is the published package's
barrel and re-exports everything, so it has **no outbound edges at all**. "What
breaks if I change `factory.ts`" never names the entry point a consumer imports.

**Root cause, read from source.** `NestChunker#extractDependencies`
(`src/core/tools/ast/chunker.ts`) visits `ImportDeclaration` nodes only. An
`ExportDeclaration` with a module specifier is a different node kind and is never
walked.

**Proposed fix.** Visit `getExportDeclarations()` alongside
`getImportDeclarations()` and record an edge for any with a module specifier. It
is the same resolution path; only the node source changes. Reindex required, since
edges are persisted.

**Two adjacent holes that need a different repository to observe**, reported as
`unmeasurable-here` rather than as passing: `resolveModulePath` never probes
`.tsx` although discovery admits `.tsx` as source, and `extractDependencies` keeps
only specifiers starting with `.`, so a tsconfig path alias contributes nothing.
This tree has no `.tsx` file and declares no `paths`. A Next.js consumer would
show both, and for such a consumer the `.tsx` hole is larger than everything above.

**Verification.** `npm run bench:graph`. The `export-star` row should reach 48 of
48, and the *gap* column should be zero everywhere.

---

## 6 — Grounding is judged after the candidate list is truncated · P2

**What happens.** A request can abstain while grounded evidence sits in the
candidate pool.

**Root cause, read from source.** `src/core/rag/retriever.ts` gathers
`Math.max(limit, 12)` candidates, then `fuseRankings(..., limit)` truncates to 4
**before** `hasGroundedEvidence` runs. A hybrid-evidenced chunk ranked 5th to 12th
is discarded, and the request abstains as ungrounded.

**Status.** Plausible from source, **not reproduced**. It needs a case where the
only hybrid evidence lands outside the top four, and no corpus case currently
does.

**Proposed fix.** Evaluate grounding over the candidate pool, then truncate. If
that changes abstention behaviour it is an ADR-028 amendment, not a bug fix — so
measure first.

**Verification.** `npm run bench:fts-only` reports a `reason` per case; a case
abstaining as `ungrounded` while its expected path sits in the pool is the repro.

---

## 7 — An abstention reaches the client as a success · P2

**What happens.** A client cannot distinguish "Umbra declined to answer" from "Umbra
answered" without parsing prose.

**Root cause, read from source.** `src/presentation/mcp/dto-mapper.ts:80` sets
`isError` only for a leading `❌`. Both abstention paths return `🚫 **NO GROUNDED
EVIDENCE**` (`src/core/rag/unknown-terms.ts:214`) and `⚠️ **NO GROUNDED
EVIDENCE:**` (`src/core/rag/retriever.ts:105`), so both arrive as ordinary
successful content.

**Why it matters beyond tidiness.** An agent orchestrating Umbra cannot branch on
"no evidence" programmatically, which is exactly the case where it should stop
rather than proceed on an empty answer.

**Proposed fix.** Either mark abstentions with the same prefix convention, or —
better — carry a structured field. MCP tool results support structured content;
prose parsing is what this avoids.

**Verification.** A contract spec asserting that an abstaining call returns a
result a client can branch on without reading the message.

---

## 8 — The CI fixture disagrees with the live corpus about ranking direction · P2

**What happens.** A green retrieval gate is not evidence about a ranking change.

**Measured.** Testing BM25 column weights on 2026-09-10, one vector cost the live
calibration corpus 0.070 of MRR (0.607 → 0.537) and **gained** 0.011 on the
fixture (0.656 → 0.667). The fixture called a measured regression a small
improvement.

**Why this is more than a known limitation.** ADR-031 already records that the
fixture's numbers are not the live numbers — 158 chunks against ~1,000, 15
positives against 45. This is sharper: it disagrees about the *direction*, not
only the magnitude.

**Status.** Documented rather than fixed, at
`src/core/rag/lexical-index.ts` and on `MRR_FLOOR` in
`src/core/rag/retrieval-gate.spec.ts`, both of which now say that CI will not stop
a re-weighting and which runner will.

**Proposed fix.** Either grow the fixture until it tracks the live corpus, or
state its scope explicitly: it guards abstention and plumbing, not ranking. The
second is honest and free; the first is the only one that makes CI useful for
ranking work.

---

## 9 — Dead code in the indexer · P3

Three private methods in `src/core/rag/indexer.ts` are never called:
`processSingleFile` (`:649`), `embedAndSaveBatches` (`:691`) and `saveGraph`
(`:841`). Only `indexSingleFile` is live.

All three are still *named*, which is why a plain search does not settle it:
`saveGraph` appears in a comment saying it is deliberately not called
(`indexer.ts:673`), `processSingleFile` in a comment explaining where a field
came from (`:752`), and `embedAndSaveBatches` both in a comment at `:627` and in
one inside `src/core/rag/embeddings/vector-coexistence.spec.ts:123`. None of
those is a call site.

Worth filing rather than ignoring, because the deferred entry *Indexing should be
transactional, and reindex only what is missing* names `embedAndSaveBatches` as
"the hook" and quotes its return shape — so a recorded plan is pointing at dead
code, and whoever picks it up will start by wiring into a function nothing runs.

---

## Fixed while auditing

| Finding | Commit | Result |
| --- | --- | --- |
| The skeleton block was emitted as raw stored JSON, uncapped and unfiltered, with imports duplicated into every `class_signature` chunk | `1692cfa` | 15,710 → 7,658 tokens, **51.3%**, no file larger, nothing persisted changed |
| BM25 weights landed one column left of what the call read like, wasting the largest weight on an `UNINDEXED` column | `659e436` | Rewritten explicitly and identically; the intuitive correction measured as a regression and is now documented as such |
| The control arm scored stale indexes silently, unlike the hybrid runner | `659e436` | Integrity preflight added |
| The comparison protocol had no check for the index, so committing a new module invalidated the comparison it was committed for | `d6f5991` | `indexSize` recorded, check added with its evidence |
| `getFileSkeleton` returned SQLite `NULL` under a `string \| undefined` declaration | `1692cfa` | Found by the gate on its first run; the declarations now say what they return |

Two of those were found by the project's own guards rather than by reading code,
which is worth recording: the quality gate crashed on the null, and the hybrid
runner refused to score a stale index. The control arm had neither check, and got
one.
