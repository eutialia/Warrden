import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  apiErrorMessage,
  fetchSiteProfiles,
  updateSiteProfile,
  type SiteProfileRow,
} from '@/api';
import { StatusNotice } from '@/components/StatusNotice';
import { TierBadge } from '@/components/TierBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { formatRelativeTime } from '@/lib/utils';

export default function Sites() {
  const [profiles, setProfiles] = useState<SiteProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Inline notes editing: the row currently being edited and its in-progress text. Only one
  // row's notes is editable at a time (the textarea swaps in for the static view), so a
  // single id + buffer pair is enough state — no per-row map needed.
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
        setError(null); // a transient failure must not stick once a later load succeeds
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(apiErrorMessage(err, 'failed to load site profiles'));
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
      toast.error(apiErrorMessage(err, 'failed to save notes'));
    } finally {
      setSavingName(null);
    }
  }

  async function handleResetFailures(name: string): Promise<void> {
    setResettingName(name);
    try {
      // Clear both the counter and the failure timestamp — cooldown keys off both, and
      // leaving last_failure_at set would still block the site briefly after a reset.
      const updated = await updateSiteProfile(name, { failCount: 0, lastFailureAt: null });
      setProfiles((prev) => prev.map((p) => (p.name === name ? updated : p)));
      toast.success(`Reset failures for ${name}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'failed to reset failures'));
    } finally {
      setResettingName(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Site profiles</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {disconnected && <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />}
        {error && <StatusNotice message={error} onRetry={refetch} />}
        {loading && profiles.length === 0 && <p className="text-muted-foreground">Loading…</p>}
        {!loading && profiles.length === 0 && !error && (
          <p className="text-center text-muted-foreground">No subtitle sites configured.</p>
        )}
        {profiles.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Last success</TableHead>
                <TableHead>Last failure</TableHead>
                <TableHead>Fails</TableHead>
                <TableHead>Search patterns</TableHead>
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
                      <div className="text-xs text-muted-foreground">{row.base_url}</div>
                    </TableCell>
                    <TableCell>
                      <TierBadge tier={row.last_working_tier} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(row.last_success_at)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(row.last_failure_at)}</TableCell>
                    <TableCell>{row.fail_count}</TableCell>
                    <TableCell>
                      {row.search_url_patterns.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <ul className="space-y-0.5 text-xs text-muted-foreground">
                          {row.search_url_patterns.map((p, i) => (
                            <li key={i} className="break-all">{p}</li>
                          ))}
                        </ul>
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
                          />
                          <div className="flex gap-1.5">
                            <Button variant="outline" size="sm" disabled={saving} onClick={() => void handleSaveNotes(row.name)}>
                              {saving ? 'Saving…' : 'Save'}
                            </Button>
                            <Button variant="ghost" size="sm" disabled={saving} onClick={cancelEdit}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="min-h-[2rem] w-full text-left text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => beginEdit(row.name, row.notes)}
                        >
                          {row.notes || 'Add notes…'}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={resetting || row.fail_count === 0}
                        onClick={() => void handleResetFailures(row.name)}
                      >
                        {resetting ? 'Resetting…' : 'Reset failures'}
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
  );
}
