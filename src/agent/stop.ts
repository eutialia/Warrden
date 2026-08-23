import type { AccessTier } from '../db/siteProfiles.js';
import { isObjectParseFailure, LlmError } from '../llm/generator.js';
import { errorMessage } from '../util/errors.js';

/**
 * Why one LLM-driven piece of work stopped — the agent loop, one rung of the access ladder,
 * a reflection call, a single-shot generate. Every caller reports the same set of endings in
 * the same words (`describeStop`) and books site failures off the same predicate
 * (`stopIsSiteFault`), so an operator reading a round line, a job failure and a knowledge
 * event sees one vocabulary rather than four hand-written ones.
 */
export type StopReason =
  | { kind: 'done' }
  /** The model stopped on purpose and said why. `because` separates the honest endings from
   * each other: searched-and-empty is not the same as could-not-get-in. */
  | { kind: 'gave-up'; because: GiveUpReason; reason: string }
  /** The step budget ran out with nothing to show. */
  | { kind: 'exhausted' }
  /** Replies that were not the JSON object, after the generator's own repair and retry. */
  | { kind: 'malformed'; failures: number }
  /** Steps aimed at destinations the security guards refused. */
  | { kind: 'refused'; refusals: number }
  /** A bot wall the run could not answer on this rung. */
  | { kind: 'blocked'; tier: AccessTier }
  /** Nothing ran at all: the site was in cooldown or disabled, or no model is configured. */
  | { kind: 'skipped'; why: 'cooldown' | 'disabled' | 'no-model' }
  | { kind: 'error'; message: string; permanent: boolean };

export type GiveUpReason = 'not-found' | 'blocked' | 'unsure';

/** How each give-up reads to a human. The model's own sentence follows it. */
const GAVE_UP: Record<GiveUpReason, string> = {
  'not-found': 'nothing found',
  blocked: 'could not get through',
  unsure: 'could not tell',
};

const SKIPPED: Record<'cooldown' | 'disabled' | 'no-model', string> = {
  cooldown: 'skipped — in failure cooldown',
  disabled: 'skipped — site disabled',
  'no-model': 'no LLM model configured',
};

/** The one place the English for a stop lives. Callers add their own context around it (the
 * site, the round, the tier) and never their own wording for the ending itself. */
export function describeStop(stop: StopReason): string {
  switch (stop.kind) {
    case 'done':
      return 'downloaded';
    case 'gave-up':
      return `gave up (${GAVE_UP[stop.because]}): ${stop.reason}`;
    case 'exhausted':
      return 'step budget exhausted';
    case 'malformed':
      return `${stop.failures} ${stop.failures === 1 ? 'reply was' : 'replies were'} not valid JSON`;
    case 'refused':
      return `${stop.refusals} ${stop.refusals === 1 ? 'step' : 'steps'} targeted a refused address`;
    case 'blocked':
      return `blocked at ${stop.tier}`;
    case 'skipped':
      return SKIPPED[stop.why];
    case 'error':
      return stop.message;
  }
}

/**
 * The stop a thrown error stands for. A reply that would not parse is `malformed` however it
 * was wrapped — that is the model answering the wrong thing, not the call failing — and an
 * `LlmError` carries its own permanence through so the job runner can still fail terminally
 * on something that will fail identically on every retry.
 */
export function stopFromError(err: unknown): StopReason {
  if (isObjectParseFailure(err)) return { kind: 'malformed', failures: 1 };
  return {
    kind: 'error',
    message: errorMessage(err),
    permanent: err instanceof LlmError ? err.permanent : false,
  };
}

/**
 * Whether this ending says something is wrong with the site, and so should cost it a
 * `fail_count` bump and the backoff that follows. A give-up never does, whatever its
 * `because`: the agent looked and said so, and punishing that is how a site an operator
 * configured drifts into a cooldown for telling the truth. A wall does — it is the site
 * refusing us — and so does a run that spent its budget, went malformed, kept aiming at
 * refused addresses, or broke.
 */
export function stopIsSiteFault(stop: StopReason): boolean {
  return ['exhausted', 'malformed', 'refused', 'blocked', 'error'].includes(stop.kind);
}
