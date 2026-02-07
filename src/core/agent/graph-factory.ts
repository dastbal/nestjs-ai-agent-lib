import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { BaseMessage, AIMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { LLMProvider } from "../llm/provider";
import { IndexerService } from "../rag/indexer";
import {
  askCodebaseTool,
  executeTestsTool,
  integrityCheckTool,
  listFilesTool,
  refreshIndexTool,
  safeReadFileTool,
  safeWriteFileTool,
} from "../tools/tools";
import * as path from "path";
import * as fs from "fs";

/**
 * Interface representing the structured state of the agent.
 * Aligned with the original AgentState defined in core/agent/agent-state.ts
 */
export interface AgentState {
  messages: BaseMessage[];
  selected_tool_name?: string | null;
  error?: string | null;
  finish_reason?: 'success' | 'error' | 'tool_failed' | 'no_tool_needed' | null;
}

/**
 * LangGraph Annotation for state management.
 * Handles automatic concatenation of message arrays.
 */
const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  selected_tool_name: Annotation<string | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  error: Annotation<string | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  finish_reason: Annotation<'success' | 'error' | 'tool_failed' | 'no_tool_needed' | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
});

/**
 * Factory class to assemble a robust LangGraph autonomous agent.
 */
export class GraphAgentFactory {
  /**
   * Creates and compiles a LangGraph agent.
   * @param threadId - Unique identifier for the conversation thread.
   * @returns A compiled LangGraph instance.
   */
  public static async create(threadId: string = "cli-session") {
    const rootDir = process.cwd();
    const agentDir = path.join(rootDir, ".agent");
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

    // Persistence configuration using SQLite
    const dbPath = path.join(agentDir, "history_graph.db");
    const checkpointer = SqliteSaver.fromConnString(dbPath);

    // Tool categories
    const researchTools = [askCodebaseTool, listFilesTool, safeReadFileTool, refreshIndexTool];
    const actionTools = [safeWriteFileTool, integrityCheckTool, executeTestsTool];
    const allTools = [...researchTools, ...actionTools];

    // Model instantiation via LLMProvider
    const model = LLMProvider.getModel().bindTools(allTools);

    const mainSystemPrompt = `
You are a Principal Software Engineer specialized in NestJS (Node.js). You are operating on a live, real-world project using a modular LangGraph architecture. Your goal is to deliver industrial-grade code while maintaining absolute project integrity.

💎 QUALITY STANDARDS (UNBREAKABLE):
- Architecture: Strictly follow DDD (Domain-Driven Design) and NestJS Best Practices (Controllers, Services, Providers, Modules).
- Typing: Strict TypeScript. The use of 'any' is FORBIDDEN. Use proper interfaces and classes.
- Documentation: Always document public methods and complex logic with TSDocs in technical English.
- Validation: Use strict DTOs with 'class-validator' and 'class-transformer'.

🧪 TESTING & INTEGRITY PROTOCOL (MANDATORY):
1. Spec First: When creating a new feature, you MUST create the corresponding '.spec.ts' file before or alongside the implementation.
2. The Surgeon's Rule (Read-Before-Write): NEVER overwrite or edit a file without reading it first using 'safe_read_file'. You must understand the existing logic, TSDocs, and dependencies.
3. Anti-Regression: Preserve existing documentation, helpful comments, and unrelated business logic. Your goal is to AUGMENT, not destroy.
4. Self-Healing: After 'safe_write_file', you MUST run 'run_integrity_check' (tsc) AND 'run_tests' for the affected file. If errors occur, analyze the output and fix them yourself.

⚙️ GRAPH ARCHITECTURE & EXECUTION:
- INDEXER: On Every run, the system silently indexes the project. Your context via 'ask_codebase' is always fresh.
- RESEARCHER NODE: Use 'ask_codebase' for semantic search and graph dependencies. Use 'list_files' if you are unsure of the folder structure. 
- ACTOR NODE: Use 'safe_write_file' for all writes. It automatically handles backups in '.agent/backups'.

📂 OPERATIONAL STRATEGY:
- Use RELATIVE PATHS (e.g., 'src/users/users.service.ts').
- RESEARCH (ask_codebase) -> READ (safe_read_file) -> PLAN -> IMPLEMENT (safe_write_file) -> VALIDATE (run_integrity_check / run_tests).
- If after 3 self-correction attempts you cannot fix an error, explain the issue clearly and ask for human help.

🚨 SAFETY RULES:
- Never perform mass file deletions.
- Double-check imports when modifying core files like 'app.module.ts'.
- Never swallowed errors (no empty catch blocks).
`;

    /**
     * Node 1: Indexer
     * Ensures the codebase RAG index is up-to-date before reasoning starts.
     */
    const indexerNode = async (state: typeof AgentStateAnnotation.State) => {
      console.log("⚙️ [NODE: INDEXER] Syncing codebase index...");
      const indexer = new IndexerService();
      await indexer.indexProject();
      return {}; // No state changes needed, just a process node
    };

    /**
     * Node 2: Agent (Reasoning)
     * Thinks and decides which tool to call or responds to the user.
     */
    const agentNode = async (state: typeof AgentStateAnnotation.State) => {
      console.log("🧠 [NODE: AGENT] Reasoning...");
      const messages: BaseMessage[] = [
        new SystemMessage(mainSystemPrompt),
        ...state.messages,
      ];
      const response = await (model as any).invoke(messages);
      
      const selectedTool = response.tool_calls?.[0]?.name || null;
      return { 
        messages: [response],
        selected_tool_name: selectedTool
      };
    };

    /**
     * Node 3: Researcher (Read-only tools)
     * Executes queries and file reads.
     */
    const researcherNode = async (state: typeof AgentStateAnnotation.State) => {
      console.log("🔍 [NODE: RESEARCHER] Executing discovery tools...");
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      const toolMessages: ToolMessage[] = [];

      if (lastMessage.tool_calls) {
        for (const toolCall of lastMessage.tool_calls) {
          const tool = researchTools.find((t) => t.name === toolCall.name);
          if (tool) {
            const output = await (tool as any).invoke(toolCall.args);
            toolMessages.push(new ToolMessage({
              tool_call_id: toolCall.id!,
              content: typeof output === "string" ? output : JSON.stringify(output),
            }));
          }
        }
      }
      return { messages: toolMessages };
    };

    /**
     * Node 4: Actor (Write & Validate tools)
     * Executes file mutations and build checks.
     */
    const actorNode = async (state: typeof AgentStateAnnotation.State) => {
      console.log("🛠️ [NODE: ACTOR] Executing implementation tools...");
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      const toolMessages: ToolMessage[] = [];

      if (lastMessage.tool_calls) {
        for (const toolCall of lastMessage.tool_calls) {
          const tool = actionTools.find((t) => t.name === toolCall.name);
          if (tool) {
            const output = await (tool as any).invoke(toolCall.args);
            toolMessages.push(new ToolMessage({
              tool_call_id: toolCall.id!,
              content: typeof output === "string" ? output : JSON.stringify(output),
            }));
          }
        }
      }
      return { messages: toolMessages };
    };

    // 3. Define Graph Structure
    const workflow = new StateGraph(AgentStateAnnotation)
      // Nodes
      .addNode("indexer", indexerNode)
      .addNode("agent", agentNode)
      .addNode("researcher", researcherNode)
      .addNode("actor", actorNode)
      
      // Edges
      .addEdge(START, "indexer")
      .addEdge("indexer", "agent")
      .addConditionalEdges("agent", (state) => {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
        if (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0) {
          return END;
        }
        
        // Routing logic: which node handles the requested tools?
        const toolName = lastMessage.tool_calls[0].name;
        if (researchTools.some(t => t.name === toolName)) return "researcher";
        if (actionTools.some(t => t.name === toolName)) return "actor";
        
        return END; // Safety fallback
      })
      .addEdge("researcher", "agent")
      .addEdge("actor", "agent");

    // 4. Compile with persistence
    return workflow.compile({ checkpointer });
  }
}
