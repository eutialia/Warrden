import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxFooter,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from '@/components/ui/combobox';
import { filterLanguages, languageName, type LanguageOption } from '@/lib/languages';

/** Same cap as the model picker: a few keystrokes drop the list far below it. */
const ROW_CAP = 200;

function optionFor(tag: string): LanguageOption {
  return { tag, name: languageName(tag) };
}

/**
 * Closed language picker: BCP-47 chips live inside the combobox, each with an ×.
 * Addition order is the config order, most-wanted first.
 */
export function LanguageInput({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [query, setQuery] = useState('');

  const selected = useMemo(() => values.map(optionFor), [values]);
  const matches = useMemo(() => filterLanguages(query), [query]);
  const visible = matches.length > ROW_CAP ? matches.slice(0, ROW_CAP) : matches;
  const items = useMemo(() => {
    const extras = selected.filter((row) => !visible.some((v) => v.tag === row.tag));
    return extras.length === 0 ? visible : [...extras, ...visible];
  }, [selected, visible]);

  return (
    <Combobox<LanguageOption, true>
      multiple
      items={items}
      filter={null}
      value={selected}
      isItemEqualToValue={(a, b) => a.tag === b.tag}
      itemToStringLabel={(row) => row.name}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (!open) setQuery('');
      }}
      onValueChange={(rows) => {
        onChange(rows.map((row) => row.tag));
      }}
    >
      <ComboboxChips>
        <ComboboxValue>
          {(rows: LanguageOption[]) => (
            <>
              {rows.map((row) => (
                <ComboboxChip key={row.tag} aria-label={row.tag}>
                  <span className="font-mono text-xs">{row.tag}</span>
                  {row.name !== row.tag && <span className="text-muted-foreground">{row.name}</span>}
                  <ComboboxChipRemove aria-label={`Remove ${row.tag}`}>
                    <X />
                  </ComboboxChipRemove>
                </ComboboxChip>
              ))}
              <ComboboxInput
                placeholder={rows.length === 0 ? 'Add a language' : 'Add…'}
                className="h-7 min-w-[8rem] flex-1 border-0 bg-transparent px-1 shadow-none"
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent>
        <ComboboxEmpty>No language matches that search.</ComboboxEmpty>
        <ComboboxList>
          {(row: LanguageOption) => (
            <ComboboxItem key={row.tag} value={row} description={row.tag}>
              {row.name}
            </ComboboxItem>
          )}
        </ComboboxList>
        {visible.length < matches.length && (
          <ComboboxFooter>
            Showing {ROW_CAP} of {matches.length} matches. Keep typing to narrow them down.
          </ComboboxFooter>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
