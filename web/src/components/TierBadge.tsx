import { Badge } from '@/components/ui/badge';
import type { AccessTier } from '@/api';

// A raw `AccessTier` reads fine in a log line but not as dashboard copy. The variant ladder
// matches StatusBadge's own: the cheapest working tier gets the "good" default, a
// discovered-but-pricier tier stays secondary, and `null` (no tier ever worked) renders an
// outline badge so a missing tier doesn't read as an empty cell lurking in the table.
const TIER_VARIANT: Record<AccessTier, 'default' | 'secondary'> = {
  curl: 'default',
  chromium: 'secondary',
  camoufox: 'secondary',
  remote: 'secondary',
};

export function TierBadge({ tier, className }: { tier: AccessTier | null; className?: string }) {
  if (tier === null) return <Badge variant="outline">no tier</Badge>;
  return (
    <Badge variant={TIER_VARIANT[tier]} className={className}>
      {tier}
    </Badge>
  );
}
