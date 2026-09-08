import { NestChunker } from './chunker';

describe('NestChunker module fallback', () => {
  it('creates a durable file chunk for a valid classless TypeScript module', () => {
    const source = [
      'export function resolveRoot(input: string): string { return input.trim(); }',
      'export const enabled = true;',
    ].join('\n');

    const result = new NestChunker().analyze('src/project-root.ts', source, 'fixture-hash');

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      type: 'file',
      content: source,
      metadata: { startLine: 1, endLine: 2 },
    });
  });

  it('keeps whitespace-only sources chunkless so the indexer can record an intentional skip', () => {
    const result = new NestChunker().analyze('src/empty.ts', ' \n\t', 'fixture-hash');

    expect(result.chunks).toEqual([]);
  });
});
