/** Renders any thrown value as a message string: an `Error`'s own `.message`, or
 * `String(err)` for anything else (a thrown string, object, etc.) — the one-liner every
 * `catch (err: unknown)` block across the codebase needs to turn `err` into event/log
 * text. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
