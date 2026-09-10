import type { TraceEntry } from '@/api';
import { formatTook } from '@/components/debug/laneModel';
import { PayloadView } from '@/components/debug/PayloadView';
import { traceStatusLabel } from '@/lib/labels';

export function StepTab({
  entry,
  payload,
  payloadError,
  onRetryPayload,
  jobTerminal,
}: {
  entry: TraceEntry;
  payload: unknown;
  payloadError?: string;
  onRetryPayload: () => void;
  jobTerminal: boolean;
}) {
  const interrupted = entry.status === 'running' && jobTerminal;
  return (
    <div className="space-y-3 p-3">
      <Facts
        rows={[
          ['kind', entry.kind],
          ['seq', entry.parent_seq === null ? String(entry.seq) : `${entry.seq} · parent ${entry.parent_seq}`],
          ['status', `${traceStatusLabel(entry.status, interrupted)} · ${formatTook(entry, jobTerminal)}`],
          ['started', new Date(entry.ts_start).toLocaleTimeString(undefined, { hour12: false }) + `.${String(entry.ts_start % 1000).padStart(3, '0')}`],
          ['summary', entry.summary],
        ]}
      />
      {entry.hasPayload ? (
        <PayloadView value={payload} error={payloadError} onRetry={onRetryPayload} />
      ) : (
        <p className="text-xs text-muted-foreground">This step recorded no payload.</p>
      )}
    </div>
  );
}

export function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
