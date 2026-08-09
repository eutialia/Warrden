import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiErrorMessage, fetchJobs, type Job } from '@/api';
import { AcquireOutcomeBadge, PipelineBadge, StatusBadge } from '@/components/StatusBadge';
import { PageHeader } from '@/components/PageHeader';
import { StatusNotice } from '@/components/StatusNotice';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { targetKindLabel } from '@/lib/labels';

const JOBS_LIMIT = 50;

function jobTitle(job: Job): string {
  if (job.targetTitle?.trim()) return job.targetTitle.trim();
  const payloadTitle = job.payload.title;
  if (typeof payloadTitle === 'string' && payloadTitle.trim()) return payloadTitle.trim();
  return `${targetKindLabel(job.target_kind)} #${job.target_id}`;
}

export default function Activity() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const beginFetch = useFetchGeneration();
  const refetch = useCallback(() => {
    const isStale = beginFetch();
    fetchJobs(JOBS_LIMIT)
      .then((j) => {
        if (isStale()) return;
        setJobs(j);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(apiErrorMessage(err, 'Failed to load jobs'));
      })
      .finally(() => {
        if (isStale()) return;
        setLoading(false);
      });
  }, [beginFetch]);

  const { disconnected, reconnect } = useSseRefetch(refetch);

  useEffect(refetch, [refetch]);

  return (
    <div>
      <PageHeader
        title="Jobs"
        description="Recent work Warrden is doing or has finished — finding releases, cleaning up imports, and fetching subtitles."
      />
      <Card>
        <CardContent className="space-y-3 pt-6">
          {disconnected && (
            <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />
          )}
          {error && <StatusNotice message={error} onRetry={refetch} />}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Work</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 && !loading && !error && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No jobs yet. Add a series or movie in Sonarr/Radarr, or wait for the next import.
                  </TableCell>
                </TableRow>
              )}
              {jobs.map((job) => (
                <TableRow key={job.id} className="cursor-pointer" onClick={() => navigate(`/jobs/${job.id}`)}>
                  <TableCell>
                    <div className="font-medium">{jobTitle(job)}</div>
                    <div className="text-xs text-muted-foreground">
                      {job.arr_instance} · {targetKindLabel(job.target_kind)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <PipelineBadge pipeline={job.pipeline} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={job.status} />
                      <AcquireOutcomeBadge outcome={job.acquireOutcome} />
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(job.updated_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
