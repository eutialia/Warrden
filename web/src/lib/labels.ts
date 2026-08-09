import { Captions, FolderInput, Radar, type LucideIcon } from 'lucide-react';
import type {
  AccessTier,
  AcquireStatus,
  JobStatus,
  ManagedObjectKind,
  StorageCheckStatus,
  TargetKind,
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

export function acquireOutcomeLabel(outcome: AcquireStatus): string {
  switch (outcome) {
    case 'grabbed':
      return 'Grabbed a release';
    case 'none-viable':
      return 'Nothing good enough';
    case 'no-candidates':
      return 'No releases found';
    default:
      return outcome;
  }
}

/** A finished acquire that grabbed nothing isn't a failure — it's a dead end a
 * human may want to act on, so it reads as a warning rather than an error. */
export function acquireOutcomeTone(outcome: AcquireStatus): Tone {
  return outcome === 'grabbed' ? 'success' : 'warning';
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

export function storageStatusLabel(status: StorageCheckStatus): string {
  switch (status) {
    case 'ok':
      return 'Reachable';
    case 'missing':
      return 'Missing';
    case 'not-mounted':
      return 'Not mounted';
    case 'unreadable':
      return 'Not readable';
    case 'unwritable':
      return 'Not writable';
    default:
      return status;
  }
}

export function storageStatusTone(status: StorageCheckStatus): Tone {
  switch (status) {
    case 'ok':
      return 'success';
    case 'missing':
    case 'not-mounted':
      return 'danger';
    default:
      return 'warning';
  }
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
    default:
      // Fall back to a cleaned kind rather than raw dotted agent speech.
      return kind.replace(/[._]/g, ' ');
  }
}

/** Storage problems and outright job failures are errors; everything else in the
 * queue is a decision waiting on a human. */
export function attentionKindTone(kind: string): Tone {
  if (kind.endsWith('.mount-missing') || kind === 'job.attention') return 'danger';
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
