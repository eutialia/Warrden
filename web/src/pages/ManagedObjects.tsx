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

  // Bumped on every refetch; a response is only applied if it's still the most recent
  // request by the time it lands — same idea as Attention.tsx's `requestIdRef`, needed
  // here too since an SSE event and a post-delete refetch can overlap the initial load.
  const requestIdRef = useRef(0);

  const refetch = useCallback(() => {
    const requestId = ++requestIdRef.current;
    const isStale = () => requestIdRef.current !== requestId;
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
  }, []);

  useEffect(refetch, [refetch]);

  useEffect(() => {
    // Registration happens at startup and during acquire (tag/release-profile pinning);
    // GC during reconcile can remove rows out from under this page too — any event can
    // mean the set changed, so refetch wholesale rather than trying to reconcile rows.
    const source = new EventSource('/api/events/stream');
    source.onmessage = () => refetch();
    return () => source.close();
  }, [refetch]);

  async function handleDelete(id: number): Promise<void> {
    setPendingIds((prev) => new Set(prev).add(id));
    try {
      await deleteManagedObject(id);
      toast.success('Deleted');
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

  if (error) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={refetch}>
          Retry
        </Button>
      </div>
    );
  }

  if (loading) {
    return <p className="text-muted-foreground">Loading…</p>;
  }

  const groups = groupByArrInstance(objects);

  return (
    <div className="space-y-4">
      {groups.length === 0 && (
        <Card>
          <CardContent className="pt-4 text-center text-muted-foreground">No managed objects yet.</CardContent>
        </Card>
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
                          <div className="flex justify-end gap-1.5">
                            <Button variant="outline" size="sm" disabled={pending} onClick={() => setConfirmId(null)}>
                              Cancel
                            </Button>
                            <Button variant="destructive" size="sm" disabled={pending} onClick={() => void handleDelete(row.id)}>
                              {pending ? 'Deleting…' : 'Confirm?'}
                            </Button>
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
    </div>
  );
}
