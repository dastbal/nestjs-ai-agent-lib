import { ADR_INDEX_URI, buildResourceCatalog, INDEX_STATUS_URI } from './resource-catalog';

describe('MCP index-status resource', () => {
  it('returns the supplied live lifecycle status instead of a stale snapshot', () => {
    const resources = buildResourceCatalog('C:\\fixture', () => 'state: indexing\nfiles: 12/52');
    const status = resources.find((resource) => resource.descriptor.uri === INDEX_STATUS_URI);

    expect(status?.read()).toEqual({
      uri: INDEX_STATUS_URI,
      mimeType: 'text/plain',
      text: 'state: indexing\nfiles: 12/52',
    });
  });

  it('does not read a working directory while the client root is still unknown', () => {
    const resources = buildResourceCatalog(() => undefined, () => 'state: awaiting-root');
    const adrs = resources.find((resource) => resource.descriptor.uri === ADR_INDEX_URI);
    const status = resources.find((resource) => resource.descriptor.uri === INDEX_STATUS_URI);

    expect(adrs?.read().text).toContain('has not received one validated project root');
    expect(status?.read().text).toBe('state: awaiting-root');
  });
});
