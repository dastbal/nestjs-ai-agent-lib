/**
 * The token-counting boundary: what Umbra needs to know about a request
 * **before** it is sent.
 *
 * ## Why this exists next to LangSmith and `TurnGovernor`, not instead of them
 *
 * Umbra already measures tokens well, and all of it measures *afterwards*.
 * LangSmith records what a turn cost once the provider has answered, and
 * `TurnGovernor` accumulates `usage_metadata` from the stream. Both are
 * accounting. Neither can appear in an `if`.
 *
 * Four decisions can only be taken with a count that exists before the call:
 *
 * 1. Compressing because the request is at a real share of the context window.
 * 2. Capping a tool result before it is injected — `safe_read_file` returns
 *    whole files today, so one read of a large module can dominate a turn.
 * 3. Routing by size, sending an oversized prompt to the cloud model instead of
 *    the local one.
 * 4. Rejecting a request that exceeds the window without paying for the round
 *    trip and the error.
 *
 * ## Why identity travels with the port
 *
 * Following {@link ../../rag/embeddings/embeddings.port | EmbeddingsPort} and
 * ADR-025: a count is not self-describing. `cl100k_base` is not Claude's
 * tokenizer and not Gemini's, and a number produced by a fallback heuristic is
 * not the same claim as one produced by a real BPE encoder. A caller deciding
 * whether to spend money on a compression pass deserves to know which it got,
 * so `identity` is part of the port rather than an implementation detail.
 */

/** How a count was produced. Never inferred by a caller from the number itself. */
export type TokenCounterMethod =
  /** Real byte-pair encoding. Exact for the encoder named, approximate for other providers. */
  | 'bpe'
  /** Characters divided by a constant. Correct only in order of magnitude. */
  | 'heuristic';

/** Everything needed to interpret a count. */
export interface TokenCounterIdentity {
  readonly method: TokenCounterMethod;
  /** The encoder or heuristic that produced it, e.g. `cl100k_base` or `chars/4`. */
  readonly encoding: string;
  /**
   * Why this counter was chosen, in the provenance style ADR-025 established.
   * Reported rather than assumed, so a silent fallback is visible.
   */
  readonly source: 'encoder' | 'encoder-unavailable';
  /** Present only when the encoder failed, naming the reason. */
  readonly diagnostic?: string;
}

/** One tool as the provider will see it, for schema accounting. */
export interface CountableTool {
  readonly name: string;
  readonly description?: string;
  /** The JSON schema the provider receives. Serialized as-is for counting. */
  readonly schema?: unknown;
}

/** Everything that will be sent, not merely the visible conversation. */
export interface CountableRequest {
  /** The system prompt, which is charged on every single turn. */
  readonly system?: string;
  /**
   * Tool definitions. For a deep agent these are thousands of fixed tokens per
   * request and were entirely absent from the previous estimate.
   */
  readonly tools?: readonly CountableTool[];
  /** Raw LangGraph/LangChain messages, class instances or plain objects. */
  readonly messages: readonly unknown[];
}

/**
 * A count broken down by where the tokens come from.
 *
 * The breakdown is the point. "You are at 68% of the window" is not actionable;
 * "you are at 68%, and 40% of it is tool schemas" is.
 */
export interface RequestTokenCount {
  readonly system: number;
  readonly toolSchemas: number;
  /** Text content of every message. */
  readonly messages: number;
  /** Arguments of tool calls, which are request payload and were never counted. */
  readonly toolCallArguments: number;
  /** Per-message framing the provider adds around the content. */
  readonly framing: number;
  readonly total: number;
}

/** Counts tokens without contacting a provider. */
export interface TokenCounterPort {
  /** How this counter produced its numbers. */
  readonly identity: TokenCounterIdentity;

  /**
   * Counts one string.
   *
   * @param text - The text to count.
   * @returns Token count, never negative.
   */
  countText(text: string): number;

  /**
   * Counts a complete request, broken down by origin.
   *
   * @param request - Everything that will be sent.
   * @returns The breakdown and its total.
   */
  countRequest(request: CountableRequest): RequestTokenCount;
}
