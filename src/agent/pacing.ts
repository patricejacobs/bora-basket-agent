/**
 * Makes replies arrive the way a person sends them.
 *
 * A single perfectly-composed block landing instantly is the strongest tell
 * that nobody is typing. Two things fix most of it: sending a trailing question
 * as its own message, and taking a plausible amount of time over each one.
 */

/**
 * Below this, a reply is already short enough to send whole. Tuned against real
 * replies from the live agent: a product list with a closing question runs
 * 120-300 characters, while a plain acknowledgement stays well under 100.
 */
const MIN_LENGTH_TO_SPLIT = 120;
/** A trailing fragment longer than this is a paragraph, not a follow-up line. */
const MAX_TRAILING_LENGTH = 140;

/**
 * Splits a reply into at most two messages, breaking before a short closing
 * question so it lands separately — the shape of "here are the options" then
 * "which one?". Returns one message when there is no natural break.
 */
export function splitReply(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length < MIN_LENGTH_TO_SPLIT) return [trimmed];

  const breakAt = trimmed.lastIndexOf('\n\n');
  if (breakAt === -1) return [trimmed];

  const head = trimmed.slice(0, breakAt).trim();
  const tail = trimmed.slice(breakAt).trim();

  // Only split when the tail reads as a closing line, and the head still
  // carries enough to stand on its own.
  if (!head || !tail) return [trimmed];
  if (tail.length > MAX_TRAILING_LENGTH) return [trimmed];
  if (tail.includes('\n')) return [trimmed];
  if (head.length < 60) return [trimmed];

  return [head, tail];
}

/**
 * How long someone would plausibly take to type this, capped so the shop never
 * feels slow. The model has usually already spent a few seconds thinking, which
 * is why the first message of a turn is sent without any added delay.
 */
export function typingDelayMs(text: string): number {
  const perCharacter = 18;
  const floor = 700;
  const ceiling = 2600;
  return Math.min(ceiling, Math.max(floor, text.length * perCharacter));
}

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
