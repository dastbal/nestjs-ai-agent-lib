import { buildResourceCatalog, INDEX_STATUS_URI } from './resource-catalog';

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
});
