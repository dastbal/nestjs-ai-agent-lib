/**
 * @module ContextCompressor
 *
 * On-demand context compression for `/model` switches in the CLI.
 *
 * ## Why this exists
 * When a user switches models via `/model`, the new agent starts with a blank
 * slate and has no knowledge of the previous conversation. `ContextCompressor`
 * reads the current LangGraph state, distills the history into a compact summary,
 * and returns it so `ChatSession` can inject it as the first message in the new
 * agent's context.
 *
 * ## Why NOT deepagents' SummarizationMiddleware
 * ADR-007: deepagents registers `SummarizationMiddleware` in `REQUIRED_MIDDLEWARE_NAMES`.
 * Adding it manually causes a "defined multiple times" error at agent construction.
 * `ContextCompressor` is completely external — a clean one-shot LLM call via
 * `LLMProvider.createChatModel()`. Zero contact with deepagents internals.
 *
 * ## Fallback chain (ADR-020)
 * 1. **Primary**: `CONTEXT_SUMMARIZER_MODEL` env var (default: `gemini-2.5-flash-lite`)
 * 2. **Fallback**: `ollama:gemma4` — local, no network required
 * 3. **Final**: `null` — the model switch still completes, but without context handoff
 *
 * @example
 * ```ts
 * const summary = await ContextCompressor.compress(messages, 'gemini-2.5-flash-lite');
 * if (summary) {
 *   await session.sendMessage(`[CONTEXT HANDOFF]\n\n${summary}`);
 * }
 * ```
 */

import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { LLMProvider } from '../llm/provider';
import { isOllamaModel } from '../config/model-resolver';
import { tokenCounter } from '../llm/tokens/token-counter';
import { sessionOverhead } from './session-overhead';
import type { CountableTool } from '../llm/tokens/token-counter.port';

// ── Constants ──────────────────────────────────────────────────────────────────

/**
 * Default maximum token budget before proactive compression fires.
 *
 * ~~Using chars/4 as a token estimate. 80,000 tokens ≈ 320,000 characters.~~
 * **Amended for ADR-031 phase 2:** the count is now a real BPE count of the
 * whole request, so the threshold no longer converts to a character figure.
 * The value is unchanged at 80,000, deliberately: changing the counter and the
 * budget in the same commit would make it impossible to tell which one moved
 * the behaviour. Note that the number it is compared against is now *larger*
 * for the same conversation, because tool-call arguments and framing were
 * previously uncounted — so compression fires earlier than it used to, which
 * is the correction, not a regression.
 *
 * This is well under the gemini-2.5-flash-lite 1M token context window but
 * aggressive enough to prevent "model output must contain" crashes (ADR-024).
 *
 * Override with `MAX_CONTEXT_TOKENS` environment variable.
 */
const DEFAULT_TOKEN_BUDGET = 80_000;

/**
 * System prompt used for the one-shot compression call.
 *
 * Instructs the LLM to produce a tight, technical summary focused on
 * decisions, files, and work state — not conversational filler.
 */
const COMPRESSION_SYSTEM_PROMPT = `You are summarizing a conversation between a developer and an AI coding assistant.

Produce a concise technical summary (max 500 words) covering:
1. Key architectural or implementation decisions made, and why
2. Files created or modified (include exact file paths)
3. Tasks completed and their current status
4. Any critical bugs found and whether they were fixed
5. Current work state — what is in progress or pending

Rules:
- Focus on technical facts. Omit greetings, filler, and repetition.
- Use bullet points, not paragraphs.
- Output only the summary — no preamble, no "Here is a summary:" opener.`;

/**
 * Ollama model used as fallback when the primary cloud model is unavailable.
 * Must be installed locally: `ollama pull gemma4`
 */
const OLLAMA_FALLBACK_MODEL = 'ollama:gemma4';

/**
 * Minimum number of messages required to attempt compression.
 * Below this threshold the history is too short to be worth compressing.
 */
const MIN_MESSAGES_FOR_COMPRESSION = 3;

// ── Class ─────────────────────────────────────────────────────────────────────

/**
 * Compresses LangGraph conversation history for context handoff during model switches.
 *
 * All methods are static — this class is a pure utility with no instance state.
 */
export class ContextCompressor {
  private constructor() {}

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Counts the tokens a messages array will cost on the next request.
   *
   * ## Amended for ADR-031 phase 2
   * This was `chars / 4` over `msg.content` alone, and both halves of that were
   * a problem. The ratio was wrong by a content-dependent factor — over 20% on
   * ordinary TypeScript — and, more seriously, `content` is not the request.
   * An `AIMessage` that calls a tool carries its arguments in `tool_calls`, so
   * a turn that wrote a large file counted as nearly free, and the per-message
   * framing a provider adds was never charged at all.
   *
   * It now delegates to {@link TokenCounterPort}, which uses a real BPE encoder
   * and counts tool-call arguments and framing. `overhead` defaults to what
   * {@link sessionOverhead} recorded when the agent was built: a deep agent's
   * tool schemas are thousands of fixed tokens on every request, and no call
   * site had them to hand — which is exactly why the budget was always measured
   * against a number smaller than the thing it guards. Reading the recorded
   * value rather than threading it through every caller means the count is
   * right for all of them, not only for the one that remembered to pass it.
   *
   * @param messages - Raw messages array from agent state.
   * @param overhead - The system prompt and tool definitions, when known.
   * @returns Token count.
   */
  public static estimateTokens(
    messages: unknown[],
    overhead: { system?: string; tools?: readonly CountableTool[] } = sessionOverhead(),
  ): number {
    if (!messages || messages.length === 0) return 0;

    return tokenCounter().countRequest({
      messages,
      system: overhead?.system,
      tools: overhead?.tools,
    }).total;
  }

  /**
   * Returns true when the estimated token count of a messages array exceeds
   * the configured budget threshold.
   *
   * Reads `MAX_CONTEXT_TOKENS` from the environment (integer, tokens).
   * Falls back to `DEFAULT_TOKEN_BUDGET` (80,000) if unset or invalid.
   *
   * Used by `ChatSession.checkAndCompressContext()` to decide whether
   * to trigger proactive compression after each turn (ADR-024).
   *
   * @param messages - Raw messages array from agent state.
   * @param overhead - The system prompt and tool definitions, when known.
   * @returns True if the token budget is exceeded.
   *
   * @example
   * ```ts
   * // In .env: MAX_CONTEXT_TOKENS=50000 (trigger earlier)
   * if (ContextCompressor.isOverBudget(messages)) {
   *   await ContextCompressor.compress(messages, summarizerModel);
   * }
   * ```
   */
  public static isOverBudget(
    messages: unknown[],
    overhead: { system?: string; tools?: readonly CountableTool[] } = sessionOverhead(),
  ): boolean {
    const budget = parseInt(process.env.MAX_CONTEXT_TOKENS ?? '', 10);
    const threshold = Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_TOKEN_BUDGET;
    return ContextCompressor.estimateTokens(messages, overhead) > threshold;
  }

  /**
   * Compresses a LangGraph conversation history into a concise summary string.
   *
   * Filters to `HumanMessage` + `AIMessage` only — `ToolMessage` raw outputs are
   * excluded because they are large, noisy, and not useful for context handoff.
   *
   * Applies a fallback chain (ADR-020):
   * 1. Try `summarizerModel` (primary)
   * 2. If primary fails and is not already Ollama → try `ollama:gemma4` (local fallback)
   * 3. If all fail → return `null` (graceful degradation; model switch still completes)
   *
   * @param messages - Raw messages from `agent.getState().values.messages`
   * @param summarizerModel - The model string to use for compression
   * @returns The compressed summary string, or `null` if compression failed entirely
   */
  public static async compress(
    messages: unknown[],
    summarizerModel: string,
  ): Promise<string | null> {
    if (!messages || messages.length < MIN_MESSAGES_FOR_COMPRESSION) {
      return null;
    }

    const dialogue = ContextCompressor.buildDialogue(messages);
    if (!dialogue.trim()) return null;

    // 1. Try primary model
    try {
      return await ContextCompressor.callLLM(summarizerModel, dialogue);
    } catch (primaryErr: unknown) {
      const msg = (primaryErr as Error)?.message ?? String(primaryErr);
      console.warn(`  [ContextCompressor] Primary model (${summarizerModel}) failed: ${msg}`);
    }

    // 2. Fallback to local Ollama (only if primary was a cloud model)
    if (!isOllamaModel(summarizerModel)) {
      try {
        console.warn(`  [ContextCompressor] Attempting fallback with ${OLLAMA_FALLBACK_MODEL}...`);
        return await ContextCompressor.callLLM(OLLAMA_FALLBACK_MODEL, dialogue);
      } catch (fallbackErr: unknown) {
        const msg = (fallbackErr as Error)?.message ?? String(fallbackErr);
        console.warn(`  [ContextCompressor] Fallback model also failed: ${msg}`);
      }
    }

    // 3. Total failure — return null so the model switch can still proceed
    return null;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Builds a readable dialogue string from a LangGraph messages array.
   *
   * Only `HumanMessage` and `AIMessage` are included:
   * - `HumanMessage` → `"Human: <content>"`
   * - `AIMessage`    → `"Assistant: <content>"` (skipped if content is empty)
   * - `ToolMessage`  → **excluded** (raw tool outputs are large and noisy)
   *
   * Handles both string content and array-of-parts content (Gemini format).
   *
   * @param messages - Raw messages array from agent state
   * @returns Newline-separated dialogue string ready for LLM consumption
   */
  private static buildDialogue(messages: unknown[]): string {
    const lines: string[] = [];

    for (const msg of messages) {
      if (msg instanceof HumanMessage) {
        const content = ContextCompressor.extractText(msg.content);
        if (content) lines.push(`Human: ${content}`);
      } else if (msg instanceof AIMessage) {
        const content = ContextCompressor.extractText(msg.content);
        if (content) lines.push(`Assistant: ${content}`);
      }
      // ToolMessage intentionally excluded — raw outputs are large and noisy
    }

    return lines.join('\n\n');
  }

  /**
   * Extracts a plain text string from a LangChain message content value.
   *
   * Handles three formats:
   * - `string` — returned as-is
   * - `Array<{ type: 'text'; text: string } | unknown>` — Gemini array-of-parts
   * - Other — serialized to JSON as a fallback
   *
   * @param content - The raw `message.content` value
   * @returns A plain text string
   */
  private static extractText(content: unknown): string {
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      return content
        .map((part: unknown) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'text' in part) {
            return (part as { text: string }).text ?? '';
          }
          return '';
        })
        .filter(Boolean)
        .join(' ');
    }

    return JSON.stringify(content);
  }

  /**
   * Calls the specified LLM in one-shot mode to generate a compression summary.
   *
   * Uses `LLMProvider.createChatModel()` which already handles Vertex AI and Ollama
   * routing, credential validation, and the `OllamaChatAdapter` serialization fix.
   *
   * @param model - Model string (e.g., `'gemini-2.5-flash-lite'`, `'ollama:gemma4'`)
   * @param dialogue - The formatted conversation text to summarize
   * @returns The summary string from the LLM
   * @throws {Error} If the LLM call fails or returns an unexpected format
   */
  private static async callLLM(model: string, dialogue: string): Promise<string> {
    const llm = LLMProvider.createChatModel(model, 0);

    const response = await llm.invoke([
      { role: 'system', content: COMPRESSION_SYSTEM_PROMPT },
      { role: 'user', content: `Conversation to summarize:\n\n${dialogue}` },
    ]);

    // Normalize the response content (string or array-of-parts)
    return ContextCompressor.extractText(response.content);
  }
}
