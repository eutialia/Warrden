import type { EventRow } from '@/api';
import type { StepFeedItem } from '@/components/activity/StepFeed';
import { envelopeOf, type EventFacts } from '@/lib/eventEnvelope';
import { tierLabel } from '@/lib/labels';
import type { Tone } from '@/lib/tone';
import { formatReleaseSize } from '@/lib/utils';

/**
 * One event as one feed row, composed entirely from the envelope's facts
 * (`@/lib/eventEnvelope`).
 *
 * `message` is deliberately not read. It is the composed human line the backend writes for
 * `docker logs` and the CLI; using it here is what forced the old regex ladder, and it is
 * the reason a season read as `Season 4` in one row and `S4` in the next depending on which
 * emitter wrote it. Labels are the dashboard's business now, and there is exactly one place
 * that spells them.
 */

/**
 * Sentence-case copy, keyed `scope:action`.
 *
 * Scoped rather than by bare action because an agent transcript step's action is the
 * model's OWN verb — an open vocabulary that already reads as English (`search`, `open`,
 * `download`, `escalate`) and must fall through untranslated. Keying on the action alone
 * would let `acquire:search`'s copy hijack the agent's `search` step.
 */
const ACTION_COPY: Record<string, string> = {
  'subtitle:visit': 'Visit ended',
  'subtitle:placed': 'Placed',
  'subtitle:resynced': 'Resynced',
  'subtitle:quarantined': 'Set aside',
  'subtitle:unresolved': 'Still missing',
  'subtitle:missing': 'Missing subtitles',
  'subtitle:complete': 'Nothing missing',
  'subtitle:cache-hit': 'Covered from cache',
  'subtitle:site-failed': 'Site failed',
  'subtitle:site-exhausted': 'Site exhausted',
  'subtitle:site-unusable': 'Site looks unusable',
  'subtitle:pack-empty': 'Pack was empty',
  'trigger:webhook': 'Webhook',
  'trigger:reconcile': 'Reconcile scan',
  'trigger:manual': 'Manual trigger',
  'run:attention': 'Needs a human',
  'run:rescheduled': 'Waiting',
  'acquire:search': 'Searched',
  'acquire:filter': 'Filtered',
  'acquire:pick': 'Pick',
  'acquire:no-candidates': 'No releases found',
  'acquire:none-viable': 'Nothing good enough',
  'acquire:already-satisfied': 'Already have it',
  'acquire:skip-unaired': 'Skipped — not aired',
  'acquire:skip-already-grabbed': 'Skipped — already grabbed',
  'ingest:placed': 'Placed',
  'ingest:rescued': 'Imported leftovers',
  'ingest:rescue-proposed': 'Needs your OK',
  'ingest:unmatched': 'Could not match',
};

/** `run:finished` covers both endings `reportRunFinished`/`reportRunFailed` write
 * (`src/jobs/finished.ts`), told apart by `facts.error`: absent means the run completed,
 * present means it threw. A retried throw goes around again — that is an attempt failing,
 * not the run concluding — so it earns its own copy instead of `run:finished`'s. */
function runFinishedLabel(facts: EventFacts): string {
  if (facts.error === undefined) return 'Run finished';
  return facts.retried === true ? 'Attempt failed, retrying' : 'Run failed';
}

function actionLabel(scope: string, action: string, facts: EventFacts): string {
  if (scope === 'run' && action === 'finished') return runFinishedLabel(facts);
  return ACTION_COPY[`${scope}:${action}`] ?? action;
}

/** The facts worth putting on the one line that stays on screen, in the order they read. */
function highlights(facts: EventFacts): string[] {
  const out: string[] = [];
  if (facts.season !== undefined) out.push(`S${facts.season}`);
  if (facts.episodes !== undefined && facts.episodes.length > 0) out.push(episodeSummary(facts.episodes));
  if (facts.release?.title !== undefined) out.push(facts.release.title);
  if (facts.release?.quality !== undefined) out.push(facts.release.quality);
  if (facts.release?.group !== undefined) out.push(facts.release.group);
  if (facts.file !== undefined) out.push(basename(facts.file.path));
  if (facts.tier !== undefined) out.push(tierLabel(facts.tier as never));
  if (facts.steps !== undefined) out.push(`${facts.steps} step${facts.steps === 1 ? '' : 's'}`);
  for (const [name, n] of Object.entries(facts.counts ?? {})) {
    if (n !== 0) out.push(`${n} ${name}`);
  }
  if (facts.languages !== undefined && facts.languages.length > 0) out.push(facts.languages.join(', '));
  return out;
}

/**
 * `S2E21-E23, S3E1` — a range per season, never one row per episode.
 *
 * `pad` zero-fills each number to that width. A row about a scope (what a subtitle run is
 * still missing) reads as plain numbers; a row about one imported FILE uses `pad: 2`,
 * because `S02E08` is how the arr itself names that file and the row sits next to it.
 */
export function episodeSummary(episodes: { season: number; episode: number }[], pad = 0): string {
  const n = (value: number) => String(value).padStart(pad, '0');
  const bySeason = new Map<number, number[]>();
  for (const e of episodes) bySeason.set(e.season, [...(bySeason.get(e.season) ?? []), e.episode]);
  return [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, eps]) => {
      const sorted = [...new Set(eps)].sort((a, b) => a - b);
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      return sorted.length === 1 ? `S${n(season)}E${n(first)}` : `S${n(season)}E${n(first)}-E${n(last)}`;
    })
    .join(', ');
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function stepParts(event: EventRow): { label: string; detail: string } {
  const envelope = envelopeOf(event);
  // No message fallback by design: every stored row is migrated or deleted, so a row with
  // no envelope is a bug worth seeing, not something to paper over.
  if (envelope === null) return { label: event.kind, detail: event.kind };

  const facts = envelope.facts ?? {};
  const head = [facts.site, actionLabel(envelope.scope, envelope.action, facts), ...highlights(facts)].filter(isPresent);
  const label = head.length > 0 ? head.join(' · ') : event.kind;
  const detail = facts.detail ?? facts.reason ?? facts.error ?? label;
  return { label, detail };
}

/** A step's colour. The envelope's own verdict wins where an emitter recorded one; `warn`
 * stays uncoloured, as it always has — half a healthy run records retryable stumbles, and
 * painting those amber makes a working run look broken. */
export function stepTone(event: EventRow): Tone | undefined {
  const verdict = envelopeOf(event)?.verdict;
  if (verdict !== undefined && verdict.tone !== 'neutral') return verdict.tone;
  return event.level === 'attention' ? 'warning' : undefined;
}

/** One event as one feed row. Exported because every feed over an event log needs the same
 * label/detail split, whatever else it renders around the steps. */
export function eventStep(event: EventRow, folded = 1): StepFeedItem {
  const { label, detail } = stepParts(event);
  const tone = stepTone(event);
  return {
    id: event.id,
    ts: event.ts,
    ...(tone === undefined ? {} : { tone }),
    // A folded burst says how many rows it stands for; a lone row says nothing extra.
    label: folded > 1 ? `${label} · ×${folded}` : label,
    detail,
  };
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

// ---------------------------------------------------------------------------
// imports — one row per file, out of the Download webhook that announced it
// ---------------------------------------------------------------------------

/**
 * Whether a row can stand on its own as an import.
 *
 * A season pack fires one Download webhook per file and every one of them coalesces onto
 * the same ingest job, so before the webhook schema kept its fields there was nothing to
 * say about any single one of them and the whole burst folded into `Webhook · ×34`. A row
 * that carries the file (or, for a webhook whose arr sent no file block, at least the
 * episodes) has something of its own to say and gets its own line.
 */
export function isImport(event: EventRow): boolean {
  const envelope = envelopeOf(event);
  if (envelope?.scope !== 'trigger' || envelope.action !== 'webhook') return false;
  const facts = envelope.facts ?? {};
  return facts.file !== undefined || (facts.episodes?.length ?? 0) > 0;
}

/**
 * One imported file as one row: `S02E08 · imported · WEBDL-1080p`, with the episode title,
 * the group, the size and the container's own subtitle tracks on hover.
 *
 * A movie names itself instead of an episode tag — the same composer, because the facts are
 * the same facts and nothing here knows which arr sent them.
 */
export function importStep(event: EventRow): StepFeedItem {
  const facts = envelopeOf(event)?.facts ?? {};
  const episodes = facts.episodes ?? [];
  const subject = episodes.length > 0 ? episodeSummary(episodes, 2) : facts.title;
  const label = [subject, facts.reason === 'upgrade' ? 'upgraded' : 'imported', facts.file?.quality].filter(isPresent).join(' · ');

  const titles = episodes.map((e) => e.title).filter(isPresent);
  const subs = facts.file?.subs ?? [];
  const detail = [
    titles.length > 0 ? titles.join(', ') : undefined,
    facts.file?.group,
    facts.file?.size === undefined ? undefined : formatReleaseSize(facts.file.size),
    subs.length > 0 ? `embedded subs: ${subs.join(', ')}` : undefined,
  ]
    .filter(isPresent)
    .join(' · ');

  return {
    id: event.id,
    ts: event.ts,
    label,
    // A file with no group, no size and no tracks has nothing to add on hover; repeating the
    // line beats an empty card.
    detail: detail === '' ? label : detail,
  };
}
