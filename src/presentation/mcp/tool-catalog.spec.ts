import { buildToolCatalog } from './tool-catalog';

describe('MCP ask_codebase catalog', () => {
  it('keeps query compatible and publishes optional contextual retry input', () => {
    const tool = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: true, message: 'ready' }),
      readIndexStatus: () => 'ready',
    })
      .find((candidate) => candidate.name === 'ask_codebase');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.query).toBeDefined();
    expect(tool?.inputSchema.context).toBeDefined();
  });

  it('keeps a stable catalog and returns a retryable status while indexing', async () => {
    const tools = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: false, message: 'indexing 23% (12/52 files)' }),
      readIndexStatus: () => 'state: indexing',
    });
    const ask = tools.find((candidate) => candidate.name === 'ask_codebase');
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('ask_codebase');
    expect(names).toContain('get_index_status');
    await expect(ask?.invoke({ query: 'where is this implemented?' })).resolves.toEqual({
      content: [{ type: 'text', text: expect.stringContaining('indexing 23%') }],
      isError: true,
    });
  });

  it('publishes the same index status through a no-argument tool', async () => {
    const status = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: false, message: 'provider unavailable' }),
      readIndexStatus: () => 'state: unavailable\nreason: provider unavailable',
    }).find((candidate) => candidate.name === 'get_index_status');

    await expect(status?.invoke({})).resolves.toEqual({
      content: [{ type: 'text', text: 'state: unavailable\nreason: provider unavailable' }],
    });
  });

  it('keeps the catalog visible but gates root-bound tools until the client supplies a root', async () => {
    const tools = buildToolCatalog({
      semanticSearchReadiness: () => ({ ready: false, message: 'waiting for root' }),
      readIndexStatus: () => 'state: awaiting-root',
      projectRootReady: () => false,
      projectRootMessage: () => 'Open exactly one project and reconnect.',
    });
    const adrs = tools.find((candidate) => candidate.name === 'list_adrs');
    const status = tools.find((candidate) => candidate.name === 'get_index_status');

    await expect(adrs?.invoke({})).resolves.toEqual({
      content: [{ type: 'text', text: expect.stringContaining('Open exactly one project') }],
      isError: true,
    });
    await expect(status?.invoke({})).resolves.toEqual({
      content: [{ type: 'text', text: 'state: awaiting-root' }],
    });
  });
});
