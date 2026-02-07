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
  executeCommandTool,
  askHumanTool,
  deleteFileTool,
  analyzeCodeStructureTool,
  queryDependencyGraphTool,
} from "../tools";
import * as path from "path";
import * as fs from "fs";

/**
 * Interface representing the structured state of the agent.
 */
export interface AgentState {
  messages: BaseMessage[];
  selected_tool_name?: string | null;
  error?: string | null;
  finish_reason?: 'success' | 'error' | 'tool_failed' | 'no_tool_needed' | null;
  session_files: string[]; // Tracks files created in the current interaction session
}

/**
 * LangGraph Annotation for state management.
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
  session_files: Annotation<string[]>({
    reducer: (x, y) => Array.from(new Set([...x, ...y])), // Merge and deduplicate
    default: () => [],
  }),
});

/**
 * Factory class to assemble a robust LangGraph autonomous agent.
 */
export class GraphAgentFactory {
  /**
   * Creates and compiles a LangGraph agent with Lightweight HITL.
   * 
   * @param threadId - Unique identifier for the conversation thread.
   * @returns A compiled LangGraph instance.
   */
  public static async create(threadId: string = "cli-session") {
    const rootDir = process.cwd();
    const agentDir = path.join(rootDir, ".agent");
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

    const dbPath = path.join(agentDir, "history_graph.db");
    const checkpointer = SqliteSaver.fromConnString(dbPath);

    // Tool categorization for routing
    const researchTools = [
      askCodebaseTool, 
      listFilesTool, 
      safeReadFileTool, 
      refreshIndexTool,
      analyzeCodeStructureTool,
      queryDependencyGraphTool,
    ];
    
    // Tools that NEVER require HITL (Internal/Validation)
    const valuationTools = [integrityCheckTool, executeTestsTool];

    // Tools that MAY require HITL depending on context
    const modificationTools = [safeWriteFileTool, deleteFileTool];

    // Tools that ALWAYS require HITL (Dangerous)
    const dangerousTools = [executeCommandTool, askHumanTool];
    
    const allTools = [...researchTools, ...valuationTools, ...modificationTools, ...dangerousTools];

    const model = LLMProvider.getModel().bindTools(allTools);

    const mainSystemPrompt = `
You are a Principal Software Engineer specialized in NestJS. You operate with a "Lightweight HITL" protocol.

💎 QUALITY STANDARDS:
- Architecture: DDD, Controllers, Services, Modules.
- Typing: Strict TypeScript. NO 'any'.
- Documentation: TSDocs in Technical English.

🚀 ZERO-FRICTION PROTOCOL:
You can work autonomously on tasks that involve CREATING or MODIFYING code. Manual approval is only required for high-risk deletions or environment changes.

1. ✅ AUTOMATED ACTIONS (Safe Actor):
   - Creating NEW FILES or Modifying PRE-EXISTING files.
   - Deleting files that YOU created in this session (session_files).
   - Running tests and integrity checks.
2. ⚠️ PROTECTED ACTIONS (Dangerous Actor - Pauses for Approval):
   - Deleting code that EXISTED before the current task.
   - Executing arbitrary terminal commands (npm install, etc.).
   - Asking for help via 'ask_human'.

📝 SUMMARY RULE:
At the very end of your task, provide a SUPER BRIEF summary of which files were modified (e.g., "Modified: src/app.module.ts, created: src/test.spec.ts").

STUCK PROTOCOL:
- Use 'ask_human' if you are in a loop or mismatching context. Explain exactly what you need.

📂 STRATEGY:
- RESEARCH -> PLAN -> IMPLEMENT -> VALIDATE.
- Read files before modifying them.
- After every 'safe_write_file', use 'run_integrity_check' and 'run_tests'.

🛠️ SELF-HEALING & STRUCTURAL AWARENESS:
- If a test fails with "undefined" or signature mismatches, use 'analyze_code_structure' to see the service's signatures without full implementation noise.
- Always check if a method is 'async' before mocking it; 'async' methods MUST return a Promise (use .mockResolvedValue() or return Promise.resolve()).
- If you get stuck in a loop of failures, rethink your mock strategy based on the 'analyze_code_structure' output.
`;

    const indexerNode = async (state: typeof AgentStateAnnotation.State) => {
      console.log("⚙️ [NODE: INDEXER] Syncing codebase index...");
      const indexer = new IndexerService();
      await indexer.indexProject();
      return {}; 
    };

    const agentNode = async (state: typeof AgentStateAnnotation.State) => {
      console.log("🧠 [NODE: AGENT] Reasoning...");
      const messages: BaseMessage[] = [new SystemMessage(mainSystemPrompt), ...state.messages];
      const response = await (model as any).invoke(messages);
      return { messages: [response], selected_tool_name: response.tool_calls?.[0]?.name || null };
    };

    const researcherNode = async (state: typeof AgentStateAnnotation.State) => {
      console.log("🔍 [NODE: RESEARCHER] Executing discovery tools...");
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      const toolMessages: ToolMessage[] = [];
      if (lastMessage.tool_calls) {
        for (const toolCall of lastMessage.tool_calls) {
          const tool = researchTools.find((t) => t.name === toolCall.name);
          if (tool) {
            const output = await (tool as any).invoke(toolCall.args);
            toolMessages.push(new ToolMessage({ tool_call_id: toolCall.id!, content: typeof output === "string" ? output : JSON.stringify(output) }));
          }
        }
      }
      return { messages: toolMessages };
    };

    /**
     * Node: Safe Actor (Automated writes, tests, and self-deletions)
     */
    const safeActorNode = async (state: typeof AgentStateAnnotation.State) => {
      console.log("🟢 [NODE: SAFE ACTOR] Executing automated tools...");
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      const toolMessages: ToolMessage[] = [];
      const newSessionFiles: string[] = [];

      if (lastMessage.tool_calls) {
        for (const toolCall of lastMessage.tool_calls) {
          const tool = [...valuationTools, ...modificationTools].find((t) => t.name === toolCall.name);
          if (tool) {
            const output = await (tool as any).invoke(toolCall.args);
            
            // Extract session file metadata
            if (toolCall.name === "safe_write_file" && typeof output === "string") {
              const metaMatch = output.match(/\[METADATA: (.*)\]/);
              if (metaMatch) {
                const meta = JSON.parse(metaMatch[1]);
                if (meta.action === "created") newSessionFiles.push(meta.path);
              }
            }
            toolMessages.push(new ToolMessage({ tool_call_id: toolCall.id!, content: output }));
          }
        }
      }
      return { messages: toolMessages, session_files: newSessionFiles };
    };

    /**
     * Node: Dangerous Actor (Legacy deletions, terminal commands, human interaction)
     * 🛡️ PROTECTED BY HITL BREAKPOINT.
     */
    const dangerousActorNode = async (state: typeof AgentStateAnnotation.State) => {
      console.log("🔴 [NODE: DANGEROUS ACTOR] Waiting for approval/input...");
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      const toolMessages: ToolMessage[] = [];

      if (lastMessage.tool_calls) {
        for (const toolCall of lastMessage.tool_calls) {
          const tool = [...modificationTools, ...dangerousTools].find((t) => t.name === toolCall.name);
          if (tool) {
            const output = await (tool as any).invoke(toolCall.args);
            toolMessages.push(new ToolMessage({ tool_call_id: toolCall.id!, content: typeof output === "string" ? output : JSON.stringify(output) }));
          }
        }
      }
      return { messages: toolMessages };
    };

    const workflow = new StateGraph(AgentStateAnnotation)
      .addNode("indexer", indexerNode)
      .addNode("agent", agentNode)
      .addNode("researcher", researcherNode)
      .addNode("safe_actor", safeActorNode)
      .addNode("dangerous_actor", dangerousActorNode)
      
      .addEdge(START, "indexer")
      .addEdge("indexer", "agent")
      .addConditionalEdges("agent", (state) => {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
        if (!lastMessage.tool_calls || lastMessage.tool_calls.length === 0) return END;
        
        const toolCall = lastMessage.tool_calls[0];
        const { name, args } = toolCall;

        if (researchTools.some(t => t.name === name)) return "researcher";
        if (valuationTools.some(t => t.name === name)) return "safe_actor";
        if (dangerousTools.some(t => t.name === name)) return "dangerous_actor";

        // Logic for Writes and Deletes
        if (name === "safe_write_file") {
          // ANY modification or creation is now considered safe by user request
          return "safe_actor";
        }
        
        if (name === "delete_file") {
          const filePath = args.filePath as string;
          // Security: Always protect core configuration and source root directly
          const isCritical = filePath.includes(".env") || filePath === "package.json" || filePath === "tsconfig.json";
          const isSessionFile = state.session_files.includes(filePath);
          
          // If it's a file created in this session OR a non-critical file, we can treat it as safer
          // but for now, we keep the HITL for everything except session files to be 100% sure.
          // The fix for the loop is ensuring the dangerous_actor properly transitions back.
          return isSessionFile ? "safe_actor" : "dangerous_actor";
        }
        
        return END;
      })
      .addEdge("researcher", "agent")
      .addEdge("safe_actor", "agent")
      .addEdge("dangerous_actor", "agent");

    return workflow.compile({ checkpointer, interruptBefore: ["dangerous_actor"] });
  }
}
