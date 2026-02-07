import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { RetrieverService } from "../rag/retriever";
import { IndexerService } from "../rag/indexer";
import { log } from "./utils/logger";

export const askCodebaseTool = tool(
  async ({ query }) => {
    log.debug(`ask_codebase called with query: "${query}"`);
    try {
      log.tool(`Querying codebase: "${query}"`);
      const retriever = new RetrieverService();
      const context = await retriever.getContextForLLM(query);
      return context;
    } catch (error: any) {
      log.error(`Error during codebase query "${query}": ${error.message}`);
      return `❌ Error querying codebase: ${error.message}`;
    }
  },
  {
    name: "ask_codebase",
    description: "Semantic search AND dependency graph lookup. Returns code snippets and dependency maps.",
    schema: z.object({ query: z.string().describe("Query describing logic or functionality.") }),
  },
);

export const refreshIndexTool = tool(
  async () => {
    log.sys("🔄 Starting full project re-indexing...");
    try {
      const indexer = new IndexerService();
      await indexer.indexProject();
      log.sys("✅ Re-indexing completed successfully.");
      return "✅ Index successfully updated.";
    } catch (error: any) {
      log.error(`❌ Indexing failed: ${error.message}`);
      return `❌ Critical error while attempting to index the project: ${error.message}`;
    }
  },
  {
    name: "refresh_project_index",
    description: "Triggers a forced, full re-indexing of the project codebase.",
    schema: z.object({}),
  },
);
