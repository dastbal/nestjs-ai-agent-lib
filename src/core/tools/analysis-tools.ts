import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { NestChunker } from "./ast/chunker";
import { AgentDB } from "../state/db";
import { log } from "./utils/logger";

export const analyzeCodeStructureTool = tool(
  async ({ filePath }) => {
    log.debug(`analyze_code_structure called for: ${filePath}`);
    try {
      const rootDir = process.cwd();
      const targetPath = path.resolve(rootDir, filePath);
      if (!fs.existsSync(targetPath)) return `❌ Error: File ${filePath} not found.`;
      const content = fs.readFileSync(targetPath, "utf-8");
      const chunker = new NestChunker();
      const analysis = chunker.analyze(filePath, content, "dummy-hash");
      return `✅ STRUCTURE FOR ${filePath}:\n\n${analysis.skeleton}\n\n[TIP: Use this to create accurate mocks or understand service signatures.]`;
    } catch (error: any) {
      log.error(`Failed to analyze structure: ${error.message}`);
      return `❌ Error analyzing code structure: ${error.message}`;
    }
  },
  {
    name: "analyze_code_structure",
    description: "Analyzes the SKELETON of a file (classes, methods, signatures). Use this to understand how to MOCK services or call them correctly.",
    schema: z.object({
      filePath: z.string().describe("Relative path to the .ts file."),
    }),
  },
);

export const queryDependencyGraphTool = tool(
  async ({ filePath, direction }) => {
    log.debug(`query_dependency_graph called for: ${filePath} [${direction}]`);
    try {
      const db = AgentDB.getInstance();
      const normalizedPath = filePath.split(path.sep).join('/');
      let stmt;
      if (direction === "inbound") {
        stmt = db.prepare("SELECT source, relation FROM dependency_graph WHERE target = ? OR target = ?");
      } else {
        stmt = db.prepare("SELECT target, relation FROM dependency_graph WHERE source = ? OR source = ?");
      }
      const results = stmt.all(normalizedPath, filePath) as any[];
      if (results.length === 0) return `ℹ️ No ${direction} dependencies found for ${filePath}.`;
      let output = `🕸️ DEPENDENCY GRAPH (${direction.toUpperCase()}) for ${filePath}:\n\n`;
      results.forEach((row) => output += `- [${row.relation}] ${direction === "inbound" ? row.source : row.target}\n`);
      return output;
    } catch (error: any) {
      log.error(`Failed to query dependency graph: ${error.message}`);
      return `❌ Error querying dependency graph: ${error.message}`;
    }
  },
  {
    name: "query_dependency_graph",
    description: "Queries the dependency graph (inbound/outbound).",
    schema: z.object({
      filePath: z.string().describe("Relative path to the .ts file."),
      direction: z.enum(["inbound", "outbound"]),
    }),
  },
);
