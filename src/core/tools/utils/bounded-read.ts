/**
 * @module BoundedRead
 *
 * Caps how much of a file a read tool may inject into the context, using a
 * real token count taken **before** the content reaches the model.
 *
 * ## Why a cap, and why here
 *
 * `safe_read_file` returned whole files. One read of a 1,400-line module is
 * tens of thousands of tokens spent in a single tool result, and nothing in
 * the turn noticed: `TurnGovernor` sees the cost after the provider has
 * answered, and `ContextCompressor` reacted to a size it measured without
 * counting tool payloads at all. The read is the mechanism by which a turn
 * explodes, so the read is where the ceiling belongs.
 *
 * ## Why the head, and why it says so
 *
 * Truncation keeps the beginning of the file: imports, the module docblock and
 * the class signature are what identify a file and what a later, targeted read
 * is planned from. The result then states what was withheld and how to get it.
 * A silent truncation would be worse than no cap — the model would reason
 * about a file it believes it has read in full, and confidently conclude that
 * a symbol below the cut does not exist.
 */

import { tokenCounter } from '../../llm/tokens/token-counter';

/**
 * Default token ceiling for one file read.
 *
 * 6,000 tokens is roughly a 600-line TypeScript module — large enough that
 * ordinary reads are untouched, small enough that no single read can dominate
 * a turn. Override with `UMBRA_MAX_READ_TOKENS`.
 */
const DEFAULT_MAX_READ_TOKENS = 6_000;

/** The outcome of applying the ceiling to one file. */
export interface BoundedContent {
  /** The content to hand to the model, already truncated if it had to be. */
  readonly content: string;
  readonly truncated: boolean;
  /** Tokens the full file would have cost. */
  readonly totalTokens: number;
  /** Lines kept, and the file's total, when truncated. */
  readonly keptLines: number;
  readonly totalLines: number;
}

/**
 * Reads the configured ceiling.
 *
 * @returns The ceiling in tokens, falling back to the default when unset or
 *          not a positive integer.
 */
export function maxReadTokens(): number {
  const configured = Number.parseInt(process.env.UMBRA_MAX_READ_TOKENS ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_READ_TOKENS;
}

/**
 * Applies the token ceiling to one file's content.
 *
 * Cuts on a line boundary by bisecting on the line count, so the result is
 * always valid text rather than a string severed mid-token. The search costs a
 * handful of counts on a file large enough to need it, and none at all on a
 * file that fits — which is almost every read.
 *
 * @param filePath - Path, used only in the notice.
 * @param content - The full file content.
 * @param limit - Token ceiling; defaults to {@link maxReadTokens}.
 * @returns The bounded content and what was done to it.
 */
export function boundFileContent(
  filePath: string,
  content: string,
  limit: number = maxReadTokens(),
): BoundedContent {
  const counter = tokenCounter();
  const totalTokens = counter.countText(content);
  const lines = content.split('\n');

  if (totalTokens <= limit) {
    return {
      content,
      truncated: false,
      totalTokens,
      keptLines: lines.length,
      totalLines: lines.length,
    };
  }

  // Largest line count whose text still fits. Bisection rather than a
  // per-line loop: counting is the expensive operation, and a 20,000-line
  // file would otherwise cost 20,000 encodes to trim.
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (counter.countText(lines.slice(0, middle).join('\n')) <= limit) low = middle;
    else high = middle - 1;
  }

  const kept = lines.slice(0, low).join('\n');
  const withheld = lines.length - low;

  return {
    content: [
      kept,
      '',
      `--- TRUNCATED: ${withheld} of ${lines.length} lines withheld ---`,
      `${filePath} is ${totalTokens} tokens, above the ${limit}-token read ceiling.`,
      `You have lines 1-${low}. The rest was NOT read: do not conclude that a symbol is absent from this file.`,
      'To see more, grep for the symbol you need, or raise UMBRA_MAX_READ_TOKENS.',
    ].join('\n'),
    truncated: true,
    totalTokens,
    keptLines: low,
    totalLines: lines.length,
  };
}
