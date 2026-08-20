import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelativeTime } from '@/lib/utils';

export function RelativeTime({ ts }: { ts: number }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-xs text-muted-foreground">{formatRelativeTime(ts)}</span>} />
      <TooltipContent>{new Date(ts).toLocaleString()}</TooltipContent>
    </Tooltip>
  );
}
