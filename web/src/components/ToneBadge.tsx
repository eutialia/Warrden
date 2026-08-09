import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { TONE_SOFT, TONE_SOLID, type Tone } from '@/lib/tone';
import { cn } from '@/lib/utils';

/**
 * The one badge every status in the dashboard goes through. Callers pass a
 * semantic `tone` rather than colour classes, so light/dark and any future
 * palette change are handled in `lib/tone.ts` alone.
 */
export function ToneBadge({
  tone = 'neutral',
  dot = false,
  pulse = false,
  className,
  children,
}: {
  tone?: Tone;
  /** Leading status dot — worth it in dense lists where the chip text is small. */
  dot?: boolean;
  /** Animate the dot, for genuinely in-flight states only. */
  pulse?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium', TONE_SOFT[tone], className)}>
      {dot && (
        <span className="relative flex size-1.5 shrink-0">
          {pulse && (
            <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-75', TONE_SOLID[tone])} />
          )}
          <span className={cn('relative inline-flex size-1.5 rounded-full', TONE_SOLID[tone])} />
        </span>
      )}
      {children}
    </Badge>
  );
}

/** Bare status dot for tight spots (health rows, sidebar rails) where even a
 * chip is too much furniture. */
export function StatusDot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative flex size-2 shrink-0', className)}>
      {pulse && (
        <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-75', TONE_SOLID[tone])} />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', TONE_SOLID[tone])} />
    </span>
  );
}
