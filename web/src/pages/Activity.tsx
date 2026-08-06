import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchJobs, type Job } from '@/api';
import { StatusBadge } from '@/components/StatusBadge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const JOBS_LIMIT = 50;

export default function Activity() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const refetch = useCallback(() => {
    fetchJobs(JOBS_LIMIT)
      .then(setJobs)
      .catch((err: unknown) => console.error('failed to load jobs', err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refetch();

    // Any event (job update, acquire result, etc.) can mean the job list changed, so just
    // refetch wholesale on every message rather than trying to reconcile individual rows.
    const source = new EventSource('/api/events/stream');
    source.onmessage = () => refetch();
    return () => source.close();
  }, [refetch]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardContent>
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
            {jobs.length === 0 && !loading && (
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
                <TableCell>
                  <StatusBadge status={job.status} />
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
