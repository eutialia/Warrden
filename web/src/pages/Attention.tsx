import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import {
  acceptAttention,
  apiErrorMessage,
  dismissAttention,
  fetchAttention,
  repickAttention,
  retryAttention,
  type AttentionItem,
  type AttentionStatus,
} from '@/api';
import { PageHeader } from '@/components/PageHeader';
import { StatusNotice } from '@/components/StatusNotice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { attentionKindLabel, attentionTitle } from '@/lib/labels';
import { cn } from '@/lib/utils';

const STATUS_TABS: { value: AttentionStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'resolved', label: 'Resolved' },
];

const EMPTY_MESSAGE: Record<AttentionStatus, string> = {
  open: 'Nothing needs your attention right now.',
  dismissed: 'No dismissed items.',
  resolved: 'No resolved items.',
};

const HINT_MAX_LENGTH = 2000;

interface BundleImportData {
  reasoning?: string;
  files: { path: string }[];
  fileCount?: number;
}

function bundleImportData(item: AttentionItem): BundleImportData | null {
  const data = item.data;
  if (data.action !== 'bundle-import' || !Array.isArray(data.files)) return null;
  const files = (data.files as { path?: unknown }[]).filter((f): f is { path: string } => typeof f?.path === 'string');
  if (files.length === 0) return null;
  return {
    reasoning: typeof data.reasoning === 'string' ? data.reasoning : undefined,
    files,
    fileCount: typeof data.fileCount === 'number' ? data.fileCount : files.length,
  };
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

/** Group file basenames by parent folder (usually Season N). */
function groupFilesByFolder(files: { path: string }[]): { folder: string; names: string[] }[] {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const parts = f.path.split('/');
    const folder = parts.length > 1 ? parts[parts.length - 2]! : 'Files';
    const list = map.get(folder) ?? [];
    list.push(basename(f.path));
    map.set(folder, list);
  }
  return [...map.entries()].map(([folder, names]) => ({ folder, names }));
}

export default function Attention() {
  const [status, setStatus] = useState<AttentionStatus>('open');
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [repickOpenId, setRepickOpenId] = useState<number | null>(null);
  const [repickHint, setRepickHint] = useState('');
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(new Set());

  const statusRef = useRef(status);
  statusRef.current = status;

  const beginFetch = useFetchGeneration();
  const refetch = useCallback(() => {
    const isStale = beginFetch();
    fetchAttention(statusRef.current)
      .then((res) => {
        if (isStale()) return;
        setItems(res.items);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(apiErrorMessage(err, 'Failed to load items that need review'));
      })
      .finally(() => {
        if (isStale()) return;
        setLoading(false);
      });
  }, [beginFetch]);
  const { disconnected, reconnect } = useSseRefetch(refetch);

  useEffect(() => {
    setItems([]);
    setLoading(true);
    setError(null);
    setRepickOpenId(null);
    setRepickHint('');
    refetch();
  }, [status, refetch]);

  const runAction = useCallback(
    async (id: number, action: () => Promise<unknown>, successMsg: string, failMsg: string): Promise<boolean> => {
      setPendingIds((prev) => new Set(prev).add(id));
      try {
        await action();
        toast.success(successMsg);
        refetch();
        return true;
      } catch (err) {
        toast.error(apiErrorMessage(err, failMsg));
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
    void runAction(id, () => dismissAttention(id), 'Dismissed', 'Failed to dismiss');
  }

  function handleRetry(id: number): void {
    void runAction(id, () => retryAttention(id), 'Retry queued', 'Failed to retry');
  }

  function handleAccept(id: number): void {
    void runAction(id, () => acceptAttention(id), 'Import approved', 'Failed to approve import');
  }

  async function handleRepickSubmit(id: number): Promise<void> {
    const hint = repickHint.trim();
    const ok = await runAction(id, () => repickAttention(id, hint || undefined), 'Re-pick queued', 'Failed to queue re-pick');
    if (ok) {
      setRepickOpenId(null);
      setRepickHint('');
    }
  }

  function toggleFiles(id: number): void {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <PageHeader
        title="Needs review"
        description="Things Warrden won't do automatically — approve an import, re-pick a release, or dismiss noise. Messages are written for humans, not agents."
        actions={
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
        }
      />

      <div className="space-y-3">
        {disconnected && (
          <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />
        )}
        {error && <StatusNotice message={error} onRetry={refetch} />}
        {items.length === 0 && !loading && !error && (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">{EMPTY_MESSAGE[status]}</CardContent>
          </Card>
        )}

        {items.map((item) => {
          const pending = pendingIds.has(item.id);
          const canRetry = item.job_id !== null;
          const canRepick = item.job_id !== null && item.kind.startsWith('acquire.');
          const bundleImport = bundleImportData(item);
          const repickOpen = repickOpenId === item.id;
          const filesOpen = expandedFiles.has(item.id);
          const title = attentionTitle(item);
          const fileCount = bundleImport?.fileCount ?? bundleImport?.files.length ?? 0;
          const groups = bundleImport ? groupFilesByFolder(bundleImport.files) : [];

          return (
            <Card
              key={item.id}
              className={cn(
                'border-l-4',
                item.status === 'open' ? 'border-l-amber-500' : 'border-l-transparent',
              )}
            >
              <CardContent className="space-y-3 pt-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{title}</h2>
                      <Badge
                        variant="outline"
                        className="bg-amber-50 text-amber-950 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-800"
                      >
                        {attentionKindLabel(item.kind)}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {new Date(item.ts).toLocaleString()}
                      {item.job_id !== null && (
                        <>
                          {' · '}
                          <Link to={`/jobs/${item.job_id}`} className="text-primary underline-offset-4 hover:underline">
                            Related job
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                </div>

                <p className="leading-relaxed text-foreground">{item.message}</p>

                {bundleImport && (
                  <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
                    <p className="text-sm font-medium">
                      {fileCount} file{fileCount === 1 ? '' : 's'} proposed for import
                      {groups.length > 1 ? ` · ${groups.length} folders` : ''}
                    </p>
                    {bundleImport.reasoning && (
                      <p className="text-xs text-muted-foreground leading-relaxed">{bundleImport.reasoning}</p>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2"
                      onClick={() => toggleFiles(item.id)}
                    >
                      {filesOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      {filesOpen ? 'Hide file list' : 'Show file list'}
                    </Button>
                    {filesOpen && (
                      <div className="max-h-64 space-y-2 overflow-y-auto text-xs">
                        {groups.map((g) => (
                          <div key={g.folder}>
                            <div className="font-medium text-muted-foreground">
                              {g.folder} ({g.names.length})
                            </div>
                            <ul className="ml-3 list-disc text-muted-foreground">
                              {g.names.map((n) => (
                                <li key={n} className="break-all">
                                  {n}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {item.resolved_at !== null && (
                  <p className="text-xs text-muted-foreground">
                    Closed: {new Date(item.resolved_at).toLocaleString()}
                  </p>
                )}

                {item.status === 'open' && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <Button variant="outline" size="sm" disabled={pending} onClick={() => handleDismiss(item.id)}>
                      Ignore
                    </Button>
                    {canRetry && (
                      <Button variant="outline" size="sm" disabled={pending} onClick={() => handleRetry(item.id)}>
                        Try again
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
                        Pick a different release…
                      </Button>
                    )}
                    {bundleImport && (
                      <Button variant="default" size="sm" disabled={pending} onClick={() => handleAccept(item.id)}>
                        Approve import
                      </Button>
                    )}
                  </div>
                )}

                {item.status === 'open' && repickOpen && (
                  <div className="flex items-center gap-1.5 pt-1">
                    <Input
                      autoFocus
                      placeholder="Optional hint for the re-pick (e.g. prefer a fansub group)…"
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
      </div>
    </div>
  );
}
