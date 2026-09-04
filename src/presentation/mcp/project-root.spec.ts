import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveMcpProjectRoot } from './project-root';

describe('resolveMcpProjectRoot', () => {
  let projectRoot: string;
  let nonProjectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-mcp-project-'));
    nonProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-mcp-non-project-'));
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"fixture"}', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(nonProjectRoot, { recursive: true, force: true });
  });

  it('prefers Claude Code\'s project directory over the process directory', () => {
    expect(resolveMcpProjectRoot({ CLAUDE_PROJECT_DIR: projectRoot }, nonProjectRoot)).toEqual({
      rootDir: fs.realpathSync(projectRoot),
      source: 'claude-project-dir',
    });
  });

  it('uses a validated working directory for clients that launch from the project', () => {
    expect(resolveMcpProjectRoot({}, projectRoot)).toEqual({
      rootDir: fs.realpathSync(projectRoot),
      source: 'working-directory',
    });
  });

  it('refuses an invalid Claude project directory instead of falling back to another directory', () => {
    expect(() => resolveMcpProjectRoot({ CLAUDE_PROJECT_DIR: nonProjectRoot }, projectRoot))
      .toThrow(/CLAUDE_PROJECT_DIR is not a project/);
  });

  it('refuses an ambiguous working directory before creating a workspace there', () => {
    expect(() => resolveMcpProjectRoot({}, nonProjectRoot))
      .toThrow(/working directory is not a project/);
  });
});
