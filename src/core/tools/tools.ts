import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { RetrieverService } from "../rag/retriever";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { IndexerService } from "../rag/indexer";

const execAsync = promisify(exec);

const log = {
  ai: (msg: string) => console.log(chalk.blue("🤖 [AI]: ") + msg),
  tool: (msg: string) => console.log(chalk.yellow("🛠️  [TOOL]: ") + msg),
  sys: (msg: string) => console.log(chalk.gray("⚙️  [SYS]: ") + msg),
  error: (msg: string) => console.log(chalk.red("❌ [ERR]: ") + msg),
  debug: (msg: string) => console.log(chalk.magenta("🐛 [DEBUG]: ") + msg), // Added for debugging
};

/**
 * Creates a backup of a file before it is modified.
 * The backup is stored in the .agent/backups directory with a timestamp.
 * @param {string} filePath - The relative path of the file to back up.
 */
const createBackup = (filePath: string) => {
  log.debug(`Starting backup process for file: ${filePath}`);
  const rootDir = process.cwd();
  const backupDir = path.join(rootDir, ".agent", "backups");
  log.debug(`Backup directory resolved to: ${backupDir}`);

  if (!fs.existsSync(backupDir)) {
    log.debug(`Backup directory does not exist. Creating: ${backupDir}`);
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const realPath = path.resolve(rootDir, filePath);
  log.debug(`Resolved real path for backup: ${realPath}`);

  if (fs.existsSync(realPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = path.basename(realPath);
    const backupPath = path.join(backupDir, `${timestamp}_${filename}.bak`);
    log.debug(`Attempting to copy ${realPath} to ${backupPath}`);
    fs.copyFileSync(realPath, backupPath);
    log.sys(`Backup created for ${filePath} at ${backupPath}`);
  } else {
    log.debug(`File does not exist, no backup needed: ${realPath}`);
  }
};

/**
 * Tool for safely writing content to a file on the real disk.
 * It creates a backup before writing and then triggers a project re-indexing.
 * @param {object} params - The parameters for the tool.
 * @param {string} params.filePath - The relative path where the file should be saved.
 * @param {string} params.content - The content to write to the file.
 * @returns {Promise<string>} A message indicating success or failure.
 */
export const safeWriteFileTool = tool(
  async ({ filePath, content }) => {
    log.debug(`safe_write_file called with filePath: ${filePath}`);
    try {
      const rootDir = process.cwd();
      log.debug(`Current working directory: ${rootDir}`);
      const targetPath = path.resolve(rootDir, filePath);
      log.debug(`Resolved target path: ${targetPath}`);

      // Security check: Ensure the path is within the project root
      if (!targetPath.startsWith(rootDir)) {
        log.error(
          `Attempted write outside root directory: ${filePath}. Resolved path: ${targetPath}`,
        );
        return "❌ Error: Access denied. Cannot write outside the project root.";
      }

      const dir = path.dirname(targetPath);
      log.debug(`Directory for target path: ${dir}`);
      if (!fs.existsSync(dir)) {
        log.debug(`Directory does not exist. Creating: ${dir}`);
        fs.mkdirSync(dir, { recursive: true });
        log.sys(`Created directory: ${dir}`);
      }

      createBackup(filePath); // Create backup before writing
      log.debug(`Writing content to file: ${targetPath}`);
      fs.writeFileSync(targetPath, content, "utf-8");
      log.sys(`File saved to REAL DISK: ${filePath}`);

      // Trigger re-indexing after a successful write
      log.sys(`Initiating re-index for: ${filePath}`);
      const indexer = new IndexerService();
      // Run indexing asynchronously, log errors but don't block the write confirmation
      indexer.indexProject().catch((err) => {
        log.error(
          `Failed to re-index after write for ${filePath}: ${err.message}`,
        );
      });

      return `✅ File saved to REAL DISK: ${filePath}`;
    } catch (error: any) {
      log.error(`Failed to write file ${filePath}: ${error.message}`);
      return `❌ Error writing file: ${error.message}`;
    }
  },
  {
    name: "safe_write_file",
    description:
      "WRITES code to the REAL local disk. Creates a backup automatically.",
    schema: z.object({
      filePath: z.string().describe("Relative path (e.g., src/app.service.ts)"),
      content: z.string().describe("Full file content"),
    }),
  },
);

/**
 * Tool for safely reading the content of a file from the real disk.
 * @param {object} params - The parameters for the tool.
 * @param {string} params.filePath - The relative path of the file to read.
 * @returns {Promise<string>} The content of the file, or an error message if reading fails.
 */
export const safeReadFileTool = tool(
  async ({ filePath }) => {
    log.debug(`safe_read_file called with filePath: ${filePath}`);
    try {
      const rootDir = process.cwd();
      log.debug(`Current working directory: ${rootDir}`);
      const targetPath = path.resolve(rootDir, filePath);
      log.debug(`Resolved target path: ${targetPath}`);

      // Security check: Ensure the path is within the project root
      if (!fs.existsSync(targetPath)) {
        log.error(
          `File not found for reading: ${filePath}. Resolved path: ${targetPath}`,
        );
        return `❌ File not found: ${filePath}`;
      }
      if (!targetPath.startsWith(rootDir)) {
        log.error(
          `Attempted read outside root directory: ${filePath}. Resolved path: ${targetPath}`,
        );
        return "❌ Error: Access denied. Cannot read outside the project root.";
      }

      log.debug(`Reading file content from: ${targetPath}`);
      const content = fs.readFileSync(targetPath, "utf-8");
      log.sys(`File read successfully: ${filePath}`);
      return content;
    } catch (e: any) {
      log.error(`Failed to read file ${filePath}: ${e.message}`);
      return `❌ Error reading file: ${e.message}`;
    }
  },
  {
    name: "safe_read_file",
    description: "READS code from the REAL local disk.",
    schema: z.object({ filePath: z.string() }),
  },
);

/**
 * Tool to query the codebase using semantic search and dependency graph analysis.
 * It's the primary way for the agent to explore and understand the project structure and logic.
 * @param {object} params - The parameters for the tool.
 * @param {string} params.query - A natural language query describing the code or functionality to find.
 * @returns {Promise<string>} A report containing relevant code snippets, file paths, and dependencies.
 */
export const askCodebaseTool = tool(
  async ({ query }) => {
    log.debug(`ask_codebase called with query: "${query}"`);
    try {
      log.tool(`Querying codebase: "${query}"`);
      const retriever = new RetrieverService();
      log.debug("RetrieverService instantiated.");
      const context = await retriever.getContextForLLM(query);
      log.tool(`Codebase query complete for: "${query}"`);
      log.debug(`Context retrieved for query "${query}".`);
      return context;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error(`Error during codebase query "${query}": ${errorMessage}`);
      return `❌ Error querying codebase: ${errorMessage}`;
    }
  },
  {
    name: "ask_codebase",
    description:
      "CRITICAL TOOL. Use this tool FIRST to explore the codebase. " +
      "It performs a semantic search AND a dependency graph lookup. " +
      "Returns: Relevant code snippets, lists of dependencies (imports), and ACCURATE FILE PATHS. " +
      "Strategy: Use this to find *where* logic is located. If you need the full file content to edit it safely, " +
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
 * Tool to run the TypeScript compiler (tsc) for type checking.
 * This is crucial for maintaining code quality and catching errors early.
 * @returns {Promise<string>} A message indicating whether the integrity check passed or failed, including compiler output on failure.
 */
export const integrityCheckTool = tool(
  async () => {
    const rootDir = process.cwd();
    log.tool("Running TypeScript integrity check...");
    log.debug(`Integrity check running in directory: ${rootDir}`);
    try {
      // 'tsc --noEmit' checks types without generating JS files. It's fast and safe.
      log.debug("Executing command: npx tsc --noEmit");
      const { stdout, stderr } = await execAsync("npx tsc --noEmit", {
        cwd: rootDir,
      });
      if (stderr) {
        // Log stderr as an error even if stdout indicates success, as tsc might output warnings here
        log.error(
          `TypeScript integrity check produced stderr output:\n${stderr}`,
        );
      }
      log.tool("TypeScript integrity check PASSED.");
      log.debug(`Integrity check stdout:\n${stdout}`);
      // Include stdout in the success message for completeness, though it's usually empty on success.
      return `✅ INTEGRITY CHECK PASSED. The codebase is strictly typed and compiles correctly.\n${stdout}`;
    } catch (error: any) {
      // Return the exact compiler error output so the agent can attempt to fix it
      const errorMessage =
        error.stdout || error.stderr || error.message || "Unknown error";
      log.error(`TypeScript integrity check FAILED.\n${errorMessage}`);
      return `❌ INTEGRITY CHECK FAILED. You must fix these TypeScript errors before finishing:\n${errorMessage}`;
    }
  },
  {
    name: "run_integrity_check",
    description:
      "Runs the TypeScript compiler (tsc) to verify type safety. " +
      "MANDATORY: Run this tool after every 'write_file' or 'edit_file' operation to ensure you haven't broken the build.",
    schema: z.object({}),
  },
);

/**
 * Tool to refresh the project's index, forcing a re-scan and re-vectorization of all files.
 * This is useful when the agent needs to be absolutely sure it's working with the latest code,
 * especially after significant changes or if the automatic indexing seems to be lagging.
 * @returns {Promise<string>} A confirmation message or details about any errors encountered during indexing.
 */
export const refreshIndexTool = tool(
  async () => {
    log.sys("🔄 Starting full project re-indexing...");

    try {
      const indexer = new IndexerService();
      log.debug("IndexerService instantiated.");
      // Execute the indexing process.
      await indexer.indexProject(); // Await the completion of the indexing process

      log.sys("✅ Re-indexing completed successfully.");
      log.debug("Project re-indexing process finished.");
      return "✅ Index successfully updated. I now have access to the latest code version.";
    } catch (error) {
      // Provide a detailed error message if indexing fails.
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      log.error(`❌ Indexing failed: ${errorMessage}`);
      log.debug(`Error details during indexing: ${errorMessage}`);
      return `❌ Critical error while attempting to index the project: ${errorMessage}. Please try again or check the logs.`;
    }
  },
  {
    name: "refresh_project_index",
    description:
      "Triggers a forced, full re-indexing of the project codebase. That fucntion is optimazed only index changes comparing hash" +
      "USE THIS TOOL ONLY WHEN: " +
      "1) The user explicitly states that files have changed. " +
      "2) You cannot find information that should be present (stale context). " +
      "Note: This is a computationally expensive operation; inform the user before running it.",
    schema: z.object({}),
  },
);

/**
 * Tool to execute Jest tests.
 * Essential for TDD workflow.
 */
export const executeTestsTool = tool(
  async ({ filePath }) => {
    const rootDir = process.cwd();

    // 1. Lógica para decidir el modo (Unitario vs Global)
    let command = "npm test";
    let modeDescription = "ALL project tests";

    if (filePath) {
      // 🛡️ Validación de ruta antes de llamar a Jest
      const resolvedPath = path.resolve(rootDir, filePath);

      if (!fs.existsSync(resolvedPath)) {
        log.error(`Test file not found: ${filePath}`);
        return `❌ Error: The file '${filePath}' does not exist. Did you mean to create it first? or did you use a wrong path?`;
      }

      // Si el agente manda un archivo .ts normal, intentamos buscar su .spec.ts
      if (!resolvedPath.endsWith(".spec.ts") && resolvedPath.endsWith(".ts")) {
        const potentialSpec = resolvedPath.replace(".ts", ".spec.ts");
        if (fs.existsSync(potentialSpec)) {
          return `⚠️ Warning: You tried to test '${filePath}' directly. I think you meant '${filePath.replace(".ts", ".spec.ts")}'. Please call run_tests with the .spec.ts file.`;
        }
      }

      command = `npx jest ${filePath} --passWithNoTests --no-stack-trace`;
      modeDescription = `single file: ${filePath}`;
    }

    log.tool(`🚀 Executing Jest (${modeDescription})...`);

    try {
      // Ejecutamos el comando
      const { stdout, stderr } = await execAsync(command, { cwd: rootDir });

      log.tool("✅ TESTS PASSED.");

      // Si todo sale bien, devolvemos un mensaje corto para ahorrar tokens
      return `✅ SUCCESS: Tests passed for ${modeDescription}.\n${stdout.slice(-500)}`; // Resumen corto
    } catch (error: any) {
      log.error("❌ TESTS FAILED.");

      // Capturamos la salida de error
      const output = error.stdout || error.stderr || error.message;

      // 🔥 ESTRATEGIA: Devolver una porción generosa del error para que el agente pueda leerlo y corregirlo
      return `❌ TEST FAILED for ${modeDescription}. 
      
      Here is the failure output (analyze this to fix the code):
      ---------------------------------------------------
      ${output.slice(-2500)} 
      ---------------------------------------------------
      `;
    }
  },
  {
    name: "run_tests",
    // 🧠 LA CLAVE: Descripción explícita de los dos modos
    description:
      "Executes the test suite using Jest. Supports two modes:\n" +
      "1. SPECIFIC FILE (Recommended): Provide 'filePath' to run tests only for that file (fast).\n" +
      "2. FULL SUITE: Omit 'filePath' (leave it empty) to run ALL tests in the project (slower, use for final check).",
    schema: z.object({
      filePath: z
        .string()
        .optional()
        .describe(
          "Relative path to the .spec.ts file (e.g., 'src/users/users.service.spec.ts'). LEAVE EMPTY/UNDEFINED to run all tests.",
        ),
    }),
  },
);

/**
 * Tool to list files in a directory.
 * Helps the agent explore the real structure without relying only on RAG.
 */
export const listFilesTool = tool(
  async ({ dirPath }) => {
    try {
      const rootDir = process.cwd();
      const targetDir = path.resolve(rootDir, dirPath || ".");

      if (!fs.existsSync(targetDir))
        return `❌ Directory not found: ${dirPath}`;

      const files = fs.readdirSync(targetDir, { withFileTypes: true });
      const list = files
        .map((f) => `${f.isDirectory() ? "📂" : "📄"} ${f.name}`)
        .join("\n");

      log.sys(`Listed directory: ${dirPath}`);
      return `Contents of ${dirPath}:\n${list}`;
    } catch (e: any) {
      return `❌ Error listing directory: ${e.message}`;
    }
  },
  {
    name: "list_files",
    description:
      "Lists files and directories in a specific path. Use this to explore the project structure.",
    schema: z.object({ dirPath: z.string().optional().default(".") }),
  },
);
