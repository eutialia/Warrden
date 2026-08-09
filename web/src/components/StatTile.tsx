import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { TONE_TEXT, type Tone } from '@/lib/tone';
import { cn } from '@/lib/utils';

/**
 * The band a row of stats sits in: one rule above, one below, a hairline between
 * the figures. No boxes — the rules do the work, so the numbers stay the only
 * thing the eye lands on.
 */
export function StatBand({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 border-y sm:grid-cols-4',
        '[&>*]:border-l [&>*]:pl-5 [&>*:nth-child(odd)]:border-l-0 [&>*:nth-child(odd)]:pl-0',
        'sm:[&>*:nth-child(odd)]:border-l sm:[&>*:nth-child(odd)]:pl-5 sm:[&>*:first-child]:border-l-0 sm:[&>*:first-child]:pl-0'
      )}
    >
      {children}
    </div>
  );
}

/**
 * One number plus what it means. Numbers are set in the serif at tabular figures
 * — they are the thing people scan from across a room. Tiles stay neutral when
 * the number is unremarkable and only take a tone when it's worth a human's eye:
 * a permanently amber dashboard trains people to ignore amber.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  to,
  loading = false,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: Tone;
  /** Makes the whole tile a link when there's a page that explains the number. */
  to?: string;
  loading?: boolean;
}) {
  const body = (
    <>
      {loading ? (
        <Skeleton className="h-7 w-12" />
      ) : (
        <span className={cn('font-serif text-3xl leading-none tabular-nums', tone !== 'neutral' && TONE_TEXT[tone])}>
          {value}
        </span>
      )}
      <span className="text-xs text-muted-foreground group-hover/stat:text-foreground">{label}</span>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </>
  );

  const shell = 'flex min-w-0 flex-col gap-1.5 py-4 pr-5';

  return to ? (
    <Link
      to={to}
      className={cn(shell, 'group/stat transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none')}
    >
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}
