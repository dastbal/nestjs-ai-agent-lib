/**
 * @module DefaultContextWindows
 *
 * How much input each model can hold, in tokens.
 *
 * ## Why this exists separately from pricing
 *
 * A pre-call token count is only actionable against a limit. Without one, a
 * counter can say "this request is 240,000 tokens" and nothing can act on it:
 * whether that fits is the whole question. This is the missing half of ADR-031
 * phase 2, and both early rejection and any future size-based routing are
 * blocked on it rather than on the counting.
 *
 * ## Unknown is a value, not a zero
 *
 * `DEFAULT_LLM_PRICING` carries a lesson this table inherits: a missing entry
 * there once meant "no price", which the cost tracker reported as a cost of
 * **zero** rather than as an absence. A missing window must never read as
 * "unlimited" for the same reason — that failure is worse, because it turns a
 * guard into a rubber stamp precisely when the request is enormous.
 *
 * So {@link contextWindowFor} returns `undefined`, and every caller has to
 * decide what to do with a model it cannot size. The answer this project takes
 * is to let the request through and say nothing: refusing a request because we
 * do not know a number would break every model not listed here.
 *
 * ## Why Gemini and Ollama models are absent
 *
 * Deliberately, and it is the point rather than an omission. This table holds
 * only figures taken from a source, and Gemini's per-model windows were not
 * available to whoever wrote it. Filling them from memory would produce a table
 * that looks complete and is wrong in the direction that hurts — a window
 * guessed too large rejects nothing and silently blesses an oversized request.
 *
 * Ollama is a different case again: the window is a property of the local
 * install's `num_ctx`, not of the model name, so a static table cannot be right
 * about it at all. Both are better served by the runtime lookups noted below.
 *
 * ## Where the real numbers live
 *
 * These are cached facts, and a cached fact ages. Anthropic's Models API
 * returns `max_input_tokens` per model (there is no `context_window` field),
 * and Ollama reports the loaded context through its own API. A future
 * improvement is to read either at startup and treat this table as the offline
 * fallback — which is the shape ADR-025 already uses for embedding identity:
 * resolved at runtime, pinned at launch, never inferred from a name.
 *
 * @see DEFAULT_LLM_PRICING for the pattern this follows, and the defect that
 *      shaped it.
 */

/**
 * Input-token limits per model, from Anthropic's published model table
 * (cached 2026-06-24).
 *
 * Keys are bare model ids. A caller holding a routed identifier such as
 * `vertex-anthropic:claude-sonnet-5` must strip the route first;
 * {@link contextWindowFor} does that.
 */
export const DEFAULT_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

/**
 * Strips a provider route and any dated snapshot suffix from a model id.
 *
 * `vertex-anthropic:claude-haiku-4-5@20251001` and `claude-haiku-4-5` are the
 * same model with the same window; the route says where it is served from and
 * the `@` suffix pins a snapshot, and neither changes how much it can hold.
 *
 * @param model - A model identifier as configured or typed by an operator.
 * @returns The bare model id.
 */
export function bareModelId(model: string): string {
  const withoutRoute = model.includes(':') ? model.slice(model.lastIndexOf(':') + 1) : model;
  const withoutSnapshot = withoutRoute.split('@')[0] ?? withoutRoute;
  return withoutSnapshot.trim();
}

/**
 * Returns a model's input-token limit, or `undefined` when it is not known.
 *
 * `undefined` is the honest answer for an unlisted model and must be handled as
 * "no limit information", never as "no limit".
 *
 * @param model - A model identifier, routed or bare.
 * @returns The window in tokens, or `undefined`.
 */
export function contextWindowFor(model: string): number | undefined {
  return DEFAULT_CONTEXT_WINDOWS[bareModelId(model)];
}
