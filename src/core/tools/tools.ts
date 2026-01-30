import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RetrieverService } from '../rag/retriever';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { IndexerService } from '../rag/indexer';
const execAsync = promisify(exec);
const log = {
  ai: (msg: string) => console.log(chalk.blue('🤖 [AI]: ') + msg),
  tool: (msg: string) => console.log(chalk.yellow('🛠️  [TOOL]: ') + msg),
  sys: (msg: string) => console.log(chalk.gray('⚙️  [SYS]: ') + msg),
  error: (msg: string) => console.log(chalk.red('❌ [ERR]: ') + msg),
};
/**
 * 💾 Genera un backup antes de modificar un archivo real.
 */
const createBackup = (filePath: string) => {
  const rootDir = process.cwd();
  const backupDir = path.join(rootDir, '.agent', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const realPath = path.resolve(rootDir, filePath);
  if (fs.existsSync(realPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.basename(realPath);
    const backupPath = path.join(backupDir, `${timestamp}_${filename}.bak`);
    fs.copyFileSync(realPath, backupPath);
  }
};

export const safeWriteFileTool = tool(
  async ({ filePath, content }) => {
    try {
      const rootDir = process.cwd();
      const targetPath = path.resolve(rootDir, filePath);
      if (!targetPath.startsWith(rootDir)) return '❌ Error: Access denied.';

      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      createBackup(filePath); // Tu lógica de backup
      fs.writeFileSync(targetPath, content, 'utf-8');
      log.sys(`Indexando cambio en: ${filePath}`);
      const indexer = new IndexerService();
      indexer.indexProject().catch((err) => log.error(` ${err.message}`));

      return `✅ File saved to REAL DISK: ${filePath}`;
    } catch (error: any) {
      return `❌ Error: ${error.message}`;
    }
  },
  {
    name: 'safe_write_file',
    description:
      'WRITES code to the REAL local disk. Creates a backup automatically.',
    schema: z.object({
      filePath: z.string().describe('Relative path (e.g., src/app.service.ts)'),
      content: z.string().describe('Full file content'),
    }),
  },
);

// --- TOOL 2: READ FILE (Manual) ---
export const safeReadFileTool = tool(
  async ({ filePath }) => {
    try {
      const rootDir = process.cwd();
      const targetPath = path.resolve(rootDir, filePath);
      if (!fs.existsSync(targetPath)) return '❌ File not found.';
      return fs.readFileSync(targetPath, 'utf-8');
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
  {
    name: 'safe_read_file',
    description: 'READS code from the REAL local disk.',
    schema: z.object({ filePath: z.string() }),
  },
);
/**
 * 🔍 TOOL: Ask Codebase (Semantic & Graph Search)
 * This is the Agent's "Eyes". It retrieves code + context.
 */
export const askCodebaseTool = tool(
  async ({ query }) => {
    try {
      // We assume the streaming UI handles the 'Thinking...' log via the framework events
      const retriever = new RetrieverService();
      const context = await retriever.getContextForLLM(query);
      return context;
    } catch (error) {
      return `❌ Error querying codebase: ${error}`;
    }
  },
  {
    name: 'ask_codebase',
    description:
      'CRITICAL TOOL. Use this tool FIRST to explore the codebase. ' +
      'It performs a semantic search AND a dependency graph lookup. ' +
      'Returns: Relevant code snippets, lists of dependencies (imports), and ACCURATE FILE PATHS. ' +
      'Strategy: Use this to find *where* logic is located. If you need the full file content to edit it safely, ' +
      "copy the 'FILE PATH' returned by this tool and use the native 'read_file' tool.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "A natural language query describing the logic, DTO, or functionality you are looking for. (e.g., 'How is the RefundEntity defined?', 'Show me the auth guard')",
        ),
    }),
  },
);

/**
 * ✅ TOOL: Integrity Check (Compiler)
 * Validates the project state using TypeScript compiler.
 */
export const integrityCheckTool = tool(
  async () => {
    try {
      const rootDir = process.cwd();
      // 'tsc --noEmit' checks types without generating JS files. Fast and safe.
      const { stdout } = await execAsync('npx tsc --noEmit', { cwd: rootDir });
      console.log('INTEGRITY CHECK PASSED.', rootDir, stdout);
      return `✅ INTEGRITY CHECK PASSED. The codebase is strictly typed and compiles correctly.\n${stdout}`;
    } catch (error: any) {
      // Return the exact compiler error so the agent can fix it
      return `❌ INTEGRITY CHECK FAILED. You must fix these TypeScript errors before finishing:\n${error.stdout || error.message}`;
    }
  },
  {
    name: 'run_integrity_check',
    description:
      'Runs the TypeScript compiler (tsc) to verify type safety. ' +
      "MANDATORY: Run this tool after every 'write_file' or 'edit_file' operation to ensure you haven't broken the build.",
    schema: z.object({}),
  },
);

/**
 * Maintenance tool to update the vector knowledge base.
 * * This tool forces a re-read and vectorization of the project files.
 * It is useful for ensuring the LLM has access to the most recent code changes
 * that may not have been synchronized automatically.
 * * @returns {Promise<string>} A confirmation message or error details.
 */
export const refreshIndexTool = tool(
  async () => {
    log.sys('🔄 Starting full project re-indexing...');

    try {
      // Start the expensive operation
      const indexer = new IndexerService();
      indexer.indexProject().catch((err) => log.error(` ${err.message}`));

      log.sys('✅ Re-indexing completed successfully.');
      return '✅ Index successfully updated. I now have access to the latest code version.';
    } catch (error) {
      // Safe error handling in TypeScript
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      log.error(`❌ Indexing failed: ${errorMessage}`);
      return `❌ Critical error while attempting to index the project: ${errorMessage}. Please try again or check the logs.`;
    }
  },
  {
    name: 'refresh_project_index',
    // CRITICAL IMPROVEMENT: Instruction-oriented description for the LLM
    description:
      'Triggers a forced, full re-indexing of the project codebase. That fucntion is optimazed only index changes comparing hash' +
      'USE THIS TOOL ONLY WHEN: ' +
      '1) The user explicitly states that files have changed. ' +
      '2) You cannot find information that should be present (stale context). ' +
      'Note: This is a computationally expensive operation; inform the user before running it.',
    schema: z.object({}),
  },
);
