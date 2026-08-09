import { Badge } from '@/components/ui/badge';
import type { AccessTier } from '@/api';
import { tierLabel } from '@/lib/labels';
import { cn } from '@/lib/utils';

export function TierBadge({ tier, className }: { tier: AccessTier | null; className?: string }) {
  if (tier === null) {
    return (
      <Badge variant="outline" className={cn('text-muted-foreground', className)}>
        {tierLabel(null)}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn('font-medium', className)}>
      {tierLabel(tier)}
    </Badge>
  );
}
