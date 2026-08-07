import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  acceptAttention,
  ApiError,
  dismissAttention,
  fetchAttention,
  repickAttention,
  retryAttention,
  type AttentionItem,
  type AttentionStatus,
} from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

// Same reasoning as Activity.tsx: SSE fires per-event, and a busy pipeline can raise
// several attention items (or resolve several) in quick succession — coalesce to one
// refetch per burst instead of one round trip per event.
const REFETCH_DEBOUNCE_MS = 500;

const STATUS_TABS: { value: AttentionStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'resolved', label: 'Resolved' },
];

const EMPTY_MESSAGE: Record<AttentionStatus, string> = {
  open: 'Nothing needs attention',
  dismissed: 'No dismissed items',
  resolved: 'No resolved items',
};

// Mirrors the server's own cap (`HINT_MAX_LENGTH` in `src/server/app.ts`) — without it the
// input happily accepts more than the server will, and the resulting 400 gives no useful
// explanation of why the submit just failed.
const HINT_MAX_LENGTH = 2000;

interface BundleImportData {
  reasoning?: string;
  files: { path: string }[];
}

/** `data.action === 'bundle-import'` items (see `AcceptDataSchema` in `src/server/app.ts`)
 * are the only ones the "Accept import" action applies to — everything else in `data` is
 * kind-specific and not rendered here. Returns `null` for any other shape, including a
 * malformed bundle-import (no usable file paths) since there'd be nothing to show. */
function bundleImportData(item: AttentionItem): BundleImportData | null {
  const data = item.data;
  if (data.action !== 'bundle-import' || !Array.isArray(data.files)) return null;
  const files = (data.files as { path?: unknown }[]).filter((f): f is { path: string } => typeof f?.path === 'string');
  if (files.length === 0) return null;
  return { reasoning: typeof data.reasoning === 'string' ? data.reasoning : undefined, files };
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

export default function Attention() {
  const [status, setStatus] = useState<AttentionStatus>('open');
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [repickOpenId, setRepickOpenId] = useState<number | null>(null);
  const [repickHint, setRepickHint] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `refetch` reads the status through this ref rather than closing over the `status`
  // state, so its own identity stays stable across tab switches and the SSE effect below
  // can depend on it normally instead of reconnecting the stream on every toggle.
  const statusRef = useRef(status);
  statusRef.current = status;

  // Bumped on every refetch; a response is only applied if it's still the most recent
  // request by the time it lands. Same idea as JobDetail's `isStale`, generalized to cover
  // any overlapping requests (an SSE burst, a tab switch, a post-action refetch), not just
  // an unmounted effect.
  const requestIdRef = useRef(0);

  const refetch = useCallback(() => {
    const requestId = ++requestIdRef.current;
    const isStale = () => requestIdRef.current !== requestId;
    fetchAttention(statusRef.current)
      .then((res) => {
        if (isStale()) return;
        setItems(res.items);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(err instanceof ApiError ? err.message : 'failed to load attention items');
      })
      .finally(() => {
        if (isStale()) return;
        setLoading(false);
      });
  }, []);

  const refetchDebounced = useCallback(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refetch, REFETCH_DEBOUNCE_MS);
  }, [refetch]);

  useEffect(() => {
    // A debounced refetch queued by the previous tab must not land after this tab's rows
    // are cleared and re-requested below — drop it before starting the new load.
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setItems([]); // don't show the previous tab's rows under the new tab's spinner
    setLoading(true);
    setRepickOpenId(null);
    setRepickHint('');
    refetch();
  }, [status, refetch]);

  useEffect(() => {
    const source = new EventSource('/api/events/stream');
    source.onmessage = () => refetchDebounced();
    source.onopen = () => {
      setDisconnected(false);
      refetch(); // reconnected — catch up on anything missed while the stream was down
    };
    source.onerror = () => setDisconnected(true);
    return () => {
      source.close();
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, [refetch, refetchDebounced]);

  const runAction = useCallback(
    async (id: number, action: () => Promise<unknown>, successMsg: string, failMsg: string): Promise<boolean> => {
      setPendingIds((prev) => new Set(prev).add(id));
      try {
        await action();
        toast.success(successMsg);
        refetch();
        return true;
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : failMsg);
        return false;
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [refetch],
  );

  function handleDismiss(id: number): void {
    void runAction(id, () => dismissAttention(id), 'Dismissed', 'failed to dismiss');
  }

  function handleRetry(id: number): void {
    void runAction(id, () => retryAttention(id), 'Retry queued', 'failed to retry');
  }

  function handleAccept(id: number): void {
    void runAction(id, () => acceptAttention(id), 'Import accepted', 'failed to accept import');
  }

  async function handleRepickSubmit(id: number): Promise<void> {
    const hint = repickHint.trim();
    const ok = await runAction(id, () => repickAttention(id, hint || undefined), 'Re-pick queued', 'failed to queue re-pick');
    if (ok) {
      setRepickOpenId(null);
      setRepickHint('');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Attention</span>
          <div className="flex gap-1.5">
            {STATUS_TABS.map((tab) => (
              <Button
                key={tab.value}
                variant={status === tab.value ? 'default' : 'outline'}
                size="sm"
                onClick={() => setStatus(tab.value)}
              >
                {tab.label}
              </Button>
            ))}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {disconnected && <p className="text-sm text-muted-foreground">Live updates disconnected — retrying…</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {items.length === 0 && !loading && <p className="text-center text-muted-foreground">{EMPTY_MESSAGE[status]}</p>}
        {items.map((item) => {
          const pending = pendingIds.has(item.id);
          const canRetry = item.job_id !== null;
          const canRepick = item.job_id !== null && item.kind.startsWith('acquire.');
          const bundleImport = bundleImportData(item);
          const repickOpen = repickOpenId === item.id;

          return (
            <Card key={item.id}>
              <CardContent className="space-y-2 pt-4 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{item.kind}</Badge>
                  <span className="text-xs text-muted-foreground">{new Date(item.ts).toLocaleString()}</span>
                  {item.job_id !== null && (
                    <Link to={`/jobs/${item.job_id}`} className="text-xs text-primary underline-offset-4 hover:underline">
                      Job #{item.job_id}
                    </Link>
                  )}
                </div>
                <p>{item.message}</p>
                {item.resolved_at !== null && (
                  <p className="text-xs text-muted-foreground">Resolved: {new Date(item.resolved_at).toLocaleString()}</p>
                )}

                {bundleImport && (
                  <div className="space-y-1 rounded-md bg-muted p-3 text-xs">
                    {bundleImport.reasoning && <p>{bundleImport.reasoning}</p>}
                    <ul className="list-inside list-disc">
                      {bundleImport.files.map((f) => (
                        <li key={f.path}>{basename(f.path)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {item.status === 'open' && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <Button variant="outline" size="sm" disabled={pending} onClick={() => handleDismiss(item.id)}>
                      Dismiss
                    </Button>
                    {canRetry && (
                      <Button variant="outline" size="sm" disabled={pending} onClick={() => handleRetry(item.id)}>
                        Retry
                      </Button>
                    )}
                    {canRepick && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        aria-expanded={repickOpen}
                        onClick={() => {
                          setRepickOpenId(repickOpen ? null : item.id);
                          setRepickHint('');
                        }}
                      >
                        Re-pick…
                      </Button>
                    )}
                    {bundleImport && (
                      <Button variant="default" size="sm" disabled={pending} onClick={() => handleAccept(item.id)}>
                        Accept import
                      </Button>
                    )}
                  </div>
                )}

                {item.status === 'open' && repickOpen && (
                  <div className="flex items-center gap-1.5 pt-1">
                    <Input
                      autoFocus
                      placeholder="Hint for the re-pick (optional)…"
                      value={repickHint}
                      maxLength={HINT_MAX_LENGTH}
                      disabled={pending}
                      onChange={(e) => setRepickHint(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleRepickSubmit(item.id);
                      }}
                    />
                    <Button size="sm" disabled={pending} onClick={() => void handleRepickSubmit(item.id)}>
                      Submit
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </CardContent>
    </Card>
  );
}
