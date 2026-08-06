/** Shared byte-unit constants for size math across the acquire pipeline (prefilter's
 * MB-based size window, pick's GB-rendered candidate lines) — one source of truth
 * instead of each call site hand-rolling its own `1_048_576`/`1_073_741_824` literal. */
export const BYTES_PER_MB = 1_048_576;
export const BYTES_PER_GB = 1_073_741_824;
