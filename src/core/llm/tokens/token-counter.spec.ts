import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { LocalTokenCounter } from './token-counter';
import { requestTextOf, textOfContent, toolCallArgumentsOf } from './request-shape';

describe('LocalTokenCounter', () => {
  const counter = new LocalTokenCounter();

  it('uses a real encoder rather than a character ratio', () => {
    expect(counter.identity).toEqual({
      method: 'bpe',
      encoding: 'cl100k_base',
      source: 'encoder',
    });
  });

  it('disagrees with chars/4 by enough to matter at a budget threshold', () => {
    const line = 'export function cosineSimilarity(vecA: ArrayLike<number>): number {}';

    const bpe = counter.countText(line);
    const heuristic = Math.ceil(line.length / 4);

    expect(bpe).toBe(14);
    expect(heuristic).toBe(17);
    // >20% apart on one ordinary line of this repository's own source.
    expect(Math.abs(bpe - heuristic) / bpe).toBeGreaterThan(0.2);
  });

  it('counts nothing as nothing', () => {
    expect(counter.countText('')).toBe(0);
  });

  // The whole reason this module exists: the previous estimate summed message
  // content and therefore charged nothing for the two largest fixed costs.
  it('counts the system prompt and tool schemas, which message content never included', () => {
    const messagesOnly = counter.countRequest({
      messages: [new HumanMessage('where is the retriever?')],
    });

    const wholeRequest = counter.countRequest({
      system: 'You are Umbra, a read-only knowledge server. '.repeat(20),
      tools: [
        {
          name: 'ask_codebase',
          description: 'Answers a question about the indexed repository.',
          schema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
      messages: [new HumanMessage('where is the retriever?')],
    });

    expect(messagesOnly.system).toBe(0);
    expect(messagesOnly.toolSchemas).toBe(0);

    expect(wholeRequest.system).toBeGreaterThan(100);
    expect(wholeRequest.toolSchemas).toBeGreaterThan(10);
    expect(wholeRequest.total).toBeGreaterThan(messagesOnly.total);
  });

  it('counts tool-call arguments, which live outside message content', () => {
    const withArguments = new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          name: 'write_file',
          args: { path: 'src/index.ts', contents: 'x'.repeat(4000) },
        },
      ],
    });

    const count = counter.countRequest({ messages: [withArguments] });

    // Content is empty, so the old estimate would have charged this turn ~0.
    expect(count.messages).toBe(0);
    expect(count.toolCallArguments).toBeGreaterThan(500);
    expect(count.total).toBeGreaterThan(500);
  });

  it('charges per-message framing, so many short messages are not undercounted', () => {
    const one = counter.countRequest({ messages: [new HumanMessage('hi')] });
    const ten = counter.countRequest({
      messages: Array.from({ length: 10 }, () => new HumanMessage('hi')),
    });

    expect(one.framing).toBe(3);
    expect(ten.framing).toBe(30);
  });

  it('breaks the total down so a caller can see where the tokens went', () => {
    const count = counter.countRequest({
      system: 'system prompt',
      tools: [{ name: 'ls', schema: { type: 'object' } }],
      messages: [
        new HumanMessage('read the config'),
        new AIMessage({ content: '', tool_calls: [{ id: '1', name: 'ls', args: { path: '.' } }] }),
        new ToolMessage({ content: 'src\npackage.json', tool_call_id: '1' }),
      ],
    });

    expect(count.total).toBe(
      count.system + count.toolSchemas + count.messages + count.toolCallArguments + count.framing,
    );
    expect(count.toolCallArguments).toBeGreaterThan(0);
  });
});

describe('request shape', () => {
  it('reads Gemini array-of-parts content', () => {
    expect(textOfContent([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }])).toBe(
      'hello world',
    );
  });

  // Serializing is wrong in detail; dropping is wrong in direction. An image
  // block occupies the request, and undercounting is what causes an overflow.
  it('serializes a non-text part rather than dropping it', () => {
    expect(textOfContent([{ type: 'image', source: 'data' }])).toContain('image');
  });

  it('reads both the modern and the OpenAI-style tool call shapes', () => {
    const modern = toolCallArgumentsOf({ tool_calls: [{ name: 'ls', args: { path: '.' } }] });
    const legacy = toolCallArgumentsOf({
      additional_kwargs: {
        tool_calls: [{ function: { name: 'ls', arguments: '{"path":"."}' } }],
      },
    });

    expect(modern[0]).toContain('ls');
    expect(legacy[0]).toContain('path');
  });

  it('survives a null or malformed message instead of throwing mid-turn', () => {
    const text = requestTextOf({ messages: [null, undefined, 42, { content: 'real' }] });

    // A message with no readable content contributes no text, but still
    // occupies a slot: `messageCount` drives the framing overhead, so dropping
    // it there would undercount the request.
    expect(text.messages).toEqual(['real']);
    expect(text.messageCount).toBe(4);
  });
});
