import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiErrorMessage,
  fetchLlmModels,
  type CatalogModel,
  type Effort,
  type LlmModel,
  type ModelCatalog,
} from '@/api';
import { ToneBadge } from '@/components/ToneBadge';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxFooter,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Model and effort are one choice, so the list is flattened to one row per combination,
 * around 800 of them. Rendered rows are capped rather than virtualized: nobody scrolls 800
 * rows, and a few keystrokes narrow the list far below the cap. */
const ROW_CAP = 200;

/** One selectable model/effort pair. */
interface ModelRow {
  key: string;
  label: string;
  detail: string;
  model: string;
  effort?: Effort;
  /** Model id and display name, lowercased once here so filtering stays a substring test. */
  search: string;
}

/** OpenRouter quotes USD per token, which reads as scientific-notation noise. Per million
 * tokens is the unit models are actually compared on. */
function perMillion(perToken: string): string {
  const value = Number(perToken) * 1_000_000;
  if (!Number.isFinite(value)) return '?';
  if (value === 0) return 'free';
  return `$${value < 0.01 ? value.toPrecision(1) : value.toFixed(2)}`;
}

function rowLabel(model: string, effort?: string): string {
  return effort === undefined ? model : `${model} · ${effort === 'none' ? 'no thinking' : effort}`;
}

/**
 * A tiered model gets one row per tier and no effort-less row: omitting the effort would
 * leave the provider's own default in charge, and a picker whose rows name a level should not
 * also offer an unnamed one. A model that reasons without tiers has nothing to name, so its
 * plain row IS the provider default. `none` is offered wherever reasoning is optional, since
 * sending no effort does not switch thinking off on a model that reasons by default.
 */
function rowsFor(m: CatalogModel): ModelRow[] {
  const detail = `${m.name} · ${perMillion(m.pricing.prompt)} in / ${perMillion(m.pricing.completion)} out per 1M`;
  const search = `${m.id} ${m.name}`.toLowerCase();
  const row = (effort: Effort | undefined, suffix?: string): ModelRow => ({
    key: `${m.id}::${effort ?? ''}`,
    label: rowLabel(m.id, effort),
    detail: suffix ? `${detail} · ${suffix}` : detail,
    model: m.id,
    ...(effort ? { effort } : {}),
    search,
  });

  if (!m.reasoningCapable) return [row(undefined)];

  const rows: ModelRow[] = [];
  if (m.supportedEfforts.length === 0) rows.push(row(undefined, 'provider default'));
  if (!m.mandatoryReasoning) rows.push(row('none'));
  for (const effort of m.supportedEfforts) {
    rows.push(row(effort as Effort, effort === m.defaultEffort ? 'default' : undefined));
  }
  return rows;
}

/** The row standing in for a configured model no offered row matches. Either the catalog
 * doesn't list it at all (retired, or renamed upstream), or it does but the stored effort
 * isn't among its rows, which is what a tiered model with no effort saved looks like. A
 * stale config should be visible, not an empty field. */
function pinnedRow(value: LlmModel, catalogued: CatalogModel | undefined): ModelRow {
  const label = rowLabel(value.model, value.effort);
  const detail = !catalogued
    ? 'Not in the OpenRouter catalog'
    : value.effort === undefined
      ? `Provider default${catalogued.defaultEffort ? ` (${catalogued.defaultEffort})` : ''}. Pick a row to set it explicitly.`
      : 'This model does not offer that reasoning effort. Pick a row to change it.';
  return {
    key: `pinned::${label}`,
    label,
    detail,
    model: value.model,
    ...(value.effort ? { effort: value.effort } : {}),
    search: value.model.toLowerCase(),
  };
}

/**
 * The OpenRouter model picker. Owns its own catalog fetch: a settings page that can't
 * reach OpenRouter must still save everything else, so a failed fetch degrades to a
 * free-text model id here rather than failing the page.
 */
export function ModelPicker({
  value,
  onChange,
}: {
  value: LlmModel | undefined;
  onChange: (next: LlmModel | undefined) => void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(() => {
    setError(null);
    fetchLlmModels()
      .then(setCatalog)
      .catch((err: unknown) => {
        setCatalog(null);
        setError(apiErrorMessage(err, 'Could not load the model list'));
      });
  }, []);

  useEffect(load, [load]);

  const catalogRows = useMemo(() => (catalog?.models ?? []).flatMap(rowsFor), [catalog]);

  const rows = useMemo(() => {
    if (!value) return catalogRows;
    if (catalogRows.some((r) => r.model === value.model && r.effort === value.effort)) return catalogRows;
    return [pinnedRow(value, catalog?.models.find((m) => m.id === value.model)), ...catalogRows];
  }, [catalog, catalogRows, value]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === '' ? rows : rows.filter((r) => r.search.includes(needle));
  }, [rows, query]);

  const visible = matches.length > ROW_CAP ? matches.slice(0, ROW_CAP) : matches;
  const selected = useMemo(
    () => rows.find((r) => r.model === value?.model && r.effort === value?.effort) ?? null,
    [rows, value],
  );

  const loading = catalog === null && error === null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-xs" htmlFor="llm-model">
          Model
        </Label>
        {catalog?.stale && <ToneBadge tone="neutral">Cached list</ToneBadge>}
      </div>
      {error ? (
        <>
          <Input
            id="llm-model"
            value={value?.model ?? ''}
            placeholder="e.g. openai/gpt-5"
            onChange={(e) =>
              onChange(e.target.value.trim() === '' ? undefined : { provider: 'openrouter', model: e.target.value })
            }
          />
          <p className="text-xs text-muted-foreground">
            {error}. Type a model id, or{' '}
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={load}>
              try loading the list again
            </Button>
            .
          </p>
        </>
      ) : (
        <Combobox<ModelRow>
          items={visible}
          // Filtering is ours: it has to match the display name as well as the id, and the
          // cap below needs the true match count, which internal filtering doesn't expose.
          filter={null}
          value={selected}
          isItemEqualToValue={(a, b) => a.key === b.key}
          itemToStringLabel={(row) => row.label}
          onInputValueChange={setQuery}
          onOpenChange={(open) => {
            if (!open) setQuery('');
          }}
          onValueChange={(row) => {
            if (!row) return;
            onChange({ provider: 'openrouter', model: row.model, ...(row.effort ? { effort: row.effort } : {}) });
          }}
        >
          <ComboboxTrigger id="llm-model" disabled={loading}>
            <ComboboxValue placeholder={loading ? 'Loading models…' : 'Choose a model'} />
          </ComboboxTrigger>
          <ComboboxContent>
            <ComboboxInput placeholder="Search by model id or name" />
            <ComboboxEmpty>No model matches that search.</ComboboxEmpty>
            <ComboboxList>
              {(row: ModelRow) => (
                <ComboboxItem key={row.key} value={row} description={row.detail}>
                  {row.label}
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
      )}
      {!error && (
        <p className="text-xs text-muted-foreground">
          One row per model and reasoning effort. Picking a row sets both.
        </p>
      )}
    </div>
  );
}
