import { Button } from '@/components/ui/button';

interface StatusNoticeProps {
  message: string;
  /** 'muted' for a transient/informational notice (the SSE disconnected banner); the
   * default 'destructive' for an actual fetch failure. */
  tone?: 'muted' | 'destructive';
  onRetry: () => void;
}

/**
 * The message-plus-Retry-button row shared by every dashboard list page: the "live
 * updates disconnected" banner (`onRetry` reconnects the SSE stream) and an inline fetch
 * error (`onRetry` re-runs the fetch) are visually and structurally identical, just with
 * different copy/tone/handler — one component instead of four near-duplicate call sites.
 */
export function StatusNotice({ message, tone = 'destructive', onRetry }: StatusNoticeProps) {
  return (
    <div className="flex items-center gap-2">
      <p className={`text-sm ${tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'}`}>{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
