import { HumanMessage } from '@langchain/core/messages';
import { checkContextFit, describeContextOverflow } from './context-fit';
import {
  bareModelId,
  contextWindowFor,
} from '../infrastructure/config/default-context-windows';

describe('bareModelId', () => {
  it('strips a provider route, which does not change what a model can hold', () => {
    expect(bareModelId('vertex-anthropic:claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('strips a dated snapshot suffix', () => {
    expect(bareModelId('vertex-anthropic:claude-haiku-4-5@20251001')).toBe('claude-haiku-4-5');
  });

  it('leaves a bare id alone', () => {
    expect(bareModelId('claude-opus-5')).toBe('claude-opus-5');
  });
});

describe('contextWindowFor', () => {
  it('knows the models this project routes through Vertex', () => {
    expect(contextWindowFor('vertex-anthropic:claude-opus-5')).toBe(1_000_000);
    expect(contextWindowFor('vertex-anthropic:claude-sonnet-5')).toBe(1_000_000);
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000);
  });

  // The lesson DEFAULT_LLM_PRICING already learned: a missing entry once read
  // as a cost of zero. A missing window must not read as "unlimited", which is
  // the same defect pointing the other way.
  it('returns undefined, never a number, for a model it does not know', () => {
    expect(contextWindowFor('gemini-3.5-flash')).toBeUndefined();
    expect(contextWindowFor('ollama:llama3.2')).toBeUndefined();
  });
});

describe('checkContextFit', () => {
  const small = [new HumanMessage('where is the retriever?')];

  it('passes an ordinary request', () => {
    const fit = checkContextFit({ model: 'claude-sonnet-5', messages: small });

    expect(fit.fits).toBe(true);
    expect(fit.window).toBe(1_000_000);
    expect(fit.usedFraction).toBeLessThan(0.001);
  });

  it('refuses a request larger than the window', () => {
    const huge = [new HumanMessage('token '.repeat(300_000))];

    const fit = checkContextFit({ model: 'claude-haiku-4-5', messages: huge });

    expect(fit.fits).toBe(false);
    expect(fit.tokens).toBeGreaterThan(200_000);
    expect(fit.window).toBe(200_000);
  });

  // Refusing a model whose window is unknown would reject every Gemini and
  // Ollama request in the project.
  it('abstains for a model with no known window, and still reports the count', () => {
    const huge = [new HumanMessage('token '.repeat(300_000))];

    const fit = checkContextFit({ model: 'gemini-3.5-flash', messages: huge });

    expect(fit.fits).toBe(true);
    expect(fit.window).toBeUndefined();
    expect(fit.usedFraction).toBeUndefined();
    expect(fit.tokens).toBeGreaterThan(200_000);
  });

  it('counts the system prompt and tool schemas, not only the conversation', () => {
    const bare = checkContextFit({ model: 'claude-haiku-4-5', messages: small });
    const loaded = checkContextFit({
      model: 'claude-haiku-4-5',
      system: 'You are Umbra. '.repeat(500),
      tools: [{ name: 'ask_codebase', schema: { type: 'object' } }],
      messages: small,
    });

    expect(loaded.tokens).toBeGreaterThan(bare.tokens + 1_000);
  });
});

describe('describeContextOverflow', () => {
  it('names the model, both numbers, and the overshoot', () => {
    const text = describeContextOverflow('claude-haiku-4-5', {
      fits: false,
      tokens: 250_000,
      window: 200_000,
      usedFraction: 1.25,
    });

    expect(text).toContain('claude-haiku-4-5');
    expect(text).toContain('250,000');
    expect(text).toContain('200,000');
    expect(text).toContain('50,000 over');
  });

  // "Context length exceeded" leaves the reader to guess whether to compress,
  // switch model, or split the task.
  it('says nothing was charged, and what to do next', () => {
    const text = describeContextOverflow('claude-haiku-4-5', {
      fits: false,
      tokens: 250_000,
      window: 200_000,
    });

    expect(text).toContain('nothing was charged');
    expect(text).toContain('larger window');
  });
});
