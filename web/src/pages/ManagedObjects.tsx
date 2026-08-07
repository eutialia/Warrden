import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ApiError,
  deleteManagedObject,
  fetchManagedObjects,
  type ManagedObject,
  type ManagedObjectKind,
} from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useSseRefetch } from '@/hooks/useSseRefetch';

// Same reasoning as Activity.tsx/Attention.tsx: registration (startup, tag/release-profile
// pinning) and GC (reconcile) can each touch several rows in quick succession — coalesce to
// one refetch per burst instead of one round trip per event.
const REFETCH_DEBOUNCE_MS = 500;

const KIND_LABEL: Record<ManagedObjectKind, string> = {
  notification: 'Notification',
  tag: 'Tag',
  release_profile: 'Release profile',
};

function groupByArrInstance(objects: ManagedObject[]): [string, ManagedObject[]][] {
  const groups = new Map<string, ManagedObject[]>();
  for (const obj of objects) {
    const list = groups.get(obj.arr_instance);
    if (list) list.push(obj);
    else groups.set(obj.arr_instance, [obj]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export default function ManagedObjects() {
  const [objects, setObjects] = useState<ManagedObject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  // Two-click delete: first click on a row arms it, a second click on the same row's
  // "Confirm?" button actually deletes — nothing here uses the browser's own `confirm()`.
  const [confirmId, setConfirmId] = useState<number | null>(null);

  // `useSseRefetch` needs `refetch`'s identity to call it, but `refetch` itself needs
  // `beginFetch` from `useSseRefetch`'s return — a genuine circular reference broken via
  // this ref indirection, same as Attention.tsx.
  const refetchRef = useRef<() => void>(() => {});
  const { disconnected, beginFetch } = useSseRefetch(() => refetchRef.current(), REFETCH_DEBOUNCE_MS);

  const refetch = useCallback(() => {
    const isStale = beginFetch();
    fetchManagedObjects()
      .then((res) => {
        if (isStale()) return;
        setObjects(res.objects);
        setError(null); // a transient failure must not stick once a later load succeeds
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(err instanceof ApiError ? err.message : 'failed to load managed objects');
      })
      .finally(() => {
        if (isStale()) return;
        setLoading(false);
      });
  }, [beginFetch]);
  refetchRef.current = refetch;

  useEffect(refetch, [refetch]);

  async function handleDelete(id: number, arrInstance: string): Promise<void> {
    setPendingIds((prev) => new Set(prev).add(id));
    try {
      const { deletedInArr } = await deleteManagedObject(id);
      toast.success(deletedInArr ? `Deleted from ${arrInstance}` : 'Removed from registry (arr object left in place)');
      setConfirmId(null);
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'failed to delete');
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const groups = groupByArrInstance(objects);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Managed objects</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {disconnected && <p className="text-sm text-muted-foreground">Live updates disconnected — retrying…</p>}
        {/* A fetch failure keeps whatever rows are already on screen (stale, but still
            useful) rather than blanking the table out from under the user — same
            convention as Activity/Attention. Registry rows only change on startup
            registration and the occasional GC pass, so a page left open after a failed
            load could sit stale for a long time before any SSE event happens to trigger a
            fresh refetch — a Retry button is the reliable way back, not a reload. */}
        {error && (
          <div className="flex items-center gap-2">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={refetch}>
              Retry
            </Button>
          </div>
        )}
        {loading && objects.length === 0 && <p className="text-muted-foreground">Loading…</p>}
        {!loading && groups.length === 0 && !error && (
          <p className="text-center text-muted-foreground">No managed objects yet.</p>
        )}
        {groups.map(([arrInstance, rows]) => (
          <Card key={arrInstance}>
            <CardHeader>
              <CardTitle>{arrInstance}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kind</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>External ID</TableHead>
                    <TableHead>Registered at</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const pending = pendingIds.has(row.id);
                    const confirming = confirmId === row.id;
                    return (
                      <TableRow key={row.id}>
                        <TableCell>
                          <Badge variant="outline">{KIND_LABEL[row.kind]}</Badge>
                        </TableCell>
                        <TableCell>{row.name ?? '—'}</TableCell>
                        <TableCell>{row.external_id}</TableCell>
                        <TableCell>{new Date(row.created_at).toLocaleString()}</TableCell>
                        <TableCell className="text-right">
                          {confirming ? (
                            <div className="flex flex-col items-end gap-1">
                              <p className="text-xs text-muted-foreground">
                                Deletes the live {KIND_LABEL[row.kind].toLowerCase()} in {arrInstance} too, not just this registry entry.
                              </p>
                              <div className="flex justify-end gap-1.5">
                                <Button variant="outline" size="sm" disabled={pending} onClick={() => setConfirmId(null)}>
                                  Cancel
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  disabled={pending}
                                  onClick={() => void handleDelete(row.id, arrInstance)}
                                >
                                  {pending ? 'Deleting…' : 'Confirm?'}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button variant="outline" size="sm" onClick={() => setConfirmId(row.id)}>
                              Delete
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))}
      </CardContent>
    </Card>
  );
}
