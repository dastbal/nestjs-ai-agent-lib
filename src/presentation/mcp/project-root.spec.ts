import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  activateMcpProjectRoot,
  resolveMcpProjectRoot,
} from './project-root';

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

  it('refuses a directory whose only marker is src', () => {
    fs.mkdirSync(path.join(nonProjectRoot, 'src'));

    expect(() => resolveMcpProjectRoot({}, nonProjectRoot))
      .toThrow(/working directory is not a project/);
  });

  it('accepts a Git worktree marker stored as a file', () => {
    fs.rmSync(path.join(projectRoot, 'package.json'));
    fs.writeFileSync(path.join(projectRoot, '.git'), 'gitdir: ../.git/worktrees/fixture\n', 'utf8');

    expect(resolveMcpProjectRoot({}, projectRoot)).toEqual({
      rootDir: fs.realpathSync(projectRoot),
      source: 'working-directory',
    });
  });

  it('refuses an explicitly blocked launch directory even when it has project markers', () => {
    expect(() => resolveMcpProjectRoot({}, projectRoot, { blockedRoots: [projectRoot] }))
      .toThrow(/unsafe launch directory/);
  });

  it('creates one workspace and adds the Umbra ignore rule only after root validation', () => {
    const root = resolveMcpProjectRoot({}, projectRoot);
    const activation = activateMcpProjectRoot(root);

    expect(fs.existsSync(path.join(projectRoot, '.umbra'))).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8')).toContain('.umbra/');
    expect(activation.addedIgnoreRules).toContain('.umbra/');

    expect(activateMcpProjectRoot(root).addedIgnoreRules).toEqual([]);
  });
});
