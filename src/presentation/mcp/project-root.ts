import * as fs from 'fs';
import * as path from 'path';

/** Identifies the trusted launch context from which an MCP root was resolved. */
export type McpProjectRootSource = 'claude-project-dir' | 'working-directory';

/** A root accepted for one MCP server process. */
export interface McpProjectRoot {
  /** Canonical, absolute directory that will be pinned for the process lifetime. */
  readonly rootDir: string;
  /** Trusted launch context that named the directory. */
  readonly source: McpProjectRootSource;
}

/**
 * Resolves the repository that a globally registered MCP process may serve.
 *
 * A global configuration deliberately has no repository path baked into it.
 * Claude Code supplies `CLAUDE_PROJECT_DIR` to its server process; other
 * clients can launch the process from their active project directory. Neither
 * value comes from an MCP tool call, so the root remains fixed before any
 * Umbra capability is published.
 *
 * @param environment - Process environment, injectable for deterministic tests.
 * @param workingDirectory - Process working directory, injectable for tests.
 * @returns A validated, canonical project root.
 * @throws {Error} When the launch context does not name an Umbra-compatible project.
 */
export function resolveMcpProjectRoot(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
): McpProjectRoot {
  const claudeProjectDir = environment.CLAUDE_PROJECT_DIR?.trim();
  if (claudeProjectDir !== undefined && claudeProjectDir.length > 0) {
    return {
      rootDir: validateProjectRoot(claudeProjectDir, 'CLAUDE_PROJECT_DIR'),
      source: 'claude-project-dir',
    };
  }

  return {
    rootDir: validateProjectRoot(workingDirectory, 'the MCP process working directory'),
    source: 'working-directory',
  };
}

/** Validates a path before it becomes the process-wide, immutable MCP root. */
function validateProjectRoot(candidate: string, source: string): string {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Cannot start global MCP: ${source} is not an existing directory (${resolved}).`);
  }

  const realRoot = fs.realpathSync(resolved);
  if (!looksLikeProject(realRoot)) {
    throw new Error(
      `Cannot start global MCP: ${source} is not a project Umbra can index (${realRoot}). ` +
        'Open Claude/Codex from a repository containing package.json, tsconfig.json, .git, src, or umbra.json.',
    );
  }

  return realRoot;
}

/** Avoids creating `.umbra` in a home directory or another ambiguous launcher directory. */
function looksLikeProject(rootDir: string): boolean {
  const projectMarkers = ['package.json', 'tsconfig.json', 'pnpm-workspace.yaml', 'umbra.json', 'src'];
  if (projectMarkers.some((marker) => fs.existsSync(path.join(rootDir, marker)))) return true;

  const gitPath = path.join(rootDir, '.git');
  return fs.existsSync(gitPath);
}
