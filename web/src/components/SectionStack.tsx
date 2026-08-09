import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Stacks the sections of a page. Separation is a hairline rule plus space —
 * never a filled, shadowed box — so the first section starts flush and every
 * one after it gets a rule above.
 */
export function SectionStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('space-y-8 [&>*+*]:border-t [&>*+*]:pt-8', className)}>{children}</div>;
}
