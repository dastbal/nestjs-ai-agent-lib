import {
  assessCorpusCoverage,
  scoreCase,
  summarizeRun,
  summarizeSplit,
  type RetrievalCorpusCase,
} from './retrieval-metrics';

const positive: RetrievalCorpusCase = {
  id: 'provider-resolution',
  split: 'calibration',
  query: 'Where does Umbra resolve the active embedding provider?',
  expectedPaths: ['src/core/rag/embeddings/embeddings-resolver.ts'],
};

const negative: RetrievalCorpusCase = {
  id: 'negative-saturn',
  split: 'holdout',
  query: 'Where is the nonexistent Saturn payroll connector configured?',
  expectedPaths: [],
};

describe('scoreCase', () => {
  it('matches an expected path by suffix, so a repo-relative corpus scores an absolute answer', () => {
    const outcome = scoreCase(
      positive,
      ['C:/repos/umbra/src/core/rag/embeddings/embeddings-resolver.ts'],
      10,
    );

    expect(outcome.hit).toBe(1);
    expect(outcome.reciprocalRank).toBe(1);
  });

  it('reports the reciprocal rank of the first expected path, not of the best one', () => {
    const outcome = scoreCase(
      positive,
      ['src/core/rag/retriever.ts', 'src/core/rag/embeddings/embeddings-resolver.ts'],
      10,
    );

    expect(outcome.reciprocalRank).toBeCloseTo(0.5, 10);
  });

  // The defect this whole module exists for: the previous runner collapsed
  // these two into the same `hit: 0`, and they are fixed by opposite changes.
  it('separates a positive that returned wrong paths from one that abstained', () => {
    const wrong = scoreCase(positive, ['src/core/rag/retriever.ts'], 10);
    const silent = scoreCase(positive, [], 10);

    expect(wrong.hit).toBe(0);
    expect(wrong.falseAbstention).toBe(false);

    expect(silent.hit).toBe(0);
    expect(silent.falseAbstention).toBe(true);
  });

  it('scores a negative case as correct only when it returned nothing', () => {
    const abstained = scoreCase(negative, [], 10);
    const invented = scoreCase(negative, ['src/core/config/agent-config.ts'], 10);

    expect(abstained.hit).toBe(1);
    expect(abstained.falsePositive).toBe(false);

    expect(invented.hit).toBe(0);
    expect(invented.falsePositive).toBe(true);
  });

  it('never marks a negative case as a false abstention', () => {
    expect(scoreCase(negative, [], 10).falseAbstention).toBe(false);
  });
});

describe('summarizeSplit', () => {
  it('computes hit rate and MRR over positives only, so negatives cannot inflate them', () => {
    const summary = summarizeSplit('mixed', [
      scoreCase(positive, ['src/core/rag/embeddings/embeddings-resolver.ts'], 5),
      scoreCase({ ...positive, id: 'second' }, ['src/core/rag/retriever.ts'], 5),
      scoreCase({ ...negative, split: 'mixed' }, [], 5),
    ]);

    expect(summary.positives).toBe(2);
    expect(summary.negatives).toBe(1);
    // 1 of 2 positives, not 2 of 3 cases.
    expect(summary.hitRate).toBeCloseTo(0.5, 10);
    expect(summary.correctAbstentionRate).toBe(1);
  });

  // A split with no negatives has not tested the abstention policy. Reporting
  // that as 0 would read as "the policy failed every case", which is the
  // opposite claim.
  it('reports null, not zero, for a rate whose denominator is empty', () => {
    const noNegatives = summarizeSplit('calibration', [
      scoreCase(positive, ['src/core/rag/embeddings/embeddings-resolver.ts'], 5),
    ]);

    expect(noNegatives.correctAbstentionRate).toBeNull();
    expect(noNegatives.hitRate).toBe(1);

    const noPositives = summarizeSplit('negatives-only', [
      scoreCase({ ...negative, split: 'negatives-only' }, [], 5),
    ]);

    expect(noPositives.hitRate).toBeNull();
    expect(noPositives.mrr).toBeNull();
    expect(noPositives.falseAbstentionRate).toBeNull();
  });

  it('measures the false abstention rate ADR-028 declared and left unmeasured', () => {
    const summary = summarizeSplit('calibration', [
      scoreCase(positive, [], 5),
      scoreCase({ ...positive, id: 'b' }, [], 5),
      scoreCase({ ...positive, id: 'c' }, ['src/core/rag/embeddings/embeddings-resolver.ts'], 5),
      scoreCase({ ...positive, id: 'd' }, ['src/core/rag/retriever.ts'], 5),
    ]);

    expect(summary.falseAbstentionRate).toBeCloseTo(0.5, 10);
    // Distinct from the hit rate: one case returned a wrong path rather than silence.
    expect(summary.hitRate).toBeCloseTo(0.25, 10);
  });

  it('returns null latencies for an empty split rather than a misleading zero', () => {
    const summary = summarizeSplit('empty', []);

    expect(summary.medianLatencyMs).toBeNull();
    expect(summary.p95LatencyMs).toBeNull();
  });
});

describe('summarizeRun', () => {
  it('keeps the holdout out of the calibration number and appends a combined row', () => {
    const summaries = summarizeRun([
      scoreCase(positive, ['src/core/rag/embeddings/embeddings-resolver.ts'], 5),
      scoreCase({ ...positive, id: 'held', split: 'holdout' }, ['src/core/rag/retriever.ts'], 5),
      scoreCase(negative, [], 5),
    ]);

    expect(summaries.map((summary) => summary.split)).toEqual([
      'calibration',
      'holdout',
      'all',
    ]);

    const calibration = summaries[0];
    const holdout = summaries[1];
    const all = summaries[2];

    expect(calibration.hitRate).toBe(1);
    expect(holdout.hitRate).toBe(0);
    expect(all.hitRate).toBeCloseTo(0.5, 10);
    expect(all.negatives).toBe(1);
  });
});

describe('assessCorpusCoverage', () => {
  const covered: RetrievalCorpusCase = {
    id: 'covered',
    split: 'calibration',
    query: 'Where is the retriever?',
    expectedPaths: ['src/core/rag/retriever.ts'],
  };
  const uncovered: RetrievalCorpusCase = {
    id: 'uncovered',
    split: 'calibration',
    query: 'Where is cosine similarity computed?',
    expectedPaths: ['src/core/rag/math.ts'],
  };

  it('caps the achievable hit rate by what the index actually holds', () => {
    const coverage = assessCorpusCoverage(
      [covered, uncovered, negative],
      ['src/core/rag/retriever.ts'],
    );

    expect(coverage.expectedPaths).toBe(2);
    expect(coverage.coveredPaths).toBe(1);
    expect(coverage.missingPaths).toEqual(['src/core/rag/math.ts']);
    expect(coverage.unreachableCases).toEqual(['uncovered']);
    // One of two positives can be hit at all, so no retriever can exceed 0.5.
    expect(coverage.reachableHitCeiling).toBeCloseTo(0.5, 10);
  });

  // The live index held both `src\core\rag\retriever.ts` and its forward-slash
  // twin. A comparison that respects the separator reports a covered file as
  // missing on exactly one of the two.
  it('matches regardless of the separator the index stored', () => {
    const coverage = assessCorpusCoverage([covered], ['src\\core\\rag\\retriever.ts']);

    expect(coverage.missingPaths).toEqual([]);
    expect(coverage.reachableHitCeiling).toBe(1);
  });

  it('ignores negatives, which have nothing to cover', () => {
    const coverage = assessCorpusCoverage([negative], []);

    expect(coverage.expectedPaths).toBe(0);
    expect(coverage.unreachableCases).toEqual([]);
    expect(coverage.reachableHitCeiling).toBe(1);
  });

  it('counts a case reachable when any one of its expected paths is indexed', () => {
    const either: RetrievalCorpusCase = {
      id: 'either',
      split: 'calibration',
      query: 'Where is ranking fused?',
      expectedPaths: ['src/core/rag/hybrid-ranking.ts', 'src/core/rag/retriever.ts'],
    };
    const coverage = assessCorpusCoverage([either], ['src/core/rag/retriever.ts']);

    expect(coverage.missingPaths).toEqual(['src/core/rag/hybrid-ranking.ts']);
    expect(coverage.unreachableCases).toEqual([]);
    expect(coverage.reachableHitCeiling).toBe(1);
  });
});
