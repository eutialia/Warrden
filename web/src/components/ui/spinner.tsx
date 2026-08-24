import { useEffect, useState, useSyncExternalStore } from "react"
import { Loader2Icon } from "lucide-react"
import { type Tone, TONE_TEXT } from "@/lib/tone"
import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

/** The terminal's spinner, one glyph wide. Every frame occupies the same monospace
 * cell, so it holds the text baseline in a label row instead of pushing it around
 * the way an icon does. */
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeReducedMotion(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  )
}

function BrailleSpinner({
  tone = 'info',
  intervalMs = 80,
  className,
}: {
  tone?: Tone
  intervalMs?: number
  className?: string
}) {
  const still = usePrefersReducedMotion()
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (still) return
    const id = setInterval(() => setFrame((f) => f + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, still])

  return (
    // Decorative on purpose. A `role="status"` here re-announces a new glyph twelve times a
    // second; whatever renders a spinner standing alone says "Working" once, statically,
    // next to it.
    <span
      data-slot="braille-spinner"
      aria-hidden="true"
      className={cn('font-mono leading-none select-none', TONE_TEXT[tone], className)}
    >
      {BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length]}
    </span>
  )
}

export { BrailleSpinner, Spinner }
