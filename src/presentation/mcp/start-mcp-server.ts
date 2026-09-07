import { pinRuntimeRoot, runtimeRoot } from '../../core/config/runtime-root';
import { setLogSink } from '../../core/observability/console-sink';
import { probeEmbeddings } from '../../core/rag/embeddings/embeddings-availability';
import {
  pinEmbeddingsProvider,
  resolveEmbeddings,
} from '../../core/rag/embeddings/embeddings-resolver';
import { formatIndexIntegrity, inspectIndexIntegrity } from '../../core/rag/index-integrity';
import { readIndexStamp } from '../../core/rag/index-stamp';
import { IndexerService } from '../../core/rag/indexer';
import { withProvenance } from './dto-mapper';
import { buildPromptCatalog } from './prompt-catalog';
import { activateMcpProjectRoot } from './project-root';
import { buildResourceCatalog } from './resource-catalog';
import { loadMcpSdk } from './sdk-loader';
import { buildSdkServer } from './sdk-server';
import { buildToolCatalog, SemanticSearchReadiness } from './tool-catalog';

/** Lifecycle stages visible while an MCP project index is warming. */
type McpIndexPhase = 'starting' | 'probing' | 'indexing' | 'ready' | 'unavailable' | 'failed' | 'skipped';

/** In-memory truth about the current process; durable coverage still lives in SQLite. */
interface McpIndexLifecycle {
  phase: McpIndexPhase;
  message: string;
  startedAt?: number;
}

/** Options for {@link startMcpServer}. */
export interface StartMcpServerOptions {
  /** Repository to serve. Pinned; never read from a tool argument. */
  root: string;
  /** Package version, reported in `serverInfo`. */
  version: string;
  /** Embedding provider override, e.g. from `--embeddings`. */
  embeddings?: string;
  /** When true, a pre-existing index may be served but no warm-up starts. */
  skipIndex?: boolean;
}

/**
 * Starts the read-only MCP server over stdio.
 *
 * The protocol connection is established before provider probing or indexing.
 * A slow local model can therefore never consume the client's MCP startup
 * window; `get_index_status` and `umbra://index-status` report honest progress
 * until semantic retrieval has durable vector coverage.
 */
export async function startMcpServer(options: StartMcpServerOptions): Promise<void> {
  // stdout belongs to JSON-RPC from this line onward.
  setLogSink((line) => process.stderr.write(`${line}\n`));

  const load = loadMcpSdk();
  if (!load.available) {
    report(`cannot start: ${load.reason}`);
    process.stderr.write(`\n${load.instruction}\n`);
    throw new Error('The MCP server requires @modelcontextprotocol/sdk.');
  }

  // Root-bound state is still pinned before any database, provider, or tool can
  // touch it. The connection itself is root-neutral protocol plumbing.
  pinRuntimeRoot(options.root);
  const rootDir = runtimeRoot();
  const activation = activateMcpProjectRoot({ rootDir, source: 'working-directory' });
  const lifecycle: McpIndexLifecycle = {
    phase: 'starting',
    message: 'MCP connected; preparing the semantic index.',
  };

  const tools = buildToolCatalog({
    semanticSearchReadiness: () => semanticSearchReadiness(rootDir, lifecycle),
    readIndexStatus: () => describeIndexStatus(rootDir, lifecycle),
    decorateSemanticAnswer: (text) => decorateSemanticAnswer(rootDir, text),
  });
  const server = buildSdkServer(load.sdk, {
    version: options.version,
    instructions:
      'Umbra publishes read-only knowledge about one repository. Its index may be warming in the ' +
      'background; call get_index_status before retrying ask_codebase. The repository is fixed for ' +
      'this session and cannot be changed by a tool argument.',
    tools,
    resources: buildResourceCatalog(rootDir, () => describeIndexStatus(rootDir, lifecycle)),
    prompts: buildPromptCatalog(),
  });

  report(`umbra mcp — serving ${rootDir}`);
  if (activation.addedIgnoreRules.length > 0) {
    report(`added local-state ignore rules: ${activation.addedIgnoreRules.join(', ')}`);
  }
  report(`publishing ${tools.length} tools: ${tools.map((tool) => tool.name).join(', ')}`);

  // This is intentionally before provider probing and index work.
  await server.connect(new load.sdk.StdioServerTransport());
  report('MCP transport connected; index warm-up continues in the background.');

  void warmIndexInBackground(rootDir, options, lifecycle);

  await new Promise<void>((resolve) => {
    process.stdin.once('end', () => resolve());
    process.stdin.once('close', () => resolve());
    process.stdin.once('error', () => resolve());
  });

  await server.close();
  report('client disconnected');
}

/** Starts provider probing and indexing without delaying the MCP handshake. */
async function warmIndexInBackground(
  rootDir: string,
  options: StartMcpServerOptions,
  lifecycle: McpIndexLifecycle,
): Promise<void> {
  lifecycle.phase = 'probing';
  lifecycle.message = 'Checking the configured embedding provider.';
  lifecycle.startedAt = Date.now();

  try {
    const selection = resolveEmbeddings(options.embeddings);
    pinEmbeddingsProvider(selection.port.identity.provider);
    const identity = selection.port.identity;
    report(`embeddings: ${identity.provider}/${identity.model} (from ${selection.source})`);

    if (selection.ignoredValue !== undefined) {
      report(
        `Ignoring unknown embeddings provider "${selection.ignoredValue}". Valid values: vertex, ollama.`,
      );
    }

    const availability = await probeEmbeddings(selection.port);
    if (!availability.available) {
      lifecycle.phase = 'unavailable';
      lifecycle.message = availability.reason ?? 'The embedding provider is unavailable.';
      report(`semantic search unavailable — ${lifecycle.message}`);
      return;
    }

    if (options.skipIndex === true) {
      const ready = hasDurableCoverage(rootDir, identity.provider, identity.model);
      lifecycle.phase = ready ? 'ready' : 'skipped';
      lifecycle.message = ready
        ? 'Serving existing durable vector coverage; automatic warm-up was skipped.'
        : 'Index warm-up was skipped and no durable vector coverage exists.';
      report(lifecycle.message);
      return;
    }

    lifecycle.phase = 'indexing';
    lifecycle.message = `Indexing with ${identity.provider}/${identity.model}.`;
    IndexerService.silent = false;
    const result = await new IndexerService(selection.port, (progress) => {
      lifecycle.message = progress;
    }).indexProject();

    if (result.disposition === 'already-running') {
      lifecycle.phase = 'indexing';
      lifecycle.message = 'Another Umbra process owns this root index lease; waiting for its durable coverage.';
      report(lifecycle.message);
      return;
    }

    if (hasDurableCoverage(rootDir, identity.provider, identity.model)) {
      lifecycle.phase = 'ready';
      lifecycle.message = `Durable vector coverage is ready for ${identity.provider}/${identity.model}.`;
      report('index ready');
      return;
    }

    lifecycle.phase = 'failed';
    lifecycle.message = 'Indexing ended without complete durable vector coverage. Run umbra doctor --index.';
    report(lifecycle.message);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    lifecycle.phase = 'failed';
    lifecycle.message = `Index warm-up failed: ${message}`;
    report(lifecycle.message);
  } finally {
    IndexerService.silent = false;
  }
}

/** Builds the availability response used by the stable semantic-search tool. */
function semanticSearchReadiness(rootDir: string, lifecycle: McpIndexLifecycle): SemanticSearchReadiness {
  if (lifecycle.phase !== 'ready') return { ready: false, message: lifecycle.message };

  const stamp = readIndexStamp(rootDir);
  if (stamp === undefined) return { ready: false, message: 'No durable index stamp exists yet.' };
  const integrity = inspectIndexIntegrity(rootDir, { provider: stamp.provider, model: stamp.model });
  return integrity.healthy
    ? { ready: true, message: lifecycle.message }
    : { ready: false, message: 'The vector coverage check is incomplete. Run umbra doctor --index.' };
}

/** Tests persisted coverage without invoking an embedding provider. */
function hasDurableCoverage(rootDir: string, provider: 'vertex' | 'ollama', model: string): boolean {
  return inspectIndexIntegrity(rootDir, { provider, model }).healthy;
}

/** Renders the shared MCP resource/tool view of live and durable index state. */
function describeIndexStatus(rootDir: string, lifecycle: McpIndexLifecycle): string {
  const lines = [
    `state:         ${lifecycle.phase}`,
    `message:       ${lifecycle.message}`,
    `root:          ${rootDir}`,
  ];
  if (lifecycle.startedAt !== undefined) {
    lines.push(`started at:    ${new Date(lifecycle.startedAt).toISOString()}`);
  }

  const stamp = readIndexStamp(rootDir);
  if (stamp !== undefined) {
    lines.push(
      `provider:      ${stamp.provider}`,
      `model:         ${stamp.model}`,
      `stamp status:  ${stamp.status}`,
      `files indexed: ${stamp.filesIndexed}`,
    );
    lines.push('', formatIndexIntegrity(inspectIndexIntegrity(rootDir, {
      provider: stamp.provider,
      model: stamp.model,
    })));
  } else {
    lines.push('', formatIndexIntegrity(inspectIndexIntegrity(rootDir)));
  }

  return lines.join('\n');
}

/** Adds provenance only after the readiness boundary has allowed a real search. */
function decorateSemanticAnswer(rootDir: string, text: string): string {
  const current = readIndexStamp(rootDir);
  const active = resolveEmbeddings().port.identity;
  return withProvenance(text, {
    provider: current?.provider ?? active.provider,
    model: current?.model ?? active.model,
    indexedAt: current?.indexedAt,
    filesIndexed: current?.filesIndexed,
    status: current?.status,
    queriedWith:
      current !== undefined && current.provider !== active.provider
        ? `${active.provider}/${active.model}`
        : undefined,
  });
}

/** Writes one operator-facing line to stderr. */
function report(message: string): void {
  process.stderr.write(`[umbra mcp] ${message}\n`);
}
