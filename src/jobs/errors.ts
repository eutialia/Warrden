/**
 * Whether `err` is one no retry can fix (a provider contract error, a prompt the SDK
 * refuses to send), so the runner should fail its job terminally on first sight instead of
 * burning every attempt on the same rejection. Duck-typed rather than `instanceof` so any
 * layer can mark an error permanent without this module importing it. The llm layer's
 * `LlmError` is the main producer.
 */
export function isPermanentError(err: unknown): boolean {
  return hasMarker(err, 'permanent');
}

/**
 * Whether `err` is the provider telling us to slow down (a 429). Retrying a whole pipeline
 * a minute later lands in the same limit, so the runner pushes its retry much further out.
 * Duck-typed like `isPermanentError`, and `LlmError` is likewise the main producer.
 */
export function isRateLimitedError(err: unknown): boolean {
  return hasMarker(err, 'rateLimited');
}

function hasMarker(err: unknown, marker: 'permanent' | 'rateLimited'): boolean {
  return typeof err === 'object' && err !== null && (err as Record<string, unknown>)[marker] === true;
}

/** Thrown by a job handler to say "not an error — run me again after `delayMs`", e.g. the
 * ingest pipeline's settle-wait. The runner catches this before the generic failure path,
 * so it never counts as a retry attempt or surfaces as a warn/attention event. */
export class RescheduleError extends Error {
  constructor(
    message: string,
    public readonly delayMs: number,
  ) {
    super(message);
    this.name = 'RescheduleError';
  }
}
