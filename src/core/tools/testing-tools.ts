import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { log } from "./utils/logger";

const execAsync = promisify(exec);

export const executeTestsTool = tool(
  async ({ filePath }) => {
    const rootDir = process.cwd();
    let command = "npm test";
    if (filePath) {
      const resolvedPath = path.resolve(rootDir, filePath);
      if (!fs.existsSync(resolvedPath)) return `❌ Error: The file '${filePath}' does not exist.`;
      command = `npx jest ${filePath} --passWithNoTests --no-stack-trace`;
    }
    log.tool(`🚀 Executing Jest...`);
    try {
      const { stdout } = await execAsync(command, { cwd: rootDir });
      log.tool("✅ TESTS PASSED.");
      return `✅ SUCCESS: Tests passed.\n${stdout.slice(-500)}`;
    } catch (error: any) {
      log.error("❌ TESTS FAILED.");
      const output = error.stdout || error.stderr || error.message;
      return `❌ TEST FAILED.\n---------------------------------------------------\n${output.slice(-2500)}\n---------------------------------------------------`;
    }
  },
  {
    name: "run_tests",
    description: "Executes the test suite using Jest.",
    schema: z.object({ filePath: z.string().optional() }),
  },
);

export const integrityCheckTool = tool(
  async () => {
    const rootDir = process.cwd();
    log.tool("Running TypeScript integrity check...");
    try {
      const { stdout } = await execAsync("npx tsc --noEmit", { cwd: rootDir });
      log.tool("TypeScript integrity check PASSED.");
      return `✅ INTEGRITY CHECK PASSED.\n${stdout}`;
    } catch (error: any) {
      const errorMessage = error.stdout || error.stderr || error.message || "Unknown error";
      log.error(`TypeScript integrity check FAILED.\n${errorMessage}`);
      return `❌ INTEGRITY CHECK FAILED:\n${errorMessage}`;
    }
  },
  {
    name: "run_integrity_check",
    description: "Runs tsc --noEmit to verify type safety.",
    schema: z.object({}),
  },
);
