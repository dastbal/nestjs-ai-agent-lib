import { execFileSync } from 'child_process';

/** A JSON object whose values may be arbitrary MCP client configuration. */
type JsonObject = Record<string, unknown>;

/** A locally detectable MCP client with a verified Umbra configuration adapter. */
export type SupportedMcpClient = 'codex' | 'claude';

/** Describes a detected client without changing any consumer configuration. */
export interface DetectedMcpClient {
  /** Client identifier accepted by the setup command. */
  readonly client: SupportedMcpClient;
  /** Executable that was found on PATH. */
  readonly executable: string;
}

/**
 * Returns a client-neutral stdio definition for a user-scoped MCP entry.
 *
 * The root is deliberately absent here. `umbra mcp --auto-root` resolves it
 * from the trusted client launch context and pins it before publishing tools.
 * This lets one user-level registration serve the project currently open in a
 * client without making a shared database outside that project.
 */
export function buildGlobalUmbraMcpServer(): JsonObject {
  return {
    type: 'stdio',
    command: 'umbra',
    args: ['mcp', '--auto-root'],
  };
}

/** Detects only clients whose configuration contract Umbra verifies and owns. */
export function detectSupportedMcpClients(): DetectedMcpClient[] {
  const candidates: readonly DetectedMcpClient[] = [
    { client: 'codex', executable: 'codex' },
    { client: 'claude', executable: 'claude' },
  ];
  return candidates.filter(({ executable }) => executableExists(executable));
}

/** Configures and verifies one user-scoped Codex entry that resolves its root at launch. */
export function configureGlobalCodexMcp(): void {
  const server = buildGlobalUmbraMcpServer();
  execFileSync(
    'codex',
    ['mcp', 'add', 'umbra', '--', server.command as string, ...(server.args as string[])],
    { stdio: 'pipe', windowsHide: true },
  );
  execFileSync('codex', ['mcp', 'get', 'umbra'], { stdio: 'pipe', windowsHide: true });
}

/** Configures and verifies one user-scoped Claude Code entry that resolves its root at launch. */
export function configureGlobalClaudeMcp(): void {
  const command = globalClaudeMcpCommand();
  execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'umbra', '--', ...command], {
    stdio: 'pipe',
    windowsHide: true,
  });
  execFileSync('claude', ['mcp', 'get', 'umbra'], { stdio: 'pipe', windowsHide: true });
}

/** Returns the command passed to Claude Code for its user-scoped Umbra entry. */
export function globalClaudeMcpCommand(platform: NodeJS.Platform = process.platform): string[] {
  const server = buildGlobalUmbraMcpServer();
  const command = [server.command as string, ...(server.args as string[])];
  // Claude Code documents this wrapper for native Windows stdio servers.
  return platform === 'win32' ? ['cmd', '/c', ...command] : command;
}

/** Checks command availability without executing its target client workflow. */
function executableExists(executable: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [executable], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
