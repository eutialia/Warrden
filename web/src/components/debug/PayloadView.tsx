import { isTruncationEnvelope, type TruncationEnvelope } from '@/api';
import { Button } from '@/components/ui/button';

export function TruncationNote({ envelope }: { envelope: TruncationEnvelope }) {
  return <p className="text-[11px] text-muted-foreground">truncated ({Math.round(envelope.bytes / 1024).toLocaleString()} KB)</p>;
}

export function PayloadView({ value, error, onRetry }: { value: unknown; error?: string; onRetry?: () => void }) {
  if (error !== undefined)
    return (
      <div className="flex items-center gap-2">
        <p className="text-xs text-destructive">{error}</p>
        {onRetry && (
          <Button variant="outline" size="sm" className="h-6 text-xs" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    );
  if (value === undefined) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (value === null) return <p className="text-xs text-muted-foreground">No payload.</p>;
  const envelope = isTruncationEnvelope(value) ? value : null;
  return (
    <div className="space-y-1.5">
      {envelope && <TruncationNote envelope={envelope} />}
      <pre className="max-h-[60vh] overflow-auto rounded-sm border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
        {envelope ? envelope.head : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
