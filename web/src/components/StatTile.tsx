import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TONE_TEXT, type Tone } from '@/lib/tone';
import { cn } from '@/lib/utils';

/**
 * One number plus what it means. Tiles stay neutral when the number is
 * unremarkable and only take a tone when it's worth a human's eye — a permanently
 * amber dashboard trains people to ignore amber.
 */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'neutral',
  to,
  loading = false,
}: {
  label: string;
  value: number | string;
  hint?: string;
  icon: LucideIcon;
  tone?: Tone;
  /** Makes the whole tile a link when there's a page that explains the number. */
  to?: string;
  loading?: boolean;
}) {
  const body = (
    <CardContent className="flex items-start justify-between gap-3 p-4">
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {loading ? (
          <Skeleton className="h-8 w-12" />
        ) : (
          <p className={cn('text-3xl font-semibold tabular-nums tracking-tight', tone !== 'neutral' && TONE_TEXT[tone])}>
            {value}
          </p>
        )}
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Icon className={cn('size-4.5 shrink-0', tone === 'neutral' ? 'text-muted-foreground' : TONE_TEXT[tone])} />
    </CardContent>
  );

  const card = (
    <Card className={cn('h-full py-0 transition-colors', to && 'hover:border-ring/60 hover:bg-accent/40')}>{body}</Card>
  );

  return to ? (
    <Link to={to} className="block rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
      {card}
    </Link>
  ) : (
    card
  );
}
