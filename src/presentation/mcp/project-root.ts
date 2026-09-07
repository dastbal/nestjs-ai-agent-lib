import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AGENT_DIR_NAME, agentPath } from '../../core/config/agent-directory';
import { ensureAgentStateIgnored } from '../../core/config/workspace-scaffold';

/** Identifies the trusted launch context from which an MCP root was resolved. */
export type McpProjectRootSource = 'claude-project-dir' | 'working-directory';

/** A root accepted for one MCP server process. */
export interface McpProjectRoot {
  /** Canonical, absolute directory that will be pinned for the process lifetime. */
  readonly rootDir: string;
  /** Trusted launch context that named the directory. */
  readonly source: McpProjectRootSource;
}

/** Injectable resolution policy for deterministic safety tests. */
export interface McpProjectRootResolutionOptions {
  /** Exact canonical roots that are never safe to activate. */
  readonly blockedRoots?: readonly string[];
}

/** Outcome of creating the durable local state for a validated MCP root. */
export interface McpProjectActivation {
  /** Ignore rules this activation appended to the consumer file. */
  readonly addedIgnoreRules: readonly string[];
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
  options: McpProjectRootResolutionOptions = {},
): McpProjectRoot {
  const blockedRoots = canonicalBlockedRoots(options.blockedRoots);
  const claudeProjectDir = environment.CLAUDE_PROJECT_DIR?.trim();
  if (claudeProjectDir !== undefined && claudeProjectDir.length > 0) {
    return {
      rootDir: validateProjectRoot(claudeProjectDir, 'CLAUDE_PROJECT_DIR', blockedRoots),
      source: 'claude-project-dir',
    };
  }

  return {
    rootDir: validateProjectRoot(workingDirectory, 'the MCP process working directory', blockedRoots),
    source: 'working-directory',
  };
}

/**
 * Creates state only after a trusted root has been selected.
 *
 * `.gitignore` is written first: a failed write must not leave a newly created
 * vector database unignored in a consumer repository.
 */
export function activateMcpProjectRoot(root: McpProjectRoot): McpProjectActivation {
  const addedIgnoreRules = ensureAgentStateIgnored(root.rootDir);
  if (!isUmbraIgnored(root.rootDir)) {
    throw new Error(
      `Cannot activate global MCP for ${root.rootDir}: .gitignore does not safely ignore ${AGENT_DIR_NAME}/.`,
    );
  }

  fs.mkdirSync(agentPath(root.rootDir), { recursive: true });
  return { addedIgnoreRules };
}

/** Validates a path before it becomes the process-wide, immutable MCP root. */
function validateProjectRoot(candidate: string, source: string, blockedRoots: ReadonlySet<string>): string {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Cannot start global MCP: ${source} is not an existing directory (${resolved}).`);
  }

  const realRoot = fs.realpathSync(resolved);
  if (blockedRoots.has(realRoot)) {
    throw new Error(`Cannot start global MCP: ${source} is an unsafe launch directory (${realRoot}).`);
  }
  if (!looksLikeProject(realRoot)) {
    throw new Error(
      `Cannot start global MCP: ${source} is not a project Umbra can index (${realRoot}). ` +
        'Open Claude/Codex from a repository containing package.json, tsconfig.json, .git, pnpm-workspace.yaml, or umbra.json.',
    );
  }

  return realRoot;
}

/** Avoids creating `.umbra` in a home directory or another ambiguous launcher directory. */
function looksLikeProject(rootDir: string): boolean {
  const projectMarkers = ['package.json', 'tsconfig.json', 'pnpm-workspace.yaml', 'umbra.json'];
  if (projectMarkers.some((marker) => isFile(path.join(rootDir, marker)))) return true;

  const gitPath = path.join(rootDir, '.git');
  return fs.existsSync(gitPath) && (fs.statSync(gitPath).isDirectory() || isFile(gitPath));
}

/** Returns the real roots that must never receive automatic MCP state. */
function canonicalBlockedRoots(overrides: readonly string[] | undefined): Set<string> {
  const candidates = overrides ?? [os.homedir(), os.tmpdir()];
  const roots = new Set<string>();

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        roots.add(fs.realpathSync(candidate));
      }
    } catch {
      // A failed canonicalisation cannot make another root trusted.
    }
  }

  return roots;
}

/** Returns whether a marker is an actual file, rather than a misleading directory. */
function isFile(candidate: string): boolean {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Confirms that the just-created or pre-existing ignore file protects `.umbra/`. */
function isUmbraIgnored(rootDir: string): boolean {
  try {
    const rules = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
    return rules.includes(`${AGENT_DIR_NAME}/`) || rules.includes(AGENT_DIR_NAME);
  } catch {
    return false;
  }
}
