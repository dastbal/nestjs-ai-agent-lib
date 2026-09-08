/**
 * @module RetrievalMetrics
 *
 * Pure scoring for the retrieval-quality corpus. No I/O, no provider calls.
 *
 * ## Why this lives in `src/` rather than beside the benchmark script
 * The scoring rule is the one thing in an evaluation that must not drift
 * silently. A number that moved because the metric changed, rather than
 * because retrieval changed, is worse than no number at all: it reads as
 * progress. Placing it here puts it under `type-check` and under the jest
 * suite, so a change to the rule has to survive a test the same way a change
 * to `RetrieverService` does.
 *
 * ## Why the aggregate separates four things the previous runner fused
 * The audit runner in `.agents/skills/umbra-embedding-retrieval-audit` scored
 * every case into one `hitAt4` average, which made three distinct failures
 * indistinguishable:
 *
 * 1. A positive case that returned four **wrong** paths.
 * 2. A positive case that **abstained** — the false abstention
 *    [ADR-028](../../../docs/adr/ADR-028-hybrid-retrieval-requires-evidence.md)
 *    accepted as a trade-off and required to be measured before release.
 * 3. A negative case that correctly abstained.
 *
 * The first two are opposite defects and are fixed by opposite changes: a
 * wrong path means ranking, an abstention means the evidence policy is too
 * strict. Averaging them together hides which lever to pull.
 *
 * It also aggregates per split. The holdout existed in the corpus and was
 * being folded into the headline number, which destroys the property a
 * holdout is for.
 */

/** One corpus case, as stored in `docs/benchmarks/embedding-retrieval-corpus.json`. */
export interface RetrievalCorpusCase {
  readonly id: string;
  /** `calibration` is iterated on freely; `holdout` is read once, before a release. */
  readonly split: string;
  readonly query: string;
  /** Empty means the correct answer is an abstention — the feature does not exist. */
  readonly expectedPaths: readonly string[];
}

/** What a single case did when it was run against a live retriever. */
export interface RetrievalCaseOutcome {
  readonly id: string;
  readonly split: string;
  /** `path` when the corpus expects source, `abstain` when it expects silence. */
  readonly expectation: 'path' | 'abstain';
  /** Paths the tool actually returned, in rank order. */
  readonly returnedPaths: readonly string[];
  readonly abstained: boolean;
  /** 1 when a positive case found an expected path inside the returned set, else 0. */
  readonly hit: number;
  /** `1 / rank` of the first expected path, else 0. */
  readonly reciprocalRank: number;
  /**
   * A positive case that returned nothing. Distinct from `hit: 0`, which also
   * covers a case that confidently returned four wrong files.
   */
  readonly falseAbstention: boolean;
  /** A negative case that returned source for a feature that does not exist. */
  readonly falsePositive: boolean;
  readonly elapsedMs: number;
}

/** Aggregate over one split, or over the whole run. */
export interface RetrievalSplitSummary {
  readonly split: string;
  readonly positives: number;
  readonly negatives: number;
  /** Share of positive cases whose expected path appeared. `null` with no positives. */
  readonly hitRate: number | null;
  /** Mean reciprocal rank over positive cases only. `null` with no positives. */
  readonly mrr: number | null;
  /**
   * Share of positive cases that returned nothing at all — the ADR-028 debt.
   * `null` with no positives.
   */
  readonly falseAbstentionRate: number | null;
  /**
   * Share of negative cases that correctly returned nothing. `null` with no
   * negatives, which is itself a finding: the abstention policy is unmeasured.
   */
  readonly correctAbstentionRate: number | null;
  readonly medianLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
}

/**
 * Scores one case against its corpus expectation.
 *
 * A path matches when the returned path **ends with** an expected path, so a
 * corpus written in repository-relative terms scores correctly against an
 * absolute path emitted by the tool. Separators are normalised to `/` by the
 * caller before this point.
 *
 * @param corpusCase - The expectation.
 * @param returnedPaths - Paths the tool returned, in rank order.
 * @param elapsedMs - Wall clock for the single call.
 * @returns The outcome, with the two abstention defects reported separately.
 */
export function scoreCase(
  corpusCase: RetrievalCorpusCase,
  returnedPaths: readonly string[],
  elapsedMs: number,
): RetrievalCaseOutcome {
  const abstained = returnedPaths.length === 0;
  const expectsPath = corpusCase.expectedPaths.length > 0;

  if (!expectsPath) {
    return {
      id: corpusCase.id,
      split: corpusCase.split,
      expectation: 'abstain',
      returnedPaths,
      abstained,
      hit: abstained ? 1 : 0,
      reciprocalRank: abstained ? 1 : 0,
      falseAbstention: false,
      falsePositive: !abstained,
      elapsedMs,
    };
  }

  const rank = returnedPaths.findIndex((candidate) =>
    corpusCase.expectedPaths.some((expected) => candidate.endsWith(expected)),
  );

  return {
    id: corpusCase.id,
    split: corpusCase.split,
    expectation: 'path',
    returnedPaths,
    abstained,
    hit: rank === -1 ? 0 : 1,
    reciprocalRank: rank === -1 ? 0 : 1 / (rank + 1),
    falseAbstention: abstained,
    falsePositive: false,
    elapsedMs,
  };
}

/**
 * Aggregates outcomes belonging to one split.
 *
 * Every rate is `null` rather than `0` when its denominator is empty. The
 * distinction matters: a `correctAbstentionRate` of 0 means the policy failed
 * every negative case, while `null` means the split contains no negative case
 * and the policy was never tested. Reporting the second as the first is how an
 * unmeasured trade-off reads as a measured one.
 *
 * @param split - The split label these outcomes belong to.
 * @param outcomes - Outcomes for that split.
 * @returns The summary.
 */
export function summarizeSplit(
  split: string,
  outcomes: readonly RetrievalCaseOutcome[],
): RetrievalSplitSummary {
  const positives = outcomes.filter((outcome) => outcome.expectation === 'path');
  const negatives = outcomes.filter((outcome) => outcome.expectation === 'abstain');

  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

  const latencies = outcomes.map((outcome) => outcome.elapsedMs).sort((a, b) => a - b);

  return {
    split,
    positives: positives.length,
    negatives: negatives.length,
    hitRate: mean(positives.map((outcome) => outcome.hit)),
    mrr: mean(positives.map((outcome) => outcome.reciprocalRank)),
    falseAbstentionRate: mean(positives.map((outcome) => (outcome.falseAbstention ? 1 : 0))),
    correctAbstentionRate: mean(negatives.map((outcome) => (outcome.abstained ? 1 : 0))),
    medianLatencyMs:
      latencies.length === 0 ? null : latencies[Math.floor((latencies.length - 1) / 2)],
    p95LatencyMs: latencies.length === 0 ? null : latencies[Math.ceil(latencies.length * 0.95) - 1],
  };
}

/**
 * Groups outcomes by their split and summarizes each one, plus an `all` row.
 *
 * Splits are returned in the order they first appear, with `all` last, so a
 * report reads calibration first and never leads with a number that mixes the
 * holdout into it.
 *
 * @param outcomes - Every outcome from one provider run.
 * @returns One summary per split, followed by the combined summary.
 */
export function summarizeRun(outcomes: readonly RetrievalCaseOutcome[]): RetrievalSplitSummary[] {
  const bySplit = new Map<string, RetrievalCaseOutcome[]>();
  for (const outcome of outcomes) {
    const bucket = bySplit.get(outcome.split);
    if (bucket) bucket.push(outcome);
    else bySplit.set(outcome.split, [outcome]);
  }

  const summaries = [...bySplit.entries()].map(([split, bucket]) => summarizeSplit(split, bucket));
  summaries.push(summarizeSplit('all', outcomes));
  return summaries;
}
