import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * A numeric setting that keeps its raw text while you type. The value is mirrored
 * as a string rather than a number so an in-progress edit (an empty box, a lone
 * "-") stays typable instead of snapping back to a coerced number on every
 * keystroke; the owning form parses and validates on save.
 */
export function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  invalid = false,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  invalid?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
