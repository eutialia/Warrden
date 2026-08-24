import { factsOf, type EnvelopeCarrier } from '@/lib/eventEnvelope';

/**
 * Reads the three re-executable proposals an attention item can carry.
 *
 * The payload lives at `data.accept` and nowhere else: the envelope owns `data.action`, so
 * the discriminator moved under its own key (`acceptPayload` in src/server/app.ts). Rows
 * written before the envelope were rewritten in place — `legacyAccept` in
 * src/db/migrateEventEnvelopes.ts backfills `data.accept` from the old top-level shape — so
 * there is no legacy branch to keep here.
 *
 * Everything else these blocks show comes from the envelope's facts, not from loose keys:
 * the tiers a subtitle site was tried on are `facts.reasons`, the import's file count is
 * `facts.counts.files`, its reasoning is `facts.reason`. `evidence` is the exception — it
 * stays outside the envelope on the emitted row (`raiseUnusable` in
 * src/pipelines/subtitle/run.ts) and the migration drops it, so old items simply show none.
 */

function accept(item: EnvelopeCarrier): Record<string, unknown> | null {
  const value = item.data.accept;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

export interface BundleImportData {
  reasoning?: string;
  files: { path: string }[];
  fileCount: number;
}

export function bundleImportData(item: EnvelopeCarrier): BundleImportData | null {
  const payload = accept(item);
  if (payload?.action !== 'bundle-import' || !Array.isArray(payload.files)) return null;
  const files = (payload.files as { path?: unknown }[]).filter((f): f is { path: string } => typeof f?.path === 'string');
  if (files.length === 0) return null;
  const facts = factsOf(item);
  const counted = facts.counts?.files;
  return {
    ...(typeof facts.reason === 'string' ? { reasoning: facts.reason } : {}),
    files,
    fileCount: typeof counted === 'number' && counted > 0 ? counted : files.length,
  };
}

export interface DisableSiteData {
  baseUrl: string;
  reason: string;
  tiersAttempted: string[];
  evidence: string[];
}

export function disableSiteData(item: EnvelopeCarrier): DisableSiteData | null {
  const payload = accept(item);
  if (payload?.action !== 'disable-site' || typeof payload.baseUrl !== 'string' || typeof payload.reason !== 'string') {
    return null;
  }
  return {
    baseUrl: payload.baseUrl,
    reason: payload.reason,
    tiersAttempted: strings(factsOf(item).reasons),
    evidence: strings(item.data.evidence),
  };
}

/** True for a none-viable item whose accept means "grab the release the model vetoed"
 * (`ForceGrabSchema` in src/server/app.ts). The item's own message already names the
 * release, so the button is all that branch needs. */
export function isForceGrab(item: EnvelopeCarrier): boolean {
  const payload = accept(item);
  return payload?.action === 'force-grab' && typeof payload.guid === 'string';
}
