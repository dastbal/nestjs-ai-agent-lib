# Retrieval benchmark results

Every run of `npm run bench:retrieval` writes one JSON report here, and **the
report is committed**. That is the whole point of the directory.

A single number in prose — *"30% Hit@4"*, as recorded in ADR-027 and ADR-028 —
proves that a measurement happened once. It cannot show that a change helped,
because there is nothing to compare it against. A committed series can, and it
is the difference between *"I improved the retriever"* and *"the retriever
improves by this much, on these cases, and here is the run that says so"*.

## Naming

`YYYY-MM-DD-<providers>-<split>.json`, written by the script. Two runs on the
same day with the same providers and split overwrite each other on purpose:
the report records a state of the repository, not an attempt.

## Reading a report

`providers[].summaries` is a table with one row per split plus an `all` row.
**Never quote the `all` row as the headline** — it fuses the calibration split
with the holdout, which is what a holdout exists to prevent.

| Field | What it answers |
|---|---|
| `hitRate` | Of the cases that *should* find a file, how many did — over positives only. |
| `mrr` | How near the top the right file landed. |
| `falseAbstentionRate` | How many positives returned **nothing**. The trade-off ADR-028 accepted and left unmeasured. |
| `correctAbstentionRate` | How many negatives correctly stayed silent. |
| `p95LatencyMs` | Tail latency of one `ask_codebase` round trip. |

A `null` is not a zero. `correctAbstentionRate: null` means the split held no
negative case, so the abstention policy was **not tested** — a different claim
from "it failed every case", and the one that hid the gap until now.

## The holdout

`--split holdout` refuses to run without `--allow-holdout`. Read it once,
before a release, and commit the report. If it starts appearing weekly it has
stopped being a holdout and the corpus needs new unseen cases.

## Related

- `docs/benchmarks/embedding-retrieval-corpus.json` — the corpus.
- `scripts/bench-retrieval.mjs` — the runner.
- `src/core/rag/retrieval-metrics.ts` — the scoring rule, under test.
- `docs/adr/ADR-031-measure-before-building.md` — why this exists.
