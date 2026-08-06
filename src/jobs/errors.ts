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
