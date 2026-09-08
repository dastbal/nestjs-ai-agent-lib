import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { ContextCompressor } from './context-compressor';

describe('ContextCompressor.estimateTokens', () => {
  it('counts nothing for an empty history', () => {
    expect(ContextCompressor.estimateTokens([])).toBe(0);
    expect(ContextCompressor.estimateTokens(undefined as unknown as unknown[])).toBe(0);
  });

  // The defect ADR-031 phase 2 corrects: a turn that called a tool with a large
  // payload carried it in `tool_calls`, not `content`, so the budget guard saw
  // a turn that cost almost nothing.
  it('charges a tool call whose arguments are large but whose content is empty', () => {
    const writingTurn = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          name: 'safe_write_file',
          args: { file_path: 'src/big.ts', content: 'export const x = 1;\n'.repeat(500) },
        },
      ],
    });

    expect(ContextCompressor.estimateTokens([writingTurn])).toBeGreaterThan(1_000);
  });

  it('adds the system prompt and tool schemas when the caller knows them', () => {
    const messages = [new HumanMessage('where is the retriever?')];

    const bare = ContextCompressor.estimateTokens(messages);
    const withOverhead = ContextCompressor.estimateTokens(messages, {
      system: 'You are Umbra. '.repeat(200),
      tools: [{ name: 'ask_codebase', schema: { type: 'object' } }],
    });

    expect(withOverhead).toBeGreaterThan(bare + 300);
  });
});

describe('ContextCompressor.isOverBudget', () => {
  const original = process.env.MAX_CONTEXT_TOKENS;

  afterEach(() => {
    if (original === undefined) delete process.env.MAX_CONTEXT_TOKENS;
    else process.env.MAX_CONTEXT_TOKENS = original;
  });

  it('is false for a short conversation under the default budget', () => {
    delete process.env.MAX_CONTEXT_TOKENS;
    expect(ContextCompressor.isOverBudget([new HumanMessage('hola')])).toBe(false);
  });

  it('honours an explicit budget', () => {
    process.env.MAX_CONTEXT_TOKENS = '10';
    expect(ContextCompressor.isOverBudget([new HumanMessage('a '.repeat(200))])).toBe(true);
  });

  it('ignores a budget that is not a positive integer', () => {
    process.env.MAX_CONTEXT_TOKENS = 'plenty';
    expect(ContextCompressor.isOverBudget([new HumanMessage('hola')])).toBe(false);
  });

  it('passes the overhead through, so schemas can push a request over the line', () => {
    process.env.MAX_CONTEXT_TOKENS = '200';
    const messages = [new HumanMessage('hola')];

    expect(ContextCompressor.isOverBudget(messages)).toBe(false);
    expect(
      ContextCompressor.isOverBudget(messages, { system: 'You are Umbra. '.repeat(200) }),
    ).toBe(true);
  });
});
