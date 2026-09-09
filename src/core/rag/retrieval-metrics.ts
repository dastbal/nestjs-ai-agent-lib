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
  /**
   * Marks a negative that term absence cannot prove, and is expected not to.
   *
   * `negative-redis` asks where Redis is used as the vector store. The word
   * `redis` genuinely appears in this repository, so nothing about the question
   * is absent; telling "mentioned" from "used as" needs more than term
   * presence. That is a fair hard case, not corpus rot, and the health check
   * must be able to tell the two apart or it cries wolf every run.
   */
  readonly unprovableByAbsence?: boolean;
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

/** What share of a corpus the index could answer at all, before ranking. */
export interface CorpusCoverage {
  /** Distinct paths the corpus expects to be findable. */
  readonly expectedPaths: number;
  /** How many of those have at least one chunk in the index. */
  readonly coveredPaths: number;
  /** The expected paths with no chunk, sorted, for the report. */
  readonly missingPaths: readonly string[];
  /** Positive cases whose every expected path is missing — unhittable by construction. */
  readonly unreachableCases: readonly string[];
  /**
   * The highest hit rate ranking could possibly achieve on these cases.
   * `1` when the index covers every expectation.
   */
  readonly reachableHitCeiling: number;
}

/**
 * Reports how much of the corpus the index can answer before ranking is involved.
 *
 * ## Why a benchmark without this reports the wrong thing
 * A positive case whose target file has no chunk cannot be hit by any
 * retriever, however good. Folded into a hit rate it is indistinguishable from
 * a ranking failure, and the resulting number measures index coverage while
 * appearing to measure retrieval quality — so the obvious response, tuning the
 * ranking, cannot move it.
 *
 * This is not hypothetical for this repository. The 30% Hit@4 recorded in
 * ADR-027 and ADR-028 was taken before `fix(rag): index classless source
 * modules`, when function-only modules such as `math.ts`, `hybrid-ranking.ts`
 * and `embeddings-resolver.ts` produced no chunk at all. Many corpus positives
 * pointed straight at them.
 *
 * Paths are compared by suffix on `/`-normalised strings, so a corpus written
 * relative to the repository matches an index that stores either separator.
 *
 * @param cases - The corpus cases about to be run.
 * @param indexedPaths - Every distinct file path that has at least one chunk.
 * @returns The coverage assessment.
 */
export function assessCorpusCoverage(
  cases: readonly RetrievalCorpusCase[],
  indexedPaths: readonly string[],
): CorpusCoverage {
  const normalise = (value: string): string => value.split('\\').join('/');
  const indexed = indexedPaths.map(normalise);

  const isCovered = (expected: string): boolean => {
    const target = normalise(expected);
    return indexed.some((candidate) => candidate.endsWith(target));
  };

  const expected = new Set<string>();
  for (const corpusCase of cases) {
    for (const expectedPath of corpusCase.expectedPaths) expected.add(normalise(expectedPath));
  }

  const missingPaths = [...expected].filter((candidate) => !isCovered(candidate)).sort();

  const positives = cases.filter((corpusCase) => corpusCase.expectedPaths.length > 0);
  const unreachableCases = positives
    .filter((corpusCase) => !corpusCase.expectedPaths.some(isCovered))
    .map((corpusCase) => corpusCase.id);

  return {
    expectedPaths: expected.size,
    coveredPaths: expected.size - missingPaths.length,
    missingPaths,
    unreachableCases,
    reachableHitCeiling:
      positives.length === 0 ? 1 : (positives.length - unreachableCases.length) / positives.length,
  };
}

/** Whether the negative cases can still prove anything about abstention. */
export interface NegativeHealth {
  readonly negatives: number;
  /** Negatives with at least one term the index has never contained. */
  readonly provable: number;
  /** Ids of negatives that lost their absent term, sorted. */
  readonly rotted: readonly string[];
  /** Ids of negatives declared unprovable by absence on purpose. */
  readonly knownHard: readonly string[];
}

/**
 * Reports whether the negative cases still test anything.
 *
 * ## Why a negative rots, and why it does so silently
 *
 * A negative case only works while the repository stays ignorant of its
 * subject, and ordinary work destroys that. Measured twice on this project, by
 * the same mistake: a negative case about a monitoring product stopped being a
 * negative because the TSDoc written to *explain the defect it proved* named
 * the product. The repository then contained the word, the abstention rule
 * correctly reported it as known, and the case quietly stopped asking anything.
 * The second time was in this very comment, and this check caught it on the
 * next run — which is the argument for the check, made at its own expense.
 *
 * The rule that follows: describe such a case by shape, never by its term.
 * Anything written here is indexed source.
 *
 * This is the mirror of {@link assessCorpusCoverage}: that one refuses to let a
 * hit rate be read when the index cannot answer the positives, and this one
 * refuses to let an abstention rate be read when the negatives have stopped
 * asking anything.
 *
 * @param cases - The negative cases about to be run; positives are ignored.
 * @param unknownTermsOf - Terms of a case that the index does not contain.
 * @returns The health assessment.
 */
export function assessNegativeHealth(
  cases: readonly RetrievalCorpusCase[],
  unknownTermsOf: (corpusCase: RetrievalCorpusCase) => readonly string[],
): NegativeHealth {
  const negatives = cases.filter((corpusCase) => corpusCase.expectedPaths.length === 0);

  const knownHard = negatives
    .filter((corpusCase) => corpusCase.unprovableByAbsence === true)
    .map((corpusCase) => corpusCase.id)
    .sort();

  const rotted = negatives
    .filter((corpusCase) => corpusCase.unprovableByAbsence !== true)
    .filter((corpusCase) => unknownTermsOf(corpusCase).length === 0)
    .map((corpusCase) => corpusCase.id)
    .sort();

  return {
    negatives: negatives.length,
    provable: negatives.length - rotted.length - knownHard.length,
    rotted,
    knownHard,
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
