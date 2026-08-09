import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  apiErrorMessage,
  deleteManagedObject,
  fetchManagedObjects,
  type ManagedObject,
} from '@/api';
import { PageHeader } from '@/components/PageHeader';
import { StatusNotice } from '@/components/StatusNotice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { managedKindLabel } from '@/lib/labels';

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
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const beginFetch = useFetchGeneration();
  const refetch = useCallback(() => {
    const isStale = beginFetch();
    fetchManagedObjects()
      .then((res) => {
        if (isStale()) return;
        setObjects(res.objects);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(apiErrorMessage(err, 'Failed to load Arr objects'));
      })
      .finally(() => {
        if (isStale()) return;
        setLoading(false);
      });
  }, [beginFetch]);
  const { disconnected, reconnect } = useSseRefetch(refetch);

  useEffect(refetch, [refetch]);

  async function handleDelete(id: number, arrInstance: string): Promise<void> {
    setPendingIds((prev) => new Set(prev).add(id));
    try {
      const { deletedInArr } = await deleteManagedObject(id);
      toast.success(
        deletedInArr
          ? `Removed from ${arrInstance} and Warrden's registry`
          : 'Removed from Warrden registry (live object left in Sonarr/Radarr)',
      );
      setConfirmId(null);
      refetch();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to delete'));
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
    <div>
      <PageHeader
        title="Arr objects"
        description="Tags, release profiles, and webhooks Warrden created inside Sonarr/Radarr so future grabs stay correct. Safe to review; delete only if you want Warrden to stop managing that object."
      />

      <div className="space-y-4">
        {disconnected && (
          <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />
        )}
        {error && <StatusNotice message={error} onRetry={refetch} />}
        {loading && objects.length === 0 && <p className="text-muted-foreground">Loading…</p>}
        {!loading && groups.length === 0 && !error && (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">
              Nothing registered yet. Warrden adds tags and release profiles when it pins a series, and a webhook on each arr instance at startup.
            </CardContent>
          </Card>
        )}
        {groups.map(([arrInstance, rows]) => (
          <Card key={arrInstance}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{arrInstance}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Added</TableHead>
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
                          <Badge variant="outline">{managedKindLabel(row.kind)}</Badge>
                        </TableCell>
                        <TableCell className="font-medium">{row.name ?? '—'}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(row.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {confirming ? (
                            <div className="flex flex-col items-end gap-1">
                              <p className="max-w-xs text-xs text-muted-foreground">
                                Also deletes the live {managedKindLabel(row.kind).toLowerCase()} in {arrInstance}, not
                                just this registry entry.
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
                                  {pending ? 'Deleting…' : 'Confirm delete'}
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
      </div>
    </div>
  );
}
