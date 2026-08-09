import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  ApiError,
  fetchConfig,
  fetchStorageHealth,
  saveConfig,
  SECRET_PLACEHOLDER,
  type ArrInstance,
  type ArrKind,
  type Config,
  type StorageCheck,
} from '@/api';
import { LlmProfileEditor } from '@/components/LlmProfileEditor';
import { NumberField } from '@/components/NumberField';
import { PageHeader } from '@/components/PageHeader';
import { StatusNotice } from '@/components/StatusNotice';
import { TagInput } from '@/components/TagInput';
import { StatusDot, ToneBadge } from '@/components/ToneBadge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { storageStatusLabel, storageStatusTone } from '@/lib/labels';
import { TONE_TEXT } from '@/lib/tone';
import { cn } from '@/lib/utils';

const EMPTY_ARR: ArrInstance = { name: '', kind: 'sonarr', baseUrl: '', apiKey: '' };

// base-ui renders the raw value in a select trigger unless the root gets a
// value→label map.
const ARR_KIND_ITEMS: Record<string, string> = { sonarr: 'Sonarr', radarr: 'Radarr' };

const LLM_PROVIDERS = ['openrouter', 'openai', 'anthropic'] as const;
type LlmProvider = (typeof LLM_PROVIDERS)[number];
const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** Mirrors server `standardMounts` — web has no shared package with the backend. */
const STANDARD_MOUNT_ROWS = [
  { id: 'series', label: 'Series', path: '/tv', blurb: 'Sonarr Series root folder' },
  { id: 'anime', label: 'Anime', path: '/anime', blurb: 'Sonarr Anime root folder' },
  { id: 'movies', label: 'Movies', path: '/movies', blurb: 'Radarr library root' },
  { id: 'downloads', label: 'Downloads', path: '/downloads', blurb: 'Torrent download / completed root' },
] as const;

const SECTIONS = [
  { id: 'connections', label: 'Connections' },
  { id: 'storage', label: 'Storage' },
  { id: 'picking', label: 'Release picking' },
  { id: 'browser', label: 'Browser agent' },
  { id: 'models', label: 'AI models' },
  { id: 'keys', label: 'API keys' },
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
  const [removeKeys, setRemoveKeys] = useState<Record<LlmProvider, boolean>>({
    openrouter: false,
    openai: false,
    anthropic: false,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [storageChecks, setStorageChecks] = useState<StorageCheck[]>([]);
  const [activeProfileTab, setActiveProfileTab] = useState('dev');

  const loadStorage = useCallback(() => {
    fetchStorageHealth()
      .then((res) => setStorageChecks(res.checks))
      .catch(() => setStorageChecks([]));
  }, []);

  const loadFormState = useCallback((c: Config) => {
    setBaseline(structuredClone(c));
    setDraft(structuredClone(c));
    setNumeric(numericFrom(c));
    setBaseNumeric(numericFrom(c));
    setRemoveKeys({ openrouter: false, openai: false, anthropic: false });
    setSaveError(null);
    setActiveProfileTab(c.llm.activeProfile);
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    fetchConfig()
      .then((c) => {
        loadFormState(c);
        loadStorage();
      })
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.message : 'Failed to load settings';
        setLoadError(message);
      });
  }, [loadFormState, loadStorage]);

  useEffect(load, [load]);

  // One dirty flag for the whole page. The API saves the config atomically anyway,
  // so per-section saves were both more clicks and a lie about the granularity.
  const dirty = useMemo(() => {
    if (!draft || !baseline || !numeric || !baseNumeric) return false;
    return (
      JSON.stringify(draft) !== JSON.stringify(baseline) ||
      JSON.stringify(numeric) !== JSON.stringify(baseNumeric) ||
      Object.values(removeKeys).some(Boolean)
    );
  }, [draft, baseline, numeric, baseNumeric, removeKeys]);

  function patch(next: Partial<Config>): void {
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
  }

  async function handleSave(): Promise<void> {
    if (!draft || !numeric || !baseline) return;

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

    // Deleting a key is an explicit act (the switch below), never a side effect of
    // emptying the box — so a cleared field on an already-stored key round-trips the
    // redaction sentinel and keeps what the server has.
    const keys: Config['llm']['keys'] = {};
    for (const provider of LLM_PROVIDERS) {
      if (removeKeys[provider]) continue;
      const typed = draft.llm.keys[provider];
      const stored = baseline.llm.keys[provider] !== undefined;
      if (typed !== undefined && typed !== '') keys[provider] = typed;
      else if (stored) keys[provider] = SECRET_PLACEHOLDER;
    }

    const payload: Config = {
      ...draft,
      // Mounts and path mappings are fixed outside the UI — never let a save rewrite them.
      ingest: baseline.ingest,
      pathMappings: baseline.pathMappings,
      server: { ...draft.server, publicUrl: draft.server.publicUrl.trim() },
      arrs: draft.arrs
        .map((a) => ({ ...a, name: a.name.trim(), baseUrl: a.baseUrl.trim() }))
        .filter((a) => a.name.length > 0 && a.baseUrl.length > 0),
      picking: {
        tags: draft.picking.tags,
        seederFloor: parsed.seederFloor!,
        minSizeMB: parsed.minSizeMB!,
        maxSizeMB: parsed.maxSizeMB!,
      },
      browser: { stepBudget: parsed.stepBudget!, siteCooldownSeconds: parsed.siteCooldownSeconds! },
      llm: { ...draft.llm, keys },
      reconcileIntervalMinutes: parsed.reconcileIntervalMinutes!,
    };

    setSaving(true);
    setSaveError(null);
    try {
      const result = await saveConfig(payload);
      toast.success(result.restartRequired ? 'Saved — restart the container to apply fully' : 'Settings saved');
      loadFormState(await fetchConfig());
      loadStorage();
    } catch (err) {
      if (err instanceof ApiError) {
        const issueText = err.issues?.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        setSaveError(issueText ? `${err.message} — ${issueText}` : err.message);
        toast.error(err.message);
      } else {
        setSaveError('Failed to save');
        toast.error('Failed to save');
      }
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

  const badMounts = storageChecks.filter((c) => c.status !== 'ok').length;

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title="Settings"
        description="Connect Sonarr and Radarr, tune how releases are picked, and choose which model handles each task. Subtitle languages and sites live under Subtitle sources."
      />

      <div className="flex gap-8">
        {/* In-page nav: the page is long and every section is independently interesting. */}
        <nav className="sticky top-20 hidden h-fit w-40 shrink-0 space-y-1 lg:block">
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="block rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-6">
          {/* Connections */}
          <Card id="connections" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>Connections</CardTitle>
              <CardDescription>
                The Sonarr and Radarr instances Warrden talks to. Public URL is the address those apps use to reach this
                container for webhooks.
              </CardDescription>
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
                {draft.arrs.map((arr, i) => (
                  <div key={i} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[1fr_9rem_1.5fr_1.5fr_auto]">
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
                        items={ARR_KIND_ITEMS}
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
                        type="password"
                        autoComplete="new-password"
                        value={arr.apiKey}
                        onChange={(e) =>
                          patch({ arrs: draft.arrs.map((a, j) => (j === i ? { ...a, apiKey: e.target.value } : a)) })
                        }
                      />
                      <p className="text-xs text-muted-foreground">Leave as {SECRET_PLACEHOLDER} to keep the stored key</p>
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
                ))}
                <Button variant="outline" size="sm" onClick={() => patch({ arrs: [...draft.arrs, { ...EMPTY_ARR }] })}>
                  <Plus />
                  Add instance
                </Button>
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

          {/* Storage — four fixed mounts, never editable */}
          <Card id="storage" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>Storage mounts</CardTitle>
              <CardDescription>
                Warrden expects exactly four bind mounts. Set them when you create the container — this page only checks
                that they are reachable.
              </CardDescription>
              <CardAction>
                <ToneBadge tone={badMounts > 0 ? 'danger' : 'success'}>
                  {badMounts > 0 ? `${badMounts} unreachable` : 'All reachable'}
                </ToneBadge>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                {STANDARD_MOUNT_ROWS.map((row) => {
                  const check = storageChecks.find((c) => c.id === row.id);
                  const status = check?.status ?? 'missing';
                  return (
                    <div key={row.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                      <StatusDot tone={storageStatusTone(status)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="text-sm font-medium">{row.label}</span>
                          <code className="text-xs text-muted-foreground">{check?.path ?? row.path}</code>
                        </div>
                        <p className="text-xs text-muted-foreground">{check?.detail ?? row.blurb}</p>
                      </div>
                      <span className={cn('text-xs font-medium', TONE_TEXT[storageStatusTone(status)])}>
                        {storageStatusLabel(status)}
                      </span>
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
              <CardTitle>Release picking</CardTitle>
              <CardDescription>
                Which torrent Warrden grabs when a series or movie is added. Preferences are written in plain language
                and handed to the picker as policy — they are not hard filters.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Preferences</Label>
                <TagInput
                  values={draft.picking.tags}
                  onChange={(tags) => patch({ picking: { ...draft.picking, tags } })}
                  placeholder="e.g. prefer 1080p — Enter to add"
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
              <CardTitle>Browser agent</CardTitle>
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

          {/* AI models */}
          <Card id="models" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>AI models</CardTitle>
              <CardDescription>
                Which model handles each task. Profiles let you keep a cheap development setup beside the one you
                actually run.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Active profile</Label>
                <Select
                  value={draft.llm.activeProfile}
                  onValueChange={(v) => v && patch({ llm: { ...draft.llm, activeProfile: v as 'dev' | 'prod' } })}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dev">dev</SelectItem>
                    <SelectItem value="prod">prod</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The profile Warrden runs with. You can edit either profile below without switching to it.
                </p>
              </div>

              <div className="space-y-3">
                <Tabs value={activeProfileTab} onValueChange={(v) => setActiveProfileTab(v ?? 'dev')}>
                  <TabsList>
                    <TabsTrigger value="dev">
                      dev{draft.llm.activeProfile === 'dev' && <span className="ml-1.5 text-xs">· active</span>}
                    </TabsTrigger>
                    <TabsTrigger value="prod">
                      prod{draft.llm.activeProfile === 'prod' && <span className="ml-1.5 text-xs">· active</span>}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <LlmProfileEditor
                  profile={activeProfileTab}
                  profiles={draft.llm.profiles}
                  onChange={(profiles) => patch({ llm: { ...draft.llm, profiles } })}
                />
              </div>
            </CardContent>
          </Card>

          {/* API keys */}
          <Card id="keys" className="scroll-mt-20">
            <CardHeader>
              <CardTitle>API keys</CardTitle>
              <CardDescription>
                Left as {SECRET_PLACEHOLDER}, a stored key is kept as-is. The Claude Code provider uses subscription auth
                and needs no key.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              {LLM_PROVIDERS.map((provider) => {
                const stored = baseline.llm.keys[provider] !== undefined;
                return (
                  <div key={provider} className="space-y-2">
                    <Label htmlFor={`key-${provider}`}>{LLM_PROVIDER_LABELS[provider]}</Label>
                    <Input
                      id={`key-${provider}`}
                      type="password"
                      autoComplete="new-password"
                      disabled={removeKeys[provider]}
                      value={draft.llm.keys[provider] ?? ''}
                      onChange={(e) =>
                        patch({ llm: { ...draft.llm, keys: { ...draft.llm.keys, [provider]: e.target.value } } })
                      }
                    />
                    {stored && (
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`remove-${provider}`}
                          checked={removeKeys[provider]}
                          onCheckedChange={(checked) => setRemoveKeys((prev) => ({ ...prev, [provider]: checked }))}
                        />
                        <Label htmlFor={`remove-${provider}`} className="text-xs font-normal text-muted-foreground">
                          Delete stored key on save
                        </Label>
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>

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
