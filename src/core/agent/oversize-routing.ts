/**
 * @module OversizeRouting
 *
 * Decides whether a request too large for its model may be sent to a different
 * one instead of being refused.
 *
 * ## Why this is an amendment to ADR-002, not a feature
 *
 * ADR-002 fixed model resolution as `--model` > `AGENT_MODEL` > project
 * profile. Size-based routing inserts a rung the operator did not write, and
 * the danger is specific rather than general: someone who typed
 * `--model ollama:llama3.2` for privacy would have their prompt sent to Vertex.
 * The failure is that it happens **silently**, not that it happens.
 *
 * So the rule David chose is the narrow one: **route only what nobody chose.**
 * An explicit `--model` and a deliberately-set `AGENT_MODEL` are both operator
 * choices and are never overridden — they get the refusal instead. Only the
 * project profile's default, which no person selected for this run, may be
 * routed away from.
 *
 * ## Why the cheapest sufficient model, not the biggest
 *
 * The obvious implementation reaches for the largest window available, which
 * from Haiku means Opus — a five-fold jump in input price for a request whose
 * only sin was being long. Ranking candidates by published input price and
 * taking the cheapest that fits keeps the correction proportionate: on this
 * project's roster that routes Haiku to Sonnet, not to Opus.
 *
 * ## What this module does not do
 *
 * It does not send anything, and it never picks a model whose window is
 * unknown. `contextWindowFor` returning `undefined` means this project cannot
 * size that model, and routing *to* an unmeasurable target would replace a
 * known failure with an unknown one.
 */

import {
  DEFAULT_CONTEXT_WINDOWS,
  bareModelId,
  contextWindowFor,
} from '../infrastructure/config/default-context-windows';
import { DEFAULT_LLM_PRICING } from '../infrastructure/config/default-pricing';
import type { ModelSource } from '../config/model-resolver';

/** The outcome of asking whether an oversized request may be routed. */
export type OversizeDecision =
  | {
      readonly route: true;
      /** Bare id of the model to use instead. */
      readonly to: string;
      readonly window: number;
    }
  | {
      readonly route: false;
      /** Why not, in words fit to show an operator. */
      readonly reason: string;
    };

/** What the decision needs to know. */
export interface OversizeContext {
  /** The model that could not hold the request, routed or bare. */
  readonly model: string;
  /** Who chose it. */
  readonly source: ModelSource;
  /** Counted size of the request. */
  readonly tokens: number;
}

/**
 * Returns the models whose window is known to hold `tokens`, cheapest first.
 *
 * A model with no published input price sorts last rather than being dropped:
 * unknown cost is a reason to prefer something else, not a reason to refuse a
 * model that would work.
 *
 * @param tokens - Size the model must hold.
 * @param exclude - Bare id to leave out, normally the one that failed.
 * @returns Candidate bare ids, cheapest known input price first.
 */
export function candidatesFor(tokens: number, exclude: string): readonly string[] {
  const priceOf = (model: string): number =>
    DEFAULT_LLM_PRICING[model]?.inputMillion ?? Number.POSITIVE_INFINITY;

  return Object.entries(DEFAULT_CONTEXT_WINDOWS)
    .filter(([model, window]) => model !== exclude && window >= tokens)
    .sort(([left], [right]) => priceOf(left) - priceOf(right) || left.localeCompare(right))
    .map(([model]) => model);
}

/**
 * Decides whether an oversized request may go to a different model.
 *
 * @param context - The failed model, who chose it, and the request size.
 * @returns The decision, with a reason whenever it declines.
 */
export function decideOversizeRoute(context: OversizeContext): OversizeDecision {
  if (context.source !== 'profile') {
    return {
      route: false,
      reason:
        context.source === 'explicit'
          ? 'the model was chosen explicitly for this session, and an explicit choice is never overridden (ADR-002)'
          : 'the model comes from AGENT_MODEL, which is a deliberate operator choice and is never overridden (ADR-002)',
    };
  }

  const [cheapest] = candidatesFor(context.tokens, bareModelId(context.model));
  if (cheapest === undefined) {
    return {
      route: false,
      reason: 'no model with a known context window is large enough to hold this request',
    };
  }

  return { route: true, to: cheapest, window: contextWindowFor(cheapest) ?? 0 };
}

/**
 * Explains a routing decision in the turn itself.
 *
 * Announced rather than silent, always. A model swap changes both the price and
 * the answer, and an operator who cannot see it happen cannot reason about
 * either.
 *
 * @param from - The model that could not hold the request.
 * @param decision - What was decided.
 * @param tokens - Counted request size.
 * @returns A line to prefix to the turn.
 */
export function describeOversizeRoute(
  from: string,
  decision: Extract<OversizeDecision, { route: true }>,
  tokens: number,
): string {
  return (
    `ℹ️ This request is ${tokens.toLocaleString()} tokens, which does not fit in ${from}. ` +
    `It was sent to ${decision.to} (${decision.window.toLocaleString()}-token window) instead, ` +
    'because no model was chosen explicitly for this session. ' +
    'Pass --model to pin one and this will not happen.'
  );
}
