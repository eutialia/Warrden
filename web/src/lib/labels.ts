import type { AccessTier, AcquireStatus, JobStatus, ManagedObjectKind, TargetKind } from '@/api';

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

/** Pipeline → badge color class (semantic, not monochrome). */
export function pipelineToneClass(pipeline: string): string {
  switch (pipeline) {
    case 'acquire':
      return 'bg-sky-100 text-sky-900 border-sky-200 dark:bg-sky-950 dark:text-sky-100 dark:border-sky-800';
    case 'ingest':
      return 'bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-950 dark:text-violet-100 dark:border-violet-800';
    case 'subtitle':
      return 'bg-amber-100 text-amber-950 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-800';
    default:
      return '';
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

export function attentionTitle(item: { kind: string; message: string; data: Record<string, unknown> }): string {
  const dataTitle = item.data.title;
  if (typeof dataTitle === 'string' && dataTitle.trim()) return dataTitle.trim();
  // Pull "Title" from common message shapes: `… for "Title"` / `… for Title —`
  const quoted = item.message.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  return attentionKindLabel(item.kind);
}
