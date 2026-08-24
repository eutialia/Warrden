import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A clamped viewport instead of an expand affordance: the list renders in full, the
 * container shows the first stretch of it, and a bottom fade overcasts the last visible
 * row to say "there is more" — scrolling is the reveal, so nothing needs a button or
 * another nesting level. The fade drops out when the content fits or the reader reaches
 * the end.
 */
export function FadeScroll({
  maxHeight = 'max-h-44',
  contain = false,
  className,
  children,
}: {
  /** A max-height utility. Every list in the drawer shares the default so the viewports
   * read as one component wherever they appear, streaming or not. */
  maxHeight?: string;
  /** Stop scroll chaining. On for a viewport nested inside another one, where reaching the
   * end would otherwise scroll the parent out from under the reader; off at the top level,
   * where chaining into the drawer is exactly what should happen. */
  contain?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const el = ref.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const update = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Both, deliberately: the scroller stops resizing the moment the clamp bites, so it is
    // the content wrapper that reports every row appended past that point.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    observer.observe(content);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={cn('relative', className)}>
      <div ref={ref} className={cn('overflow-y-auto pr-1', contain && 'overscroll-contain', maxHeight)}>
        <div ref={contentRef}>{children}</div>
      </div>
      {more && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-popover to-transparent" />
      )}
    </div>
  );
}
