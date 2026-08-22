import { Captions, FolderInput, Radar, type LucideIcon } from 'lucide-react';
import type {
  AccessTier,
  AcquireStatus,
  ArrCheck,
  Job,
  JobStatus,
  ManagedObjectKind,
  StorageCheckStatus,
  TargetKind,
  TraceEntry,
} from '@/api';
import type { Tone } from '@/lib/tone';

/** Pipeline enum → short human name. */
export function pipelineLabel(pipeline: string): string {
  switch (pipeline) {
    case 'acquire':
      return 'Find release';
    case 'ingest':
      return 'Import cleanup';
    case 'subtitle':
      return 'Subtitles';
    default:
      return pipeline;
  }
}

/** Pipeline → icon. Pipelines are categories, so they get a shape rather than a
 * colour — colour stays reserved for status (see `lib/tone.ts`). */
export function pipelineIcon(pipeline: string): LucideIcon | null {
  switch (pipeline) {
    case 'acquire':
      return Radar;
    case 'ingest':
      return FolderInput;
    case 'subtitle':
      return Captions;
    default:
      return null;
  }
}

export function jobStatusLabel(status: JobStatus): string {
  switch (status) {
    case 'pending':
      return 'Waiting';
    case 'running':
      return 'In progress';
    case 'done':
      return 'Finished';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

export function jobStatusTone(status: JobStatus): Tone {
  switch (status) {
    case 'pending':
      return 'neutral';
    case 'running':
      return 'info';
    case 'done':
      return 'success';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** A trace entry's own status. `interrupted` isn't a stored status: it's a `running` entry
 * on a job that has already finished, so it wants a human's eye rather than a spinner. */
export function traceStatusLabel(status: TraceEntry['status'], interrupted: boolean): string {
  if (interrupted) return 'interrupted';
  return status;
}

export function traceStatusTone(status: TraceEntry['status'], interrupted: boolean): Tone {
  if (interrupted) return 'warning';
  switch (status) {
    case 'ok':
      return 'success';
    case 'error':
      return 'danger';
    default:
      return 'info';
  }
}

export function acquireOutcomeLabel(outcome: AcquireStatus): string {
  switch (outcome) {
    case 'grabbed':
      return 'Grabbed a release';
    case 'none-viable':
      return 'Nothing good enough';
    case 'no-candidates':
      return 'No releases found';
    case 'already-satisfied':
      return 'Already have it';
    default:
      return outcome;
  }
}

/** A finished acquire that grabbed nothing is not a failure, it is a dead end a human may
 * want to act on. "Already have it" is neither: nothing is missing and nobody is needed. */
export function acquireOutcomeTone(outcome: AcquireStatus): Tone {
  return outcome === 'grabbed' || outcome === 'already-satisfied' ? 'success' : 'warning';
}

/**
 * What a run actually did, as one chip. Replaces showing queue status and acquire outcome
 * side by side, which produced rows reading "Finished" next to "No releases found".
 *
 * A run's own narration lives in RunDetail, which fetches the job's events. This function
 * only ever sees a bare Job, so do not re-add an events parameter that no caller can feed.
 */
export function runOutcome(job: Job): { label: string; tone: Tone } {
  if (job.status === 'failed') return { label: 'Failed', tone: 'danger' };
  if (job.status === 'running') return { label: 'In progress', tone: 'info' };
  if (job.status === 'pending') return { label: 'Waiting', tone: 'neutral' };

  if (job.pipeline === 'acquire' && job.acquireOutcome) {
    return { label: acquireOutcomeLabel(job.acquireOutcome), tone: acquireOutcomeTone(job.acquireOutcome) };
  }

  return { label: 'Finished', tone: 'success' };
}

/** Pack / multi / single as short sentence-case copy for release facts. */
export function releaseShapeLabel(shape: 'pack' | 'multi' | 'single' | null | undefined): string {
  switch (shape) {
    case 'pack':
      return 'Season pack';
    case 'multi':
      return 'Multi-episode';
    case 'single':
      return 'Single episode';
    default:
      return '—';
  }
}

export function targetKindLabel(kind: TargetKind): string {
  return kind === 'movie' ? 'Movie' : 'Series';
}

export function managedKindLabel(kind: ManagedObjectKind): string {
  switch (kind) {
    case 'notification':
      return 'Webhook';
    case 'tag':
      return 'Tag';
    case 'release_profile':
      return 'Release profile';
    default:
      return kind;
  }
}

export function tierLabel(tier: AccessTier | null | undefined): string {
  if (!tier) return 'Not tried yet';
  switch (tier) {
    case 'curl':
      return 'Fast HTTP';
    case 'chromium':
      return 'Browser';
    case 'camoufox':
      return 'Stealth browser';
    case 'remote':
      return 'Remote browser';
    default:
      return tier;
  }
}

/** A subtitle site run's own status. Its vocabulary is the agent's, not the job
 * queue's, so it gets its own mapping rather than reusing `jobStatusLabel`. */
export function subtitleRunLabel(status: string): string {
  switch (status) {
    case 'done':
      return 'Finished';
    case 'failed':
      return 'Failed';
    case 'running':
      return 'Searching';
    default:
      return status;
  }
}

export function subtitleRunTone(status: string): Tone {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'danger';
    default:
      return 'info';
  }
}

/** How a placed subtitle's timing turned out, as one chip. */
export function subtitleDriftLabel(drift: string, offsetMs: number | null): string {
  if (drift === 'resynced') {
    if (offsetMs === null || offsetMs === 0) return 'Resynced';
    const sign = offsetMs >= 0 ? '+' : '';
    return `Resynced ${sign}${offsetMs}ms`;
  }
  if (drift === 'in-sync') return 'In sync';
  if (drift === 'unverified') return 'Unverified timing';
  return drift;
}

export function storageStatusLabel(status: StorageCheckStatus): string {
  switch (status) {
    case 'ok':
      return 'Reachable';
    case 'not-configured':
      return 'Not set';
    case 'missing':
      return 'Missing';
    case 'looks-unmounted':
      return 'Looks unmounted';
    case 'unreadable':
      return 'Not readable';
    default:
      return status;
  }
}

export function storageStatusTone(status: StorageCheckStatus): Tone {
  switch (status) {
    case 'ok':
      return 'success';
    case 'not-configured':
      return 'neutral';
    case 'missing':
      return 'danger';
    default:
      return 'warning';
  }
}

export function arrCheckReady(check: ArrCheck): boolean {
  return check.status === 'ok' && check.webhook === 'ok';
}

export function arrStatusLabel(check: ArrCheck): string {
  switch (check.status) {
    case 'unauthorized':
      return 'Unauthorized';
    case 'unreachable':
      return 'Unreachable';
    default:
      if (check.webhook === 'ok') return 'Connected';
      if (check.webhook === 'unknown') return 'Webhook unknown';
      return 'Webhook failed';
  }
}

export function arrStatusTone(check: ArrCheck): Tone {
  if (check.status !== 'ok') return 'danger';
  if (check.webhook === 'ok') return 'success';
  if (check.webhook === 'unknown') return 'warning';
  return 'danger';
}

/** Attention kind → short category chip (message body already holds the full story). */
export function attentionKindLabel(kind: string): string {
  switch (kind) {
    case 'ingest.rescue-proposed':
      return 'Import approval';
    case 'ingest.settle-timeout':
      return 'Import waiting';
    case 'ingest.mount-missing':
    case 'subtitle.mount-missing':
      return 'Storage';
    case 'subtitle.tool-missing':
      return 'Missing tool';
    case 'acquire.no-candidates':
      return 'No releases';
    case 'acquire.none-viable':
      return 'No good release';
    case 'subtitle.unresolved':
      return 'Missing subtitle';
    case 'subtitle.quarantined':
      return 'Bad subtitle file';
    case 'job.attention':
      return 'Job failed';
    case 'subtitle.site-unusable':
      return 'Site unusable';
    case 'subtitle.knowledge-refused':
      return 'Knowledge refused';
    case 'subtitle.knowledge-dropped':
      return 'Knowledge edits refused';
    case 'subtitle.transcript':
      // A run step raised to attention level: the browse agent was steered at a
      // private/loopback address (or off-web scheme) and refused it. Without this case the
      // SSRF signal renders as the untitled "subtitle transcript" fallback.
      return 'Refused destination';
    default:
      // Fall back to a cleaned kind rather than raw dotted agent speech.
      return kind.replace(/[._]/g, ' ');
  }
}

/** A subtitle site's human name, taken from its base URL — the only identity a site has.
 * Mirrors `siteLabel` in `src/config/siteLabel.ts`; `web/` shares no package with the
 * backend, so the two are kept in step by hand. */
export function siteLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.replace(/^www\./, '');
  } catch {
    return baseUrl;
  }
}

/** A paused pipeline (unreachable storage, a missing binary) and outright job failures are
 * errors; everything else in the queue is a decision waiting on a human. */
export function attentionKindTone(kind: string): Tone {
  if (kind.endsWith('.mount-missing') || kind === 'subtitle.tool-missing' || kind === 'job.attention') return 'danger';
  return 'warning';
}

export function attentionTitle(item: { kind: string; message: string; data: Record<string, unknown> }): string {
  const dataTitle = item.data.title;
  if (typeof dataTitle === 'string' && dataTitle.trim()) return dataTitle.trim();
  // Pull "Title" from common message shapes: `… for "Title"` / `… for Title —`
  const quoted = item.message.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  return attentionKindLabel(item.kind);
}
