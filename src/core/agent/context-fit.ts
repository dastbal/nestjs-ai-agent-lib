/**
 * @module ContextFit
 *
 * Decides whether a request can fit in the model's context window, before it
 * is sent.
 *
 * ## Why refuse locally rather than let the provider do it
 *
 * A request that exceeds the window fails at the provider. That failure costs
 * the round trip, arrives as a message about token limits that says nothing
 * about which part of the conversation is large, and — in an agentic loop —
 * lands as a tool-cycle error that ADR-007's self-healing then treats as a
 * session to reset. The operator sees a session restart and no cause.
 *
 * Deciding here costs one local BPE count, names the numbers, and says which
 * model was asked.
 *
 * ## What it deliberately will not do
 *
 * It will not refuse a model whose window is unknown. `contextWindowFor`
 * returns `undefined` for anything not in the shipped table, and treating that
 * as zero would refuse every Gemini and Ollama request in the project. Unknown
 * means the check abstains — the same discipline the retrieval work arrived at:
 * a missing denominator is reported, never substituted.
 *
 * It also does not compress, route, or retry. Those are separate decisions,
 * and one of them — routing to a different model — contradicts ADR-002 until
 * David amends it. This module answers one question and returns.
 */

import { contextWindowFor } from '../infrastructure/config/default-context-windows';
import { tokenCounter } from '../llm/tokens/token-counter';
import type { CountableTool } from '../llm/tokens/token-counter.port';

/** The request about to be sent, in the shape the counter reads. */
export interface ContextFitRequest {
  /** Model identifier, routed (`vertex-anthropic:...`) or bare. */
  readonly model: string;
  readonly system?: string;
  readonly tools?: readonly CountableTool[];
  readonly messages: readonly unknown[];
}

/** Whether the request fits, and why not when it does not. */
export interface ContextFitResult {
  /** False only when the window is known **and** exceeded. */
  readonly fits: boolean;
  /** Counted request size. Always present; the count runs regardless. */
  readonly tokens: number;
  /** The model's limit, or `undefined` when this project does not know it. */
  readonly window?: number;
  /** Share of the window used, or `undefined` when the window is unknown. */
  readonly usedFraction?: number;
}

/**
 * Counts the request and compares it with the model's window.
 *
 * @param request - Everything that will be sent.
 * @returns The verdict, with the numbers that produced it.
 */
export function checkContextFit(request: ContextFitRequest): ContextFitResult {
  const tokens = tokenCounter().countRequest({
    system: request.system,
    tools: request.tools,
    messages: request.messages,
  }).total;

  const window = contextWindowFor(request.model);
  if (window === undefined) return { fits: true, tokens };

  return {
    fits: tokens <= window,
    tokens,
    window,
    usedFraction: tokens / window,
  };
}

/**
 * Explains a refusal in terms the operator can act on.
 *
 * Names the model, both numbers, and the overshoot. A message that says only
 * "context length exceeded" leaves the reader to guess whether to compress,
 * switch model, or split the task.
 *
 * @param model - The model that was asked.
 * @param result - The failed check.
 * @returns Text safe to show to an operator and to a model.
 */
export function describeContextOverflow(model: string, result: ContextFitResult): string {
  const window = result.window ?? 0;
  const over = result.tokens - window;

  return [
    `⚠️ This request does not fit in ${model}.`,
    '',
    `It counts ${result.tokens.toLocaleString()} input tokens against a window of ` +
      `${window.toLocaleString()} — ${over.toLocaleString()} over.`,
    '',
    'It was not sent, so nothing was charged for it. Options: start a new session,',
    'compress the conversation, split the task, or choose a model with a larger window.',
  ].join('\n');
}
