import { useRef } from 'react';
import { clamp } from '@/lib/utils';

export const INSPECTOR_MIN_W = 320;
export const INSPECTOR_MAX_SHARE = 0.65;

/** A vertical grab bar that resizes the panel to its right. Width is reported in pixels
 * from the pointer's distance to the parent's right edge, clamped to a readable range. */
export function ResizeHandle({ onResize }: { onResize: (width: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      className="group relative w-1.5 cursor-col-resize select-none"
      onPointerDown={(ev) => {
        const parent = ref.current?.parentElement;
        if (!parent) return;
        ev.currentTarget.setPointerCapture(ev.pointerId);
        const rect = parent.getBoundingClientRect();
        const max = rect.width * INSPECTOR_MAX_SHARE;
        const move = (e: PointerEvent) => onResize(clamp(rect.right - e.clientX, INSPECTOR_MIN_W, max));
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:w-0.5 group-hover:bg-ring group-active:w-0.5 group-active:bg-ring" />
    </div>
  );
}
