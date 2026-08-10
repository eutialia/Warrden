import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Inbox } from 'lucide-react';
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
import { ToneBadge } from '@/components/ToneBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useOverview } from '@/hooks/useOverview';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { attentionKindLabel, attentionKindTone, attentionTitle } from '@/lib/labels';
import { cn, formatElapsed, formatRelativeTime } from '@/lib/utils';

const STATUS_TABS: { value: AttentionStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'dismissed', label: 'Ignored' },
  { value: 'resolved', label: 'Resolved' },
];

const EMPTY_COPY: Record<AttentionStatus, { title: string; description: string }> = {
  open: {
    title: 'Nothing needs your attention',
    description: 'Warrden decided everything on its own. Items land here only when it deliberately stops short.',
  },
  dismissed: { title: 'Nothing ignored', description: 'Items you dismiss are kept here in case you change your mind.' },
  resolved: { title: 'Nothing resolved yet', description: 'Items you act on move here once Warrden finishes the follow-up.' },
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
  const [repickItem, setRepickItem] = useState<AttentionItem | null>(null);
  const [repickHint, setRepickHint] = useState('');
  const { data: overview } = useOverview();

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
  useSseRefetch(refetch);

  useEffect(() => {
    setItems([]);
    setLoading(true);
    setError(null);
    setRepickItem(null);
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

  async function handleRepickSubmit(): Promise<void> {
    if (!repickItem) return;
    const hint = repickHint.trim();
    const ok = await runAction(
      repickItem.id,
      () => repickAttention(repickItem.id, hint || undefined),
      'Re-pick queued',
      'Failed to queue re-pick',
    );
    if (ok) {
      setRepickItem(null);
      setRepickHint('');
    }
  }

  const openCount = overview?.attention.open ?? 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Needs review"
        description="Decisions Warrden deliberately left to you — approve an import, pick a different release, or dismiss the noise."
      />

      <Tabs value={status} onValueChange={(v) => setStatus((v as AttentionStatus) ?? 'open')}>
        <TabsList>
          {STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
              {tab.value === 'open' && openCount > 0 && (
                <span className="ml-1.5 rounded-full bg-warning-muted px-1.5 text-xs font-medium text-warning-foreground tabular-nums">
                  {openCount}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="space-y-3">
        {error && <StatusNotice message={error} onRetry={refetch} />}

        {loading && items.length === 0 && (
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        )}

        {!loading && items.length === 0 && !error && (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>{EMPTY_COPY[status].title}</EmptyTitle>
              <EmptyDescription>{EMPTY_COPY[status].description}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {items.map((item) => {
          const pending = pendingIds.has(item.id);
          const canRetry = item.job_id !== null;
          const canRepick = item.job_id !== null && item.kind.startsWith('acquire.');
          const bundleImport = bundleImportData(item);
          const tone = attentionKindTone(item.kind);
          const title = attentionTitle(item);
          const fileCount = bundleImport?.fileCount ?? bundleImport?.files.length ?? 0;
          const groups = bundleImport ? groupFilesByFolder(bundleImport.files) : [];

          return (
            // Closed items stay in the list but recede — a whole card of full-strength
            // colour for something already dealt with competes with what still needs you.
            // A rule above each item is what separates one from the next.
            <Card key={item.id} className={cn('border-t pt-4', item.status !== 'open' && 'text-muted-foreground')}>
              <CardContent className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className={cn('text-base font-medium', item.status !== 'open' && 'font-normal')}>{title}</h2>
                  <ToneBadge tone={item.status === 'open' ? tone : 'neutral'} dot={item.status === 'open'}>
                    {attentionKindLabel(item.kind)}
                  </ToneBadge>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {item.status === 'open' ? `held ${formatElapsed(item.ts)}` : formatRelativeTime(item.ts)}
                    {item.job_id !== null && (
                      <>
                        {' · '}
                        <Link to={`/jobs/${item.job_id}`} className="text-primary underline-offset-4 hover:underline">
                          Related job
                        </Link>
                      </>
                    )}
                  </span>
                </div>

                <p className="leading-relaxed">{item.message}</p>

                {bundleImport && (
                  <Collapsible className="border-t">
                    <div className="space-y-2 pt-3">
                      <p className="font-medium">
                        {fileCount} file{fileCount === 1 ? '' : 's'} proposed for import
                        {groups.length > 1 ? ` · ${groups.length} folders` : ''}
                      </p>
                      {bundleImport.reasoning && (
                        <p className="text-xs leading-relaxed text-muted-foreground">{bundleImport.reasoning}</p>
                      )}
                      {/* The label has to track the state the chevron already shows —
                          a button that always reads "Show" is wrong half the time, and
                          a screen reader only gets the label. */}
                      <CollapsibleTrigger
                        render={
                          <Button type="button" variant="ghost" size="sm" className="group/files -ml-2 h-8 px-2">
                            <ChevronRight className="size-4 transition-transform data-panel-open:rotate-90" />
                            <span className="group-data-panel-open/files:hidden">Show file list</span>
                            <span className="hidden group-data-panel-open/files:inline">Hide file list</span>
                          </Button>
                        }
                      />
                      <CollapsibleContent>
                        <div className="max-h-64 space-y-2 overflow-y-auto pt-1 text-xs">
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
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )}

                {item.resolved_at !== null && (
                  <p className="text-xs text-muted-foreground">Closed {formatRelativeTime(item.resolved_at)}</p>
                )}

                {item.status === 'open' && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {/* Primary action first: the one thing this item is actually asking for. */}
                    {bundleImport && (
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          void runAction(item.id, () => acceptAttention(item.id), 'Import approved', 'Failed to approve import')
                        }
                      >
                        Approve import
                      </Button>
                    )}
                    {canRepick && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setRepickItem(item);
                          setRepickHint('');
                        }}
                      >
                        Pick a different release…
                      </Button>
                    )}
                    {canRetry && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => void runAction(item.id, () => retryAttention(item.id), 'Retry queued', 'Failed to retry')}
                      >
                        Try again
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      disabled={pending}
                      onClick={() => void runAction(item.id, () => dismissAttention(item.id), 'Ignored', 'Failed to ignore')}
                    >
                      Ignore
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={repickItem !== null} onOpenChange={(open) => !open && setRepickItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pick a different release</DialogTitle>
            <DialogDescription>
              Warrden will search again for {repickItem ? attentionTitle(repickItem) : 'this title'}. A hint is optional —
              it goes to the release picker as extra guidance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="repick-hint">Hint (optional)</Label>
            <Input
              id="repick-hint"
              autoFocus
              placeholder="e.g. prefer a specific fansub group, or 1080p only"
              value={repickHint}
              maxLength={HINT_MAX_LENGTH}
              onChange={(e) => setRepickHint(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRepickSubmit();
              }}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button
              disabled={repickItem !== null && pendingIds.has(repickItem.id)}
              onClick={() => void handleRepickSubmit()}
            >
              Queue re-pick
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
