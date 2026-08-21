import { useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { chipBarClass, chipClass, cn } from '@/lib/utils';

/**
 * Freeform chip bar: type, Enter (or comma), it becomes a chip with ×, same
 * chrome as the language combobox. Parent owns the string[] and decides when to persist
 * it: Config batches chips behind its Save button, Sites writes on every change.
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
      className={cn(chipBarClass, disabled && 'opacity-50', className)}
    >
      {values.map((v) => (
        <span key={v} className={cn(chipClass, 'whitespace-normal')}>
          <span className="min-w-0 text-left">{v}</span>
          {!disabled && (
            <button
              type="button"
              className="rounded-sm p-0.5 hover:bg-muted [&_svg]:size-3"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <X />
            </button>
          )}
        </span>
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
        className="h-7 min-h-0 min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
      />
    </div>
  );
}
