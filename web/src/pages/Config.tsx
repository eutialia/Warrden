import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import {
  apiErrorMessage,
  fetchArrHealth,
  fetchConfig,
  fetchStorageHealth,
  saveConfig,
  type ArrCheck,
  type ArrInstance,
  type ArrKind,
  type Config,
  type LlmModel,
  type Provider,
  type StorageCheck,
} from '@/api';
import { ArrHealth } from '@/components/ArrHealth';
import { MountHealth } from '@/components/MountHealth';
import { NumberField } from '@/components/NumberField';
import { PageHeader } from '@/components/PageHeader';
import { SectionStack } from '@/components/SectionStack';
import { StatusNotice } from '@/components/StatusNotice';
import { THEME_OPTIONS } from '@/components/ThemeToggle';
import { TagInput } from '@/components/TagInput';
import { StatusDot, ToneBadge } from '@/components/ToneBadge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { arrStatusLabel, arrStatusTone, storageStatusLabel, storageStatusTone } from '@/lib/labels';
import { TONE_TEXT } from '@/lib/tone';
import { cn, formatUsage } from '@/lib/utils';

const EMPTY_ARR: ArrInstance = { name: '', kind: 'sonarr', baseUrl: '', apiKey: '' };

/** The providers a model can run on. The same list backs the picker and the per-provider
 * key field, so a new provider is one entry, not three. */
const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
];

/** Mirrors server `standardMounts` — web has no shared package with the backend. */
const STANDARD_MOUNT_ROWS = [
  { id: 'series', label: 'Series', path: '/tv', blurb: 'Sonarr Series root folder' },
  { id: 'anime', label: 'Anime', path: '/anime', blurb: 'Sonarr Anime root folder' },
  { id: 'movies', label: 'Movies', path: '/movies', blurb: 'Radarr library root' },
  { id: 'downloads', label: 'Downloads', path: '/downloads', blurb: 'Torrent download / completed root' },
] as const;

/** Spans offered for the event log. `0` is "keep everything" — the schema takes any
 * non-negative number, but a dropdown of every possibility helps nobody. */
const RETENTION_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '0', label: 'Forever' },
] as const;

/** Numeric settings are held as text while editing so a half-typed value stays
 * typable; they are parsed once, at save. */
interface NumericDraft {
  seederFloor: string;
  minSizeMB: string;
  maxSizeMB: string;
  stepBudget: string;
  siteCooldownSeconds: string;
  reconcileIntervalMinutes: string;
}

function numericFrom(c: Config): NumericDraft {
  return {
    seederFloor: String(c.picking.seederFloor),
    minSizeMB: String(c.picking.minSizeMB),
    maxSizeMB: String(c.picking.maxSizeMB),
    stepBudget: String(c.browser.stepBudget),
    siteCooldownSeconds: String(c.browser.siteCooldownSeconds),
    reconcileIntervalMinutes: String(c.reconcileIntervalMinutes),
  };
}

/** An untouched row, the one the "Add instance" button leaves behind. It is dropped on
 * save; anything with a single field typed into it is a half-finished instance instead,
 * and gets refused rather than quietly discarded. */
function isBlankArr(arr: ArrInstance): boolean {
  return arr.name === '' && arr.baseUrl === '' && arr.apiKey === '';
}

function parseNumber(text: string): number | undefined {
  const trimmed = text.trim();
  const value = Number(trimmed);
  return trimmed === '' || Number.isNaN(value) ? undefined : value;
}

export default function ConfigPage() {
  const [baseline, setBaseline] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [numeric, setNumeric] = useState<NumericDraft | null>(null);
  const [baseNumeric, setBaseNumeric] = useState<NumericDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [storageChecks, setStorageChecks] = useState<StorageCheck[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  // `null` is "nobody has answered": before the first probe, and after one whose REQUEST
  // failed (network, or the server erroring). An instance-less install is not that case —
  // the route always exists and answers `{ checks: [] }`. Either way `null` is an absence
  // of data, not a verdict, so the rows stay quiet rather than accusing every instance of
  // being down.
  const [arrChecks, setArrChecks] = useState<ArrCheck[] | null>(null);
  const { theme, setTheme } = useTheme();

  const loadArrHealth = useCallback(() => {
    fetchArrHealth()
      .then((res) => setArrChecks(res.checks))
      .catch(() => setArrChecks(null));
  }, []);

  const loadStorage = useCallback(() => {
    fetchStorageHealth()
      .then((res) => {
        setStorageChecks(res.checks);
        setStorageError(null);
      })
      .catch((err: unknown) => {
        // A failed probe is not the same as four missing mounts. Say which it was, or
        // "Re-check now" looks like it does nothing.
        setStorageChecks([]);
        setStorageError(apiErrorMessage(err, 'Could not check the mounts'));
      });
  }, []);

  const loadFormState = useCallback((c: Config) => {
    setBaseline(structuredClone(c));
    setDraft(structuredClone(c));
    setNumeric(numericFrom(c));
    setBaseNumeric(numericFrom(c));
    setSaveError(null);
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    // Three independent routes, each with its own error handling and its own piece of the
    // page — chaining the probes behind the config read only made the page slower to settle.
    loadStorage();
    loadArrHealth();
    fetchConfig()
      .then(loadFormState)
      .catch((err: unknown) => setLoadError(apiErrorMessage(err, 'Failed to load settings')));
  }, [loadFormState, loadStorage, loadArrHealth]);

  useEffect(load, [load]);

  // A router navigation doesn't act on the fragment the way a real page load would, and
  // the section it names doesn't exist until the config resolves — so "Check mounts" on
  // the home screen would otherwise just drop you at the top of a long page.
  // Depending on `draft` itself would re-scroll on every keystroke, since each edit
  // clones it; only its arrival matters.
  const { hash } = useLocation();
  const loaded = draft !== null;
  useEffect(() => {
    if (!hash || !loaded) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash, loaded]);

  // One dirty flag for the whole page. The API saves the config atomically anyway,
  // so per-section saves were both more clicks and a lie about the granularity.
  const dirty = useMemo(() => {
    if (!draft || !baseline || !numeric || !baseNumeric) return false;
    return JSON.stringify(draft) !== JSON.stringify(baseline) || JSON.stringify(numeric) !== JSON.stringify(baseNumeric);
  }, [draft, baseline, numeric, baseNumeric]);

  function patch(next: Partial<Config>): void {
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
  }

  /** Field-level edit of `llm.model`, upserting: the provider Select is the one control that
   * renders before a model exists, and choosing from nothing seeds an empty model id because
   * the card only asks for a model once it knows where the model lives. Switching provider on
   * a configured model keeps the id that was typed, since it is the operator's to rewrite,
   * not ours to clear. */
  function patchModel(next: Partial<LlmModel>): void {
    setDraft((prev) =>
      prev
        ? { ...prev, llm: { ...prev.llm, model: { provider: 'openrouter', model: '', ...prev.llm.model, ...next } } }
        : prev,
    );
  }

  async function handleSave(): Promise<void> {
    if (!draft || !numeric) return;

    const parsed = {
      seederFloor: parseNumber(numeric.seederFloor),
      minSizeMB: parseNumber(numeric.minSizeMB),
      maxSizeMB: parseNumber(numeric.maxSizeMB),
      stepBudget: parseNumber(numeric.stepBudget),
      siteCooldownSeconds: parseNumber(numeric.siteCooldownSeconds),
      reconcileIntervalMinutes: parseNumber(numeric.reconcileIntervalMinutes),
    };
    if (Object.values(parsed).some((v) => v === undefined)) {
      setSaveError('Every numeric setting needs a number.');
      toast.error('Some numeric settings are not numbers');
      return;
    }

    const arrs = draft.arrs.map((a) => ({
      ...a,
      name: a.name.trim(),
      baseUrl: a.baseUrl.trim(),
      apiKey: a.apiKey.trim(),
    }));
    // A half-filled instance is a mistake, not a decision: refuse the save and name the
    // row, rather than dropping the operator's typing on the floor the way the blank one is.
    const halfFilled = arrs.findIndex((a) => !isBlankArr(a) && (!a.name || !a.baseUrl || !a.apiKey));
    if (halfFilled !== -1) {
      const which = arrs[halfFilled].name || `Instance ${halfFilled + 1}`;
      const message = `${which} needs a name, a base URL and an API key.`;
      setSaveError(message);
      toast.error(message);
      return;
    }

    // A provider with no model id is an unfinished choice, not a decision to run without a
    // model — the same rule as the half-filled instance above. Dropping it silently sent a
    // green toast while the card snapped back to empty. "Clear the model" is the way out.
    if (draft.llm.model && draft.llm.model.model.trim() === '') {
      const message = 'AI model needs a model id. Fill it in or clear the model.';
      setSaveError(message);
      toast.error(message);
      return;
    }

    // Keys go up as typed, minus the whitespace a paste drags in. The config PUT is the
    // whole document, so a field left empty is a key the operator deleted. Nothing is
    // merged back server-side.
    const keys: Config['llm']['keys'] = {};
    for (const { value: provider } of PROVIDERS) {
      const typed = draft.llm.keys[provider]?.trim();
      if (typed) keys[provider] = typed;
    }

    setSaving(true);
    setSaveError(null);
    try {
      // The PUT is the whole document, but this page only owns part of it. Rebasing on a
      // fresh read means a save here can't revert what another page (Subtitle sources) wrote
      // since this one mounted — mounts and path mappings, which no page edits, ride along
      // the same way.
      const current = await fetchConfig();
      const payload: Config = {
        ...current,
        server: { ...current.server, publicUrl: draft.server.publicUrl.trim() },
        arrs: arrs.filter((a) => !isBlankArr(a)),
        picking: {
          prefer: draft.picking.prefer,
          avoid: draft.picking.avoid,
          seederFloor: parsed.seederFloor!,
          minSizeMB: parsed.minSizeMB!,
          maxSizeMB: parsed.maxSizeMB!,
        },
        browser: { stepBudget: parsed.stepBudget!, siteCooldownSeconds: parsed.siteCooldownSeconds! },
        llm: { keys, model: draft.llm.model },
        reconcileIntervalMinutes: parsed.reconcileIntervalMinutes!,
        eventRetentionDays: draft.eventRetentionDays,
        debug: draft.debug,
      };

      await saveConfig(payload);
      toast.success('Settings saved');
      // Same three independent reads as `load()`, and re-read for the same reason: the
      // server is the authority on what was actually stored, and both probes now have new
      // instances to answer for.
      loadStorage();
      loadArrHealth();
      loadFormState(await fetchConfig());
    } catch (err) {
      const message = apiErrorMessage(err, 'Failed to save');
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <PageHeader title="Settings" description="Connections and preferences for Warrden." />
        <StatusNotice message={loadError} onRetry={load} />
      </div>
    );
  }

  if (!draft || !numeric || !baseline) {
    return (
      <div className="space-y-4">
        <PageHeader title="Settings" description="Connections and preferences for Warrden." />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const model = draft.llm.model;

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title="Settings"
        description="Connect Sonarr and Radarr, tune how releases are picked, and choose which model handles each task. Subtitle languages and sites live under Subtitle sources."
      />

      <SectionStack>
        {/* Appearance. The header keeps its own toggle for reach, but the choice is a
            setting, so it belongs here too rather than only behind an icon. */}
        <Card id="appearance" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-2xl">Appearance</CardTitle>
            <CardDescription>Dark is the default. Follow system takes the choice from your OS instead.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              {THEME_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  variant={theme === option.value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTheme(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Connections */}
        <Card id="connections" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-2xl">Connections</CardTitle>
            <CardDescription>
              The Sonarr and Radarr instances Warrden talks to. Public URL is the address those apps use to reach this
              container for webhooks.
            </CardDescription>
            <CardAction>
              <ArrHealth checks={arrChecks ?? []} />
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="public-url">Public URL</Label>
              <Input
                id="public-url"
                value={draft.server.publicUrl}
                onChange={(e) => patch({ server: { ...draft.server, publicUrl: e.target.value } })}
                placeholder="http://warrden.example:9797"
              />
              <p className="text-xs text-muted-foreground">
                Must be reachable from Sonarr/Radarr. Changing it later means deleting the “Warrden” webhook in the arr
                so it can re-register.
              </p>
            </div>

            <div className="space-y-3">
              {draft.arrs.map((arr, i) => {
                // Matched by name, the only identity an instance has. A row that was just
                // typed, or renamed since the last save, matches nothing; with no probe
                // answered at all there is nothing to say about any of them.
                const check = arrChecks?.find((c) => c.name === arr.name.trim());
                const tone = check ? arrStatusTone(check.status) : 'neutral';
                const status = check ? arrStatusLabel(check.status) : arrChecks ? 'Not saved yet' : '';
                return (
                  <div key={i} className="space-y-2 border-t pt-3">
                    <div className="flex items-center gap-2">
                      <StatusDot tone={tone} />
                      <span className={cn('text-xs font-medium', check ? TONE_TEXT[tone] : 'text-muted-foreground')}>
                        {status}
                      </span>
                    </div>
                    <div className="grid gap-3 lg:grid-cols-[1fr_9rem_1.5fr_1.5fr_auto]">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Name</Label>
                        <Input
                          placeholder="sonarr"
                          value={arr.name}
                          onChange={(e) =>
                            patch({ arrs: draft.arrs.map((a, j) => (j === i ? { ...a, name: e.target.value } : a)) })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Type</Label>
                        <Select
                          value={arr.kind}
                          onValueChange={(v) =>
                            v && patch({ arrs: draft.arrs.map((a, j) => (j === i ? { ...a, kind: v as ArrKind } : a)) })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="sonarr">Sonarr</SelectItem>
                            <SelectItem value="radarr">Radarr</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Base URL</Label>
                        <Input
                          placeholder="http://sonarr:8989"
                          value={arr.baseUrl}
                          onChange={(e) =>
                            patch({ arrs: draft.arrs.map((a, j) => (j === i ? { ...a, baseUrl: e.target.value } : a)) })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">API key</Label>
                        <Input
                          className="font-mono"
                          value={arr.apiKey}
                          onChange={(e) =>
                            patch({ arrs: draft.arrs.map((a, j) => (j === i ? { ...a, apiKey: e.target.value } : a)) })
                          }
                        />
                      </div>
                      <div className="flex items-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${arr.name || 'instance'}`}
                          onClick={() => patch({ arrs: draft.arrs.filter((_, j) => j !== i) })}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => patch({ arrs: [...draft.arrs, { ...EMPTY_ARR }] })}>
                  <Plus />
                  Add instance
                </Button>
                <Button variant="outline" size="sm" onClick={loadArrHealth}>
                  Re-check now
                </Button>
              </div>
            </div>

            <NumberField
              id="reconcile-interval"
              label="Reconcile every (minutes)"
              hint="How often Warrden re-checks arr history in case a webhook was missed."
              value={numeric.reconcileIntervalMinutes}
              onChange={(v) => setNumeric({ ...numeric, reconcileIntervalMinutes: v })}
              invalid={parseNumber(numeric.reconcileIntervalMinutes) === undefined}
            />
          </CardContent>
        </Card>

        {/* History */}
        <Card id="history" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-2xl">History</CardTitle>
            <CardDescription>
              How long Warrden keeps its event log. Items that need your review are never trimmed — only the
              record of what already happened.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label>Keep events for</Label>
              <Select
                value={String(draft.eventRetentionDays)}
                onValueChange={(v) => v && patch({ eventRetentionDays: Number(v) })}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RETENTION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Older events are removed once a day. Keeping everything is fine on a small install, but the log
                grows for as long as Warrden runs.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Storage — four fixed mounts, never editable */}
        <Card id="storage" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-2xl">Storage mounts</CardTitle>
            <CardDescription>
              Warrden expects exactly four bind mounts. Set them when you create the container — this page only checks
              that they are reachable.
            </CardDescription>
            <CardAction>
              <MountHealth checks={storageChecks} />
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            {storageError && <StatusNotice message={storageError} onRetry={loadStorage} />}
            <div className="space-y-1">
              {STANDARD_MOUNT_ROWS.map((row) => {
                const check = storageChecks.find((c) => c.id === row.id);
                const status = check?.status;
                return (
                  <div key={row.id} className="flex flex-wrap items-center gap-3 border-t py-3">
                    <StatusDot tone={status ? storageStatusTone(status) : 'neutral'} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-medium">{row.label}</span>
                        <code className="text-xs text-muted-foreground">{check?.path ?? row.path}</code>
                      </div>
                      <p className="text-xs text-muted-foreground">{check?.detail ?? row.blurb}</p>
                    </div>
                    <div className="flex items-baseline gap-3">
                      {check?.usage && (
                        <span className="font-mono text-xs text-muted-foreground">{formatUsage(check.usage)}</span>
                      )}
                      <span
                        className={cn(
                          'text-xs font-medium',
                          status ? TONE_TEXT[storageStatusTone(status)] : 'text-muted-foreground',
                        )}
                      >
                        {status ? storageStatusLabel(status) : 'Checking…'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <Button variant="outline" size="sm" onClick={loadStorage}>
              Re-check now
            </Button>
          </CardContent>
        </Card>

        {/* Release picking */}
        <Card id="picking" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-2xl">Release picking</CardTitle>
            <CardDescription>
              Which torrent Warrden grabs when a series or movie is added. Both lists are written in plain language and
              handed to the picker as policy it weighs, not as hard filters.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Prefer</Label>
              <TagInput
                values={draft.picking.prefer}
                onChange={(prefer) => patch({ picking: { ...draft.picking, prefer } })}
                placeholder="e.g. 1080p remux — Enter to add"
              />
            </div>
            <div className="space-y-2">
              <Label>Avoid</Label>
              <TagInput
                values={draft.picking.avoid}
                onChange={(avoid) => patch({ picking: { ...draft.picking, avoid } })}
                placeholder="e.g. HEVC re-encodes — Enter to add"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField
                id="seeder-floor"
                label="Minimum seeders"
                hint="Drop releases below this"
                value={numeric.seederFloor}
                onChange={(v) => setNumeric({ ...numeric, seederFloor: v })}
                invalid={parseNumber(numeric.seederFloor) === undefined}
              />
              <NumberField
                id="min-size"
                label="Min size (MB)"
                value={numeric.minSizeMB}
                onChange={(v) => setNumeric({ ...numeric, minSizeMB: v })}
                invalid={parseNumber(numeric.minSizeMB) === undefined}
              />
              <NumberField
                id="max-size"
                label="Max size (MB)"
                value={numeric.maxSizeMB}
                onChange={(v) => setNumeric({ ...numeric, maxSizeMB: v })}
                invalid={parseNumber(numeric.maxSizeMB) === undefined}
              />
            </div>
          </CardContent>
        </Card>

        {/* Browser agent */}
        <Card id="browser" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-2xl">Browser agent</CardTitle>
            <CardDescription>Limits on the subtitle site browser so one bad site can't run forever.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                id="step-budget"
                label="Step budget"
                hint="Most AI steps allowed per site search"
                value={numeric.stepBudget}
                onChange={(v) => setNumeric({ ...numeric, stepBudget: v })}
                invalid={parseNumber(numeric.stepBudget) === undefined}
              />
              <NumberField
                id="site-cooldown"
                label="Site cooldown (seconds)"
                hint="Least time to wait before hitting the same site again"
                value={numeric.siteCooldownSeconds}
                onChange={(v) => setNumeric({ ...numeric, siteCooldownSeconds: v })}
                invalid={parseNumber(numeric.siteCooldownSeconds) === undefined}
              />
            </div>
          </CardContent>
        </Card>

        {/* AI model: provider, model id and that provider's key in one place */}
        <Card id="models" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-2xl">AI model</CardTitle>
            <CardDescription>
              The one model every AI task runs on: release picking, subtitle search, archive mapping, and the rest. A
              failing call is retried once before the task gives up.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Provider</Label>
                <Select value={model?.provider ?? ''} onValueChange={(v) => v && patchModel({ provider: v as Provider })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {model ? (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Model</Label>
                    <Input
                      value={model.model}
                      placeholder="e.g. sonnet"
                      onChange={(e) => patchModel({ model: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label className="text-xs" htmlFor="llm-key">
                      API key
                    </Label>
                    <Input
                      id="llm-key"
                      className="font-mono"
                      value={draft.llm.keys[model.provider] ?? ''}
                      onChange={(e) =>
                        patch({ llm: { ...draft.llm, keys: { ...draft.llm.keys, [model.provider]: e.target.value } } })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Stored per provider — switching provider keeps the other keys. Clear the field to delete the
                      stored key.
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <Button variant="ghost" size="sm" onClick={() => patch({ llm: { ...draft.llm, model: undefined } })}>
                      <Trash2 />
                      Clear the model
                    </Button>
                  </div>
                </>
              ) : (
                <p className="self-center text-sm text-muted-foreground">
                  No model configured. Every AI task stays off until one is set.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Debug */}
        <Card id="debug" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-2xl">Debug</CardTitle>
            <CardDescription>Full-fidelity tracing for troubleshooting, at the cost of performance and secrecy.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Switch
                id="debug-enabled"
                checked={draft.debug.enabled}
                onCheckedChange={(checked) => patch({ debug: { enabled: checked } })}
              />
              <Label htmlFor="debug-enabled">Debug mode</Label>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Records every processing step in full, including request bodies, LLM prompts and API keys. Adds a
              warning border while active. May impact performance.
            </p>
          </CardContent>
        </Card>
      </SectionStack>

      {/* One save bar for the whole page — the API writes config atomically, so
          per-section saves were both more clicks and a lie about the granularity. */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <ToneBadge tone="warning">Unsaved changes</ToneBadge>
            {saveError && <p className="text-sm text-destructive-foreground">{saveError}</p>}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" disabled={saving} onClick={() => loadFormState(baseline)}>
                Discard
              </Button>
              <Button disabled={saving} onClick={() => void handleSave()}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
