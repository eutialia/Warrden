import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiErrorMessage, fetchJobs, type Job } from '@/api';
import { AcquireOutcomeBadge, StatusBadge } from '@/components/StatusBadge';
import { StatusNotice } from '@/components/StatusNotice';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useSseRefetch } from '@/hooks/useSseRefetch';

const JOBS_LIMIT = 50;

export default function Activity() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const refetch = useCallback(() => {
    fetchJobs(JOBS_LIMIT)
      .then((j) => {
        setJobs(j);
        setError(null);
      })
      .catch((err: unknown) => setError(apiErrorMessage(err, 'failed to load jobs')))
      .finally(() => setLoading(false));
  }, []);

  // Any event (job update, acquire result, etc.) can mean the job list changed, so just
  // refetch wholesale on every message rather than trying to reconcile individual rows.
  // Debounce left at useSseRefetch's own default (a busy pipeline can write several
  // job-queue/acquire-record rows in quick succession; coalesce to one refetch per burst).
  const { disconnected, reconnect } = useSseRefetch(refetch);

  useEffect(refetch, [refetch]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {disconnected && <StatusNotice tone="muted" message="Live updates disconnected — retrying…" onRetry={reconnect} />}
        {error && <StatusNotice message={error} onRetry={refetch} />}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pipeline</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.length === 0 && !loading && !error && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  No jobs yet.
                </TableCell>
              </TableRow>
            )}
            {jobs.map((job) => (
              <TableRow key={job.id} className="cursor-pointer" onClick={() => navigate(`/jobs/${job.id}`)}>
                <TableCell>{job.pipeline}</TableCell>
                <TableCell>
                  {job.arr_instance} · {job.target_kind} #{job.target_id}
                </TableCell>
                <TableCell className="flex items-center gap-1.5">
                  <StatusBadge status={job.status} />
                  <AcquireOutcomeBadge outcome={job.acquireOutcome} />
                </TableCell>
                <TableCell>{new Date(job.updated_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
