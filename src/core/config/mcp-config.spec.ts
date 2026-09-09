import * as fs from 'fs';
import * as path from 'path';

import * as mcpConfig from './mcp-config';
import {
  buildGlobalUmbraMcpServer,
  globalClaudeMcpCommand,
} from './mcp-config';

describe('MCP configuration adapters', () => {
  it('builds a global entry that resolves a project at MCP launch rather than storing one root', () => {
    expect(buildGlobalUmbraMcpServer()).toEqual({
      type: 'stdio',
      command: 'umbra',
      args: ['mcp', '--auto-root'],
    });
  });

  it('uses Claude Code\'s documented cmd wrapper for the global Windows CLI', () => {
    expect(globalClaudeMcpCommand('win32')).toEqual([
      'cmd', '/c', 'umbra', 'mcp', '--auto-root',
    ]);
    expect(globalClaudeMcpCommand('linux')).toEqual([
      'umbra', 'mcp', '--auto-root',
    ]);
  });

  it('does not expose a project-local .mcp.json writer', () => {
    expect(mcpConfig).not.toHaveProperty('ensureUmbraMcpConfiguration');
    expect(mcpConfig).not.toHaveProperty('configureCodexMcp');
  });

  it('ships CLI startup dependencies in the production manifest', () => {
    const manifestPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.['@modelcontextprotocol/sdk']).toBe('1.30.0');
    expect(manifest.dependencies?.typescript).toBe('5.9.3');
  });

});
