# Retrieval benchmark results

Every run of `npm run bench:retrieval` writes one JSON report here, and **the
report is committed**. That is the whole point of the directory.

A single number in prose — *"30% Hit@4"*, as recorded in ADR-027 and ADR-028 —
proves that a measurement happened once. It cannot show that a change helped,
because there is nothing to compare it against. A committed series can, and it
is the difference between *"I improved the retriever"* and *"the retriever
improves by this much, on these cases, and here is the run that says so"*.

## Naming

`YYYY-MM-DD-<providers>-<split>-<commit>[-dirty].json`, written by the script.

The commit is not decoration. The first two reports here were named by date,
providers and split alone, which had two consequences within a day: a second
run overwrote the first, and the two that survived were taken at **different
commits** — one before an abstention fix and one after — while sitting side by
side in a directory that invites comparison. A number whose code state cannot
be recovered is an anecdote with a schema.

`-dirty` means the working tree had uncommitted changes. That is recorded
rather than refused, because benchmarking mid-change is often the point; it just
must not later be mistaken for a run of the commit it sits on.

The two reports from 2026-09-08 predate the field and carry a
`provenanceNote` saying where their commit was reconstructed from.

## Reading a report

`providers[].summaries` is a table with one row per split plus an `all` row.
**Never quote the `all` row as the headline** — it fuses the calibration split
with the holdout, which is what a holdout exists to prevent.

| Field | What it answers |
|---|---|
| `hitRate` | Of the cases that *should* find a file, how many did — over positives only. |
| `mrr` | How near the top the right file landed. |
| `falseAbstentionRate` | How many positives returned **nothing**. |
| `correctAbstentionRate` | How many negatives correctly stayed silent. |
| `p95LatencyMs` | Tail latency of one `ask_codebase` round trip. |

A `null` is not a zero. `correctAbstentionRate: null` means the split held no
negative case, so the abstention policy was **not tested** — a different claim
from "it failed every case", and the one that hid the gap ADR-031 was written
about.

## The two preflights, and why a number without them is unreadable

Both are stored in the report and printed before the table.

**`coverage`** — how many of the corpus's expected paths the index actually
holds chunks for, and the `reachableHitCeiling` that follows. A positive whose
target file has no chunk cannot be hit by any retriever; folded into a hit rate
it is indistinguishable from a ranking failure. The historical 30% was measured
under a ceiling of roughly 44%, so it never measured retrieval quality at all.

**`negativeHealth`** — how many negatives still name something absent from the
repository. A negative only works while the repository stays ignorant of its
subject, and ordinary work destroys that silently: on this project a negative
died twice, both times because a comment written to *explain the defect that
case proved* named the term. `rotted` lists cases that lost their absent term
and now prove nothing; `knownHard` lists cases marked `unprovableByAbsence` in
the corpus, which are difficult on purpose and are not rot.

## The holdout

`--split holdout` refuses to run without `--allow-holdout`. Read it once,
before a release, and commit the report. If it starts appearing weekly it has
stopped being a holdout and the corpus needs new unseen cases.

## Comparing two reports

Check, in this order, before believing a difference:

1. Same `corpusVersion`. Different versions are not comparable case-for-case.
2. Same `coverage.reachableHitCeiling`. A moved ceiling explains a moved hit
   rate on its own.
3. Same `negativeHealth.provable`. A rotted negative raises the correct
   abstention rate for free.
4. Then, and only then, the difference is about retrieval — and `commit` tells
   you which change to credit.

## The control arm, and the one comparison it does not support

`npm run bench:fts-only` writes a second kind of report here, named the same way
with `fts-only` in the providers slot. It scores the same corpus with the
semantic branch removed, which is how *what do the vectors actually buy?* gets an
answer instead of an opinion. The embedding apparatus is not free — the launch
probe, the stamp, the writer lease, the per-identity vector rows and the
reindex-on-model-change all exist to keep vectors consistent — and a number that
says they buy two points is a different roadmap from one that says twenty.

It reports **two arms**, because switching the vectors off changes two things at
once. `policy` is `hasGroundedEvidence` as it ships, and with no semantic ranking
the `hybrid` evidence class is unreachable, so grounding can only come from
`lexicalExact`: abstention gets stricter by omission rather than by decision.
`ranking` lifts that gate, isolating ranking quality from the policy side effect.
Quoting only `policy` credits the vectors for an artefact of the abstention rule.

**Never compare its latency against a `bench-retrieval` report.** The control arm
runs in-process and pays no transport, no readiness gate and no query embedding;
the report's `latencyExcludes` field lists exactly what is missing. Its hit rate
*is* comparable — same corpus, same compiled ranking modules, same coverage
preflight — and its milliseconds are not.

## Related

- `docs/benchmarks/embedding-retrieval-corpus.json` — the corpus.
- `scripts/bench-retrieval.mjs` — the runner.
- `scripts/bench-fts-only.mjs` — the control arm.
- `src/core/rag/retrieval-metrics.ts` — the scoring rule, under test.
- `docs/adr/ADR-031-measure-before-building.md` — why this exists.
