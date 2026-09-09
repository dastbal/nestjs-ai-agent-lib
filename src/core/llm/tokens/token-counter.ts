/**
 * @module TokenCounter
 *
 * The counter Umbra uses to decide things before a request is sent.
 *
 * ## Why byte-pair encoding rather than `chars / 4`
 *
 * `chars / 4` is not wrong by a small constant, it is wrong by a factor that
 * depends on the content. Measured on one line of this repository's own source:
 *
 * ```
 * export function cosineSimilarity(vecA: ArrayLike<number>): number {}
 *   68 characters -> 17 tokens by chars/4, 14 by cl100k_base
 * ```
 *
 * Twenty-one percent high there, and it goes the other way on dense
 * identifiers and minified JSON. A guard that fires at 80% of a window while
 * being 20% wrong is a guard that fires at anywhere between 64% and 96%.
 *
 * ## Why `cl100k_base` when Umbra talks to Claude and Gemini
 *
 * It is not their tokenizer, and this module never claims it is — that is what
 * {@link TokenCounterIdentity} is for. It is a real BPE encoder trained on the
 * same kind of text, it runs locally and synchronously with no network and no
 * cost, and it is already in the dependency tree through `@langchain/core`.
 *
 * The alternative, calling each provider's own `countTokens` endpoint, is exact
 * and unusable for this purpose: it is a network round trip, so it cannot be
 * consulted inside the branch that decides whether to make a network round
 * trip. It belongs in a later calibration pass that measures this counter's
 * error against the real one, not in the hot path.
 */

import {
  type CountableRequest,
  type RequestTokenCount,
  type TokenCounterIdentity,
  type TokenCounterPort,
} from './token-counter.port';
import { requestTextOf } from './request-shape';

/** The encoder used when one can be loaded. */
const ENCODING = 'cl100k_base';

/** The only part of the encoder this module uses. */
interface Encoder {
  encode(text: string): readonly unknown[];
}

/**
 * Loads the BPE encoder, or reports why it could not.
 *
 * ## Why `require` rather than `import`
 *
 * `js-tiktoken` declares `"type": "module"` and ships only `index.d.ts` — no
 * `.d.cts`. Under this project's `moduleResolution: "Node16"`, TypeScript
 * therefore classifies its types as ESM and rejects importing them from a
 * CommonJS file, even though the package *does* publish a `require` condition
 * pointing at a working `dist/index.cjs`. The obstacle is the type
 * declarations, not the runtime. This is the same packaging shape as the
 * `uuid@13` finding recorded in `docs/deferred-work.md`.
 *
 * Two alternatives were rejected:
 *
 * - **`await import(...)`** would make counting asynchronous, which destroys
 *   the property this module exists for: a count you can put inside an `if`
 *   before deciding whether to make a network call.
 * - **`@langchain/core/utils/tiktoken`** is already a direct dependency and has
 *   correct dual types, but its `getEncoding` is async *and* downloads the rank
 *   table from `https://tiktoken.pages.dev` on first use. A token counter that
 *   needs the network to count is unusable for an offline-first tool, and would
 *   fail exactly where Ollama users expect Umbra to work.
 *
 * So the module is required at runtime behind {@link Encoder}, the narrowest
 * possible surface, and a failure degrades to the heuristic rather than
 * throwing.
 *
 * @returns The encoder, or `undefined` with the reason recorded by the caller.
 */
function loadEncoder(): Encoder {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const module = require('js-tiktoken') as {
    getEncoding(name: string): Encoder;
  };
  return module.getEncoding(ENCODING);
}

/**
 * Characters per token when no encoder is available.
 *
 * Kept at 4 deliberately: it is the constant `ContextCompressor` already used,
 * so the fallback path reproduces today's behaviour rather than introducing a
 * third, differently-wrong number.
 */
const FALLBACK_CHARS_PER_TOKEN = 4;

/**
 * Tokens a provider adds around each message for role markers and delimiters.
 *
 * Approximate by nature and provider-specific in detail; three is the figure
 * OpenAI documents for its chat format and Anthropic's overhead is the same
 * order. It is included rather than ignored because a long conversation of
 * short messages is otherwise undercounted by hundreds of tokens, and
 * undercounting is the direction that causes an overflow.
 */
const PER_MESSAGE_FRAMING_TOKENS = 3;

/**
 * Counts tokens locally, with a declared fallback when the encoder cannot load.
 *
 * Loading is attempted once per instance. A failure is recorded in
 * {@link identity} rather than thrown: a counter that refuses to work would
 * take down the turn it exists to protect, and a silent downgrade would be the
 * failure shape ADR-017 was written about — so it degrades, and says so.
 */
export class LocalTokenCounter implements TokenCounterPort {
  private readonly encoder?: Encoder;

  public readonly identity: TokenCounterIdentity;

  constructor() {
    try {
      this.encoder = loadEncoder();
      this.identity = { method: 'bpe', encoding: ENCODING, source: 'encoder' };
    } catch (error: unknown) {
      this.identity = {
        method: 'heuristic',
        encoding: `chars/${FALLBACK_CHARS_PER_TOKEN}`,
        source: 'encoder-unavailable',
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Counts one string.
   *
   * @param text - The text to count.
   * @returns Token count; `0` for empty input.
   */
  public countText(text: string): number {
    if (!text) return 0;
    if (this.encoder) return this.encoder.encode(text).length;
    return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
  }

  /**
   * Counts a complete request, broken down by where the tokens come from.
   *
   * @param request - The system prompt, tool definitions and messages.
   * @returns The breakdown and its total.
   */
  public countRequest(request: CountableRequest): RequestTokenCount {
    const text = requestTextOf(request);
    const sum = (values: readonly string[]): number =>
      values.reduce((total, value) => total + this.countText(value), 0);

    const system = this.countText(text.system);
    const toolSchemas = sum(text.toolSchemas);
    const messages = sum(text.messages);
    const toolCallArguments = sum(text.toolCallArguments);
    const framing = text.messageCount * PER_MESSAGE_FRAMING_TOKENS;

    return {
      system,
      toolSchemas,
      messages,
      toolCallArguments,
      framing,
      total: system + toolSchemas + messages + toolCallArguments + framing,
    };
  }
}

let shared: TokenCounterPort | undefined;

/**
 * Returns the process-wide counter, building it on first use.
 *
 * Shared because loading the BPE ranks is the only expensive part and it is
 * identical for every caller. Exposed as the port type so a caller cannot
 * reach past it into the implementation.
 *
 * @returns The counter.
 */
export function tokenCounter(): TokenCounterPort {
  if (!shared) shared = new LocalTokenCounter();
  return shared;
}

/**
 * Replaces the shared counter. Tests only.
 *
 * @param counter - The counter to install, or `undefined` to reset.
 */
export function setTokenCounterForTesting(counter: TokenCounterPort | undefined): void {
  shared = counter;
}
