import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  apiErrorMessage,
  fetchSiteProfiles,
  updateSiteProfile,
  type SiteProfileRow,
} from '@/api';
import { PageHeader } from '@/components/PageHeader';
import { StatusNotice } from '@/components/StatusNotice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { tierLabel } from '@/lib/labels';
import { formatRelativeTime } from '@/lib/utils';

export default function Sites() {
  const [profiles, setProfiles] = useState<SiteProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [savingName, setSavingName] = useState<string | null>(null);
  const [resettingName, setResettingName] = useState<string | null>(null);

  const beginFetch = useFetchGeneration();
  const refetch = useCallback(() => {
    const isStale = beginFetch();
    fetchSiteProfiles()
      .then((res) => {
        if (isStale()) return;
        setProfiles(res.profiles);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(apiErrorMessage(err, 'Failed to load subtitle sources'));
      })
      .finally(() => {
        if (isStale()) return;
        setLoading(false);
      });
  }, [beginFetch]);
  const { disconnected, reconnect } = useSseRefetch(refetch);

  useEffect(refetch, [refetch]);

  function beginEdit(name: string, notes: string): void {
    setEditingName(name);
    setNotesDraft(notes);
  }

  function cancelEdit(): void {
    setEditingName(null);
    setNotesDraft('');
  }

  async function handleSaveNotes(name: string): Promise<void> {
    setSavingName(name);
    try {
      const updated = await updateSiteProfile(name, { notes: notesDraft });
      setProfiles((prev) => prev.map((p) => (p.name === name ? updated : p)));
      setEditingName(null);
      setNotesDraft('');
      toast.success('Notes saved');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to save notes'));
    } finally {
      setSavingName(null);
    }
  }

  async function handleResetFailures(name: string): Promise<void> {
    setResettingName(name);
    try {
      const updated = await updateSiteProfile(name, { failCount: 0, lastFailureAt: null });
      setProfiles((prev) => prev.map((p) => (p.name === name ? updated : p)));
      toast.success(`Cleared failures for ${name}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to clear failures'));
    } finally {
      setResettingName(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Subtitle sources"
        description="Websites Warrden browses to find subtitles. Health and notes live here; add or remove sites under Settings → Subtitles."
      />

      <Card>
        <CardContent className="space-y-4 pt-6">
          {disconnected && (
            <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />
          )}
          {error && <StatusNotice message={error} onRetry={refetch} />}
          {loading && profiles.length === 0 && <p className="text-muted-foreground">Loading…</p>}
          {!loading && profiles.length === 0 && !error && (
            <div className="space-y-2 py-8 text-center">
              <p className="text-muted-foreground">No subtitle sites configured yet.</p>
              <Link
                to="/config"
                className="inline-flex h-7 items-center rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium hover:bg-muted"
              >
                Open Settings
              </Link>
            </div>
          )}
          {profiles.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Access method</TableHead>
                  <TableHead>Last success</TableHead>
                  <TableHead>Last failure</TableHead>
                  <TableHead>Fails</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profiles.map((row) => {
                  const editing = editingName === row.name;
                  const saving = savingName === row.name;
                  const resetting = resettingName === row.name;
                  return (
                    <TableRow key={row.name}>
                      <TableCell>
                        <div className="font-medium">{row.name}</div>
                        <div className="text-xs text-muted-foreground break-all">{row.base_url}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{tierLabel(row.last_working_tier)}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelativeTime(row.last_success_at)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelativeTime(row.last_failure_at)}
                      </TableCell>
                      <TableCell>
                        {row.fail_count > 0 ? (
                          <span className="font-medium text-amber-700 dark:text-amber-400">{row.fail_count}</span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="min-w-[16rem]">
                        {editing ? (
                          <div className="space-y-1.5">
                            <Textarea
                              rows={3}
                              autoFocus
                              value={notesDraft}
                              onChange={(e) => setNotesDraft(e.target.value)}
                              disabled={saving}
                              placeholder="Operator notes for this site…"
                            />
                            <div className="flex gap-1.5">
                              <Button
                                variant="default"
                                size="sm"
                                disabled={saving}
                                onClick={() => void handleSaveNotes(row.name)}
                              >
                                {saving ? 'Saving…' : 'Save notes'}
                              </Button>
                              <Button variant="ghost" size="sm" disabled={saving} onClick={cancelEdit}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                              {row.notes || 'No notes yet.'}
                            </p>
                            <Button variant="outline" size="sm" onClick={() => beginEdit(row.name, row.notes)}>
                              Edit notes
                            </Button>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={resetting || row.fail_count === 0}
                          title={
                            row.fail_count === 0
                              ? 'No failures to clear'
                              : 'Clear the failure count so Warrden will try this site again sooner'
                          }
                          onClick={() => void handleResetFailures(row.name)}
                        >
                          {resetting ? 'Clearing…' : 'Clear failures'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
