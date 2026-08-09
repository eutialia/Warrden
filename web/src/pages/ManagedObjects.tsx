import { useCallback, useEffect, useState } from 'react';
import { Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { apiErrorMessage, deleteManagedObject, fetchManagedObjects, type ManagedObject } from '@/api';
import { PageHeader } from '@/components/PageHeader';
import { StatusNotice } from '@/components/StatusNotice';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { managedKindLabel } from '@/lib/labels';
import { formatRelativeTime } from '@/lib/utils';

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
  const [confirming, setConfirming] = useState<ManagedObject | null>(null);

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

  async function handleDelete(obj: ManagedObject): Promise<void> {
    setPendingIds((prev) => new Set(prev).add(obj.id));
    try {
      const { deletedInArr } = await deleteManagedObject(obj.id);
      toast.success(
        deletedInArr
          ? `Removed from ${obj.arr_instance} and Warrden's registry`
          : 'Removed from Warrden registry (live object left in Sonarr/Radarr)',
      );
      setConfirming(null);
      refetch();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to delete'));
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(obj.id);
        return next;
      });
    }
  }

  const groups = groupByArrInstance(objects);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Arr objects"
        description="Tags, release profiles, and webhooks Warrden created inside Sonarr/Radarr so future grabs stay correct. Safe to review — delete only if you want Warrden to stop managing that object."
      />

      {disconnected && <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />}
      {error && <StatusNotice message={error} onRetry={refetch} />}

      {loading && objects.length === 0 && <Skeleton className="h-48 w-full" />}

      {!loading && groups.length === 0 && !error && (
        <Card>
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Boxes />
              </EmptyMedia>
              <EmptyTitle>Nothing registered yet</EmptyTitle>
              <EmptyDescription>
                Warrden adds a webhook to each arr at startup, then tags and release profiles as it pins series.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </Card>
      )}

      <div className="space-y-4">
        {groups.map(([arrInstance, rows]) => (
          <Card key={arrInstance} className="overflow-hidden">
            <CardHeader>
              <CardTitle>{arrInstance}</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-40 pl-4">Type</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-28 text-right">Added</TableHead>
                    <TableHead className="w-24 pr-4 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="pl-4">
                        <Badge variant="outline" className="text-muted-foreground">
                          {managedKindLabel(row.kind)}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{row.name ?? '—'}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        <Tooltip>
                          <TooltipTrigger render={<span>{formatRelativeTime(row.created_at)}</span>} />
                          <TooltipContent>{new Date(row.created_at).toLocaleString()}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pendingIds.has(row.id)}
                          onClick={() => setConfirming(row)}
                        >
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))}
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete this {confirming ? managedKindLabel(confirming.kind).toLowerCase() : 'object'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This also deletes the live {confirming ? managedKindLabel(confirming.kind).toLowerCase() : 'object'}
              {confirming ? ` "${confirming.name ?? confirming.external_id}" in ${confirming.arr_instance}` : ''} — not
              just Warrden's registry entry. Future grabs for anything relying on it will stop being pinned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel render={<Button variant="ghost">Cancel</Button>} />
            <AlertDialogAction
              render={
                <Button
                  variant="destructive"
                  disabled={confirming !== null && pendingIds.has(confirming.id)}
                  onClick={() => confirming && void handleDelete(confirming)}
                >
                  Delete
                </Button>
              }
            />
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
