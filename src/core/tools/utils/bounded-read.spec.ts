import { boundFileContent, maxReadTokens } from './bounded-read';
import { tokenCounter } from '../../llm/tokens/token-counter';

describe('boundFileContent', () => {
  const line = 'export const value = compute(alpha, beta, gamma);';

  it('returns an ordinary file untouched', () => {
    const content = Array.from({ length: 20 }, () => line).join('\n');

    const bounded = boundFileContent('src/small.ts', content);

    expect(bounded.truncated).toBe(false);
    expect(bounded.content).toBe(content);
    expect(bounded.keptLines).toBe(20);
  });

  it('cuts a file that exceeds the ceiling and keeps the head', () => {
    const content = Array.from({ length: 500 }, (_, i) => `${line} // ${i}`).join('\n');

    const bounded = boundFileContent('src/large.ts', content, 100);

    expect(bounded.truncated).toBe(true);
    expect(bounded.keptLines).toBeLessThan(500);
    expect(bounded.keptLines).toBeGreaterThan(0);
    // The head is what identifies a file and what a targeted re-read is planned from.
    expect(bounded.content.startsWith(`${line} // 0`)).toBe(true);
  });

  it('keeps the kept part within the ceiling', () => {
    const content = Array.from({ length: 500 }, (_, i) => `${line} // ${i}`).join('\n');
    const limit = 100;

    const bounded = boundFileContent('src/large.ts', content, limit);
    const keptText = content.split('\n').slice(0, bounded.keptLines).join('\n');

    expect(tokenCounter().countText(keptText)).toBeLessThanOrEqual(limit);
  });

  it('cuts on a line boundary, never mid-line', () => {
    const content = Array.from({ length: 300 }, (_, i) => `${line} // ${i}`).join('\n');

    const bounded = boundFileContent('src/large.ts', content, 80);
    const body = bounded.content.split('\n--- TRUNCATED')[0].trimEnd();

    for (const kept of body.split('\n')) {
      expect(kept).toMatch(/\/\/ \d+$/);
    }
  });

  // A silent truncation is worse than no ceiling: the model reasons about a
  // file it believes it read whole, and concludes a symbol below the cut is absent.
  it('says what was withheld and warns against concluding absence', () => {
    const content = Array.from({ length: 500 }, (_, i) => `${line} // ${i}`).join('\n');

    const bounded = boundFileContent('src/large.ts', content, 100);

    expect(bounded.content).toContain('TRUNCATED');
    expect(bounded.content).toContain('of 500 lines withheld');
    expect(bounded.content).toContain('do not conclude that a symbol is absent');
    expect(bounded.content).toContain('src/large.ts');
  });

  it('reports the full cost even though it withheld most of it', () => {
    const content = Array.from({ length: 500 }, (_, i) => `${line} // ${i}`).join('\n');

    const bounded = boundFileContent('src/large.ts', content, 100);

    expect(bounded.totalTokens).toBeGreaterThan(100);
    expect(bounded.totalLines).toBe(500);
  });

  it('handles an empty file without truncating or throwing', () => {
    const bounded = boundFileContent('src/empty.ts', '');

    expect(bounded.truncated).toBe(false);
    expect(bounded.totalTokens).toBe(0);
  });
});

describe('maxReadTokens', () => {
  const original = process.env.UMBRA_MAX_READ_TOKENS;

  afterEach(() => {
    if (original === undefined) delete process.env.UMBRA_MAX_READ_TOKENS;
    else process.env.UMBRA_MAX_READ_TOKENS = original;
  });

  it('defaults when unset', () => {
    delete process.env.UMBRA_MAX_READ_TOKENS;
    expect(maxReadTokens()).toBe(6_000);
  });

  it('honours a positive override', () => {
    process.env.UMBRA_MAX_READ_TOKENS = '1200';
    expect(maxReadTokens()).toBe(1200);
  });

  it('ignores a value that is not a positive integer, rather than disabling the ceiling', () => {
    process.env.UMBRA_MAX_READ_TOKENS = 'lots';
    expect(maxReadTokens()).toBe(6_000);

    process.env.UMBRA_MAX_READ_TOKENS = '0';
    expect(maxReadTokens()).toBe(6_000);

    process.env.UMBRA_MAX_READ_TOKENS = '-5';
    expect(maxReadTokens()).toBe(6_000);
  });
});
