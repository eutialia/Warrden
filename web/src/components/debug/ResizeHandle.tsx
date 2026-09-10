import { useRef } from 'react';
import { clamp } from '@/lib/utils';

export const INSPECTOR_MIN_W = 320;
export const INSPECTOR_MAX_SHARE = 0.65;

/** A vertical grab bar that resizes the panel to its right. Width is reported in pixels
 * from the pointer's distance to the parent's right edge, clamped to a readable range. */
export function ResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Pointer capture routes every move and release to this element for the life of the
  // drag, so no window listener exists to outlive an unmount mid-drag.
  const drag = useRef<{ right: number; max: number } | null>(null);
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      className="group relative w-1.5 cursor-col-resize select-none"
      onPointerDown={(ev) => {
        const parent = ref.current?.parentElement;
        if (!parent) return;
        const rect = parent.getBoundingClientRect();
        drag.current = { right: rect.right, max: rect.width * INSPECTOR_MAX_SHARE };
        ev.currentTarget.setPointerCapture(ev.pointerId);
      }}
      onPointerMove={(ev) => {
        const d = drag.current;
        if (d) onResize(clamp(d.right - ev.clientX, INSPECTOR_MIN_W, d.max));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:w-0.5 group-hover:bg-ring group-active:w-0.5 group-active:bg-ring" />
    </div>
  );
}
