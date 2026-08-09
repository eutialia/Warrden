import { useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Chip/tag editor: type a value, press Enter or comma to add; click × to remove.
 * Parent owns the string[] and only persists on its own Save.
 */
export function TagInput({
  values,
  onChange,
  placeholder = 'Type and press Enter',
  disabled,
  className,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState('');

  function commit(raw: string): void {
    const parts = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) return;
    const next = [...values];
    for (const p of parts) {
      if (!next.includes(p)) next.push(p);
    }
    onChange(next);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div
      className={cn(
        'flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5',
        disabled && 'opacity-50',
        className,
      )}
    >
      {/* Picking preferences are written as whole sentences, so a chip has to be able
          to wrap rather than truncate the policy mid-word. */}
      {values.map((v) => (
        <Badge key={v} variant="secondary" className="h-auto max-w-full gap-1 py-1 pr-1 font-normal whitespace-normal">
          <span className="min-w-0 text-left">{v}</span>
          {!disabled && (
            <button
              type="button"
              className="rounded-sm p-0.5 hover:bg-muted"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <X className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      <Input
        value={draft}
        disabled={disabled}
        placeholder={values.length === 0 ? placeholder : 'Add…'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
        className="h-7 min-w-[8rem] flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
      />
    </div>
  );
}
