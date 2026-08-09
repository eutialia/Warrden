/**
 * The dashboard's status colour system.
 *
 * Colour means *state*, never category — a green chip always means "this went
 * well", an amber one always means "this wants a human". Categories (which
 * pipeline a job belongs to, what kind of object a row is) are carried by icons
 * and neutral chips instead, so a busy table doesn't read as a rainbow.
 *
 * Every tone resolves to theme tokens defined in `index.css`, so both themes are
 * covered by construction — no page should ever write `bg-emerald-100 dark:…`.
 */
export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'info' | 'danger';

/** Soft filled chip — the default for badges sitting inside dense lists. */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground border-border',
  brand: 'bg-brand-muted text-brand-foreground border-brand-border',
  success: 'bg-success-muted text-success-foreground border-success-border',
  warning: 'bg-warning-muted text-warning-foreground border-warning-border',
  info: 'bg-info-muted text-info-foreground border-info-border',
  danger: 'bg-destructive-muted text-destructive-foreground border-destructive-border',
};

/** Solid fill — status dots, progress bars, timeline rails. */
export const TONE_SOLID: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/50',
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  info: 'bg-info',
  danger: 'bg-destructive',
};

/** Text-only, for inline emphasis where a chip would be too heavy. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  brand: 'text-brand-foreground',
  success: 'text-success-foreground',
  warning: 'text-warning-foreground',
  info: 'text-info-foreground',
  danger: 'text-destructive-foreground',
};

/** Left accent rail on cards (attention items, timeline steps). */
export const TONE_RAIL: Record<Tone, string> = {
  neutral: 'border-l-border',
  brand: 'border-l-brand',
  success: 'border-l-success',
  warning: 'border-l-warning',
  info: 'border-l-info',
  danger: 'border-l-destructive',
};
