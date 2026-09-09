import {
  candidatesFor,
  decideOversizeRoute,
  describeOversizeRoute,
} from './oversize-routing';

describe('candidatesFor', () => {
  it('offers only models whose window is known to hold the request', () => {
    const candidates = candidatesFor(500_000, 'claude-haiku-4-5');

    expect(candidates).not.toContain('claude-haiku-4-5');
    expect(candidates).toContain('claude-sonnet-5');
    // A model this project cannot size is never a destination: routing to an
    // unmeasurable target replaces a known failure with an unknown one.
    expect(candidates).not.toContain('gemini-3.5-flash');
  });

  // The obvious implementation reaches for the biggest window, which from
  // Haiku means Opus — five times the input price for a long request.
  it('ranks by published input price, so the correction stays proportionate', () => {
    const candidates = candidatesFor(500_000, 'claude-haiku-4-5');

    expect(candidates[0]).toBe('claude-sonnet-5');
    expect(candidates.indexOf('claude-sonnet-5')).toBeLessThan(
      candidates.indexOf('claude-opus-5'),
    );
  });

  it('returns nothing when no known window is large enough', () => {
    expect(candidatesFor(50_000_000, 'claude-haiku-4-5')).toEqual([]);
  });
});

describe('decideOversizeRoute', () => {
  // The rule David chose: route only what nobody chose.
  it('never overrides a model typed for this session', () => {
    const decision = decideOversizeRoute({
      model: 'ollama:llama3.2',
      source: 'explicit',
      tokens: 500_000,
    });

    expect(decision.route).toBe(false);
    expect(decision).toHaveProperty('reason', expect.stringContaining('explicitly'));
  });

  // Someone who set AGENT_MODEL chose it just as deliberately.
  it('never overrides AGENT_MODEL', () => {
    const decision = decideOversizeRoute({
      model: 'claude-haiku-4-5',
      source: 'environment',
      tokens: 500_000,
    });

    expect(decision.route).toBe(false);
    expect(decision).toHaveProperty('reason', expect.stringContaining('AGENT_MODEL'));
  });

  it('routes a profile default to the cheapest model that fits', () => {
    const decision = decideOversizeRoute({
      model: 'vertex-anthropic:claude-haiku-4-5',
      source: 'profile',
      tokens: 500_000,
    });

    expect(decision).toEqual({ route: true, to: 'claude-sonnet-5', window: 1_000_000 });
  });

  it('refuses rather than routing when nothing is large enough', () => {
    const decision = decideOversizeRoute({
      model: 'claude-haiku-4-5',
      source: 'profile',
      tokens: 50_000_000,
    });

    expect(decision.route).toBe(false);
    expect(decision).toHaveProperty('reason', expect.stringContaining('large enough'));
  });

  it('strips the provider route before excluding the failed model', () => {
    const decision = decideOversizeRoute({
      model: 'vertex-anthropic:claude-sonnet-5',
      source: 'profile',
      tokens: 900_000,
    });

    // Sonnet itself must not be offered as its own replacement.
    expect(decision).toHaveProperty('to');
    expect((decision as { to: string }).to).not.toBe('claude-sonnet-5');
  });
});

describe('describeOversizeRoute', () => {
  // A model swap changes both the price and the answer. An operator who cannot
  // see it happen cannot reason about either.
  it('names both models, the size, and how to prevent it', () => {
    const line = describeOversizeRoute(
      'claude-haiku-4-5',
      { route: true, to: 'claude-sonnet-5', window: 1_000_000 },
      500_000,
    );

    expect(line).toContain('claude-haiku-4-5');
    expect(line).toContain('claude-sonnet-5');
    expect(line).toContain('500,000');
    expect(line).toContain('--model');
  });
});
