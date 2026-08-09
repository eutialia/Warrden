import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ApiError,
  CALLSITES,
  fetchConfig,
  fetchStorageHealth,
  saveConfig,
  SECRET_PLACEHOLDER,
  type ArrInstance,
  type ArrKind,
  type Config,
  type StorageCheck,
  type SubtitleSite,
} from '@/api';
import { PageHeader } from '@/components/PageHeader';
import { TagInput } from '@/components/TagInput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const EMPTY_ARR: ArrInstance = { name: '', kind: 'sonarr', baseUrl: '', apiKey: '' };
const EMPTY_SUBTITLE_SITE: SubtitleSite = { name: '', baseUrl: '' };

const LLM_PROVIDERS = ['openrouter', 'openai', 'anthropic'] as const;
type LlmProvider = (typeof LLM_PROVIDERS)[number];
const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

interface LlmKeyFieldState {
  text: string;
  wasSet: boolean;
  remove: boolean;
}
const EMPTY_KEY_FIELD: LlmKeyFieldState = { text: '', wasSet: false, remove: false };

type SectionId = 'connections' | 'picking' | 'subtitles' | 'browser' | 'llm' | 'keys';

/** Mirrors server `standardMounts` — web has no shared package with the backend. */
const STANDARD_MOUNT_ROWS = [
  { id: 'series', label: 'Series', path: '/tv', blurb: 'Sonarr Series root folder' },
  { id: 'anime', label: 'Anime', path: '/anime', blurb: 'Sonarr Anime root folder' },
  { id: 'movies', label: 'Movies', path: '/movies', blurb: 'Radarr library root' },
  { id: 'downloads', label: 'Downloads', path: '/downloads', blurb: 'Torrent download / completed root' },
] as const;

function SectionFooter({
  dirty,
  saving,
  onSave,
  onDiscard,
  error,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  error?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-4">
      <Button onClick={onSave} disabled={!dirty || saving}>
        {saving ? 'Saving…' : 'Save section'}
      </Button>
      <Button variant="ghost" onClick={onDiscard} disabled={!dirty || saving}>
        Discard
      </Button>
      {dirty && (
        <Badge variant="outline" className="bg-amber-50 text-amber-950 border-amber-200">
          Unsaved changes
        </Badge>
      )}
      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </div>
  );
}

function storageStatusClass(status: StorageCheck['status']): string {
  switch (status) {
    case 'ok':
      return 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-100';
    case 'missing':
    case 'not-mounted':
      return 'bg-red-100 text-red-900 border-red-200 dark:bg-red-950 dark:text-red-100';
    default:
      return 'bg-amber-100 text-amber-950 border-amber-200 dark:bg-amber-950 dark:text-amber-100';
  }
}

function storageStatusLabel(status: StorageCheck['status']): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'missing':
      return 'Missing';
    case 'not-mounted':
      return 'Not mounted';
    case 'unreadable':
      return 'Not readable';
    case 'unwritable':
      return 'Not writable';
    default:
      return status;
  }
}

export default function ConfigPage() {
  const [baseline, setBaseline] = useState<Config | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [storageChecks, setStorageChecks] = useState<StorageCheck[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);

  const [seederFloorText, setSeederFloorText] = useState('');
  const [minSizeMBText, setMinSizeMBText] = useState('');
  const [maxSizeMBText, setMaxSizeMBText] = useState('');
  const [profilesText, setProfilesText] = useState('');
  const [stepBudgetText, setStepBudgetText] = useState('');
  const [siteCooldownText, setSiteCooldownText] = useState('');
  const [llmKeyFields, setLlmKeyFields] = useState<Record<LlmProvider, LlmKeyFieldState>>({
    openrouter: EMPTY_KEY_FIELD,
    openai: EMPTY_KEY_FIELD,
    anthropic: EMPTY_KEY_FIELD,
  });

  const [savingSection, setSavingSection] = useState<SectionId | null>(null);
  const [sectionError, setSectionError] = useState<Partial<Record<SectionId, string>>>({});

  function loadFormState(c: Config): void {
    setBaseline(structuredClone(c));
    setConfig(structuredClone(c));
    setSeederFloorText(String(c.picking.seederFloor));
    setMinSizeMBText(String(c.picking.minSizeMB));
    setMaxSizeMBText(String(c.picking.maxSizeMB));
    setProfilesText(JSON.stringify(c.llm.profiles, null, 2));
    setStepBudgetText(String(c.browser.stepBudget));
    setSiteCooldownText(String(c.browser.siteCooldownSeconds));
    setLlmKeyFields({
      openrouter: { text: c.llm.keys.openrouter ?? '', wasSet: c.llm.keys.openrouter !== undefined, remove: false },
      openai: { text: c.llm.keys.openai ?? '', wasSet: c.llm.keys.openai !== undefined, remove: false },
      anthropic: { text: c.llm.keys.anthropic ?? '', wasSet: c.llm.keys.anthropic !== undefined, remove: false },
    });
    setSectionError({});
  }

  const loadStorage = useCallback(() => {
    setStorageError(null);
    fetchStorageHealth()
      .then((res) => setStorageChecks(res.checks))
      .catch((err: unknown) => {
        setStorageError(err instanceof ApiError ? err.message : 'Failed to check storage');
      });
  }, []);

  function loadConfigFromServer(): void {
    setLoadError(null);
    fetchConfig()
      .then((c) => {
        loadFormState(c);
        loadStorage();
      })
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.message : 'Failed to load settings';
        setLoadError(message);
        toast.error(message);
      });
  }

  useEffect(loadConfigFromServer, [loadStorage]);

  function updateLlmKeyField(provider: LlmProvider, patch: Partial<LlmKeyFieldState>): void {
    setLlmKeyFields((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }));
  }

  function buildLlmKeys(): Config['llm']['keys'] {
    const keys: Config['llm']['keys'] = {};
    for (const provider of LLM_PROVIDERS) {
      const field = llmKeyFields[provider];
      if (field.remove) continue;
      if (field.text !== '') {
        keys[provider] = field.text;
      } else if (field.wasSet) {
        keys[provider] = SECRET_PLACEHOLDER;
      }
    }
    return keys;
  }

  function parseNumber(text: string): number | undefined {
    const trimmed = text.trim();
    const value = Number(trimmed);
    return trimmed === '' || Number.isNaN(value) ? undefined : value;
  }

  async function persist(section: SectionId, next: Config): Promise<void> {
    if (!baseline) return;
    // Mounts are fixed outside the UI — never let a section save rewrite them.
    const payload: Config = { ...next, ingest: baseline.ingest, pathMappings: baseline.pathMappings };
    setSavingSection(section);
    setSectionError((prev) => ({ ...prev, [section]: undefined }));
    try {
      const result = await saveConfig(payload);
      toast.success(result.restartRequired ? 'Saved — restart the container to apply fully' : 'Saved');
      const fresh = await fetchConfig();
      loadFormState(fresh);
      if (section === 'connections') loadStorage();
    } catch (err) {
      if (err instanceof ApiError) {
        const issueText = err.issues?.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        const message = issueText ? `${err.message} — ${issueText}` : err.message;
        setSectionError((prev) => ({ ...prev, [section]: message }));
        toast.error(err.message);
      } else {
        setSectionError((prev) => ({ ...prev, [section]: 'Failed to save' }));
        toast.error('Failed to save');
      }
    } finally {
      setSavingSection(null);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-2">
        <PageHeader title="Settings" description="Connections and preferences for Warrden." />
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" onClick={loadConfigFromServer}>
          Retry
        </Button>
      </div>
    );
  }

  if (!config || !baseline) {
    return <p className="text-muted-foreground">Loading…</p>;
  }

  // --- dirty helpers (section-local) ---
  const connectionsDirty =
    JSON.stringify(config.arrs) !== JSON.stringify(baseline.arrs) ||
    config.server.publicUrl !== baseline.server.publicUrl ||
    config.server.port !== baseline.server.port;

  const pickingDirty =
    JSON.stringify(config.picking.tags) !== JSON.stringify(baseline.picking.tags) ||
    seederFloorText !== String(baseline.picking.seederFloor) ||
    minSizeMBText !== String(baseline.picking.minSizeMB) ||
    maxSizeMBText !== String(baseline.picking.maxSizeMB);

  const subtitlesDirty =
    JSON.stringify(config.subtitle.languages) !== JSON.stringify(baseline.subtitle.languages) ||
    JSON.stringify(config.subtitle.preferredGroups ?? []) !== JSON.stringify(baseline.subtitle.preferredGroups ?? []) ||
    JSON.stringify(config.subtitle.sites) !== JSON.stringify(baseline.subtitle.sites);

  const browserDirty =
    stepBudgetText !== String(baseline.browser.stepBudget) ||
    siteCooldownText !== String(baseline.browser.siteCooldownSeconds);

  const llmDirty =
    config.llm.activeProfile !== baseline.llm.activeProfile ||
    profilesText !== JSON.stringify(baseline.llm.profiles, null, 2);

  const keysDirty = LLM_PROVIDERS.some((p) => {
    const field = llmKeyFields[p];
    const base = baseline.llm.keys[p] ?? '';
    if (field.remove) return true;
    if (field.text === SECRET_PLACEHOLDER || field.text === base) return false;
    if (field.text === '' && !field.wasSet) return false;
    return field.text !== base;
  });

  function updateArr(index: number, patch: Partial<ArrInstance>): void {
    setConfig((prev) => (prev ? { ...prev, arrs: prev.arrs.map((a, i) => (i === index ? { ...a, ...patch } : a)) } : prev));
  }

  function updateSubtitleSite(index: number, patch: Partial<SubtitleSite>): void {
    setConfig((prev) =>
      prev
        ? { ...prev, subtitle: { ...prev.subtitle, sites: prev.subtitle.sites.map((s, i) => (i === index ? { ...s, ...patch } : s)) } }
        : prev,
    );
  }

  async function saveConnections(): Promise<void> {
    if (!config) return;
    await persist( 'connections', {
      ...config,
      arrs: config.arrs
        .map((a) => ({ ...a, name: a.name.trim(), baseUrl: a.baseUrl.trim() }))
        .filter((a) => a.name.length > 0 && a.baseUrl.length > 0),
      server: { ...config.server, publicUrl: config.server.publicUrl.trim() },
    });
  }

  async function savePicking(): Promise<void> {
    if (!config) return;
    const seederFloor = parseNumber(seederFloorText);
    const minSizeMB = parseNumber(minSizeMBText);
    const maxSizeMB = parseNumber(maxSizeMBText);
    if (seederFloor === undefined || minSizeMB === undefined || maxSizeMB === undefined) {
      setSectionError((prev) => ({ ...prev, picking: 'Seeder floor and size limits must be numbers' }));
      toast.error('Picking fields must be numbers');
      return;
    }
    await persist('picking', {
      ...config,
      picking: { tags: config.picking.tags, seederFloor, minSizeMB, maxSizeMB },
    });
  }

  async function saveSubtitles(): Promise<void> {
    if (!config) return;
    const sites: SubtitleSite[] = config.subtitle.sites
      .map((s) => ({
        name: s.name.trim(),
        baseUrl: s.baseUrl.trim(),
        searchUrlTemplate: s.searchUrlTemplate?.trim() || undefined,
      }))
      .filter((s) => s.name.length > 0 && s.baseUrl.length > 0);
    await persist('subtitles', {
      ...config,
      subtitle: {
        languages: config.subtitle.languages,
        preferredGroups: config.subtitle.preferredGroups ?? [],
        sites,
      },
    });
  }

  async function saveBrowser(): Promise<void> {
    if (!config) return;
    const stepBudget = parseNumber(stepBudgetText);
    const siteCooldownSeconds = parseNumber(siteCooldownText);
    if (stepBudget === undefined || siteCooldownSeconds === undefined) {
      setSectionError((prev) => ({ ...prev, browser: 'Step budget and cooldown must be numbers' }));
      toast.error('Browser fields must be numbers');
      return;
    }
    await persist('browser', {
      ...config,
      browser: { stepBudget, siteCooldownSeconds },
    });
  }

  async function saveLlm(): Promise<void> {
    if (!config) return;
    let profiles: Config['llm']['profiles'];
    try {
      profiles = JSON.parse(profilesText) as Config['llm']['profiles'];
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid JSON';
      setSectionError((prev) => ({ ...prev, llm: `Profiles JSON: ${message}` }));
      toast.error('LLM profiles is not valid JSON');
      return;
    }
    await persist('llm', {
      ...config,
      llm: { ...config.llm, profiles, keys: buildLlmKeys() },
    });
  }

  async function saveKeys(): Promise<void> {
    if (!config) return;
    await persist('keys', {
      ...config,
      llm: { ...config.llm, keys: buildLlmKeys() },
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Connect Sonarr/Radarr, set release and subtitle preferences, and check storage access. Each section saves on its own — nothing is applied until you click Save."
      />

      {/* Connections */}
      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>
            Sonarr and Radarr instances Warrden talks to. Public URL is the address those apps use to reach this
            container for webhooks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Public URL</label>
            <Input
              value={config.server.publicUrl}
              onChange={(e) => setConfig({ ...config, server: { ...config.server, publicUrl: e.target.value } })}
              placeholder="http://warrden.example:9797"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Must be reachable from Sonarr/Radarr. Changing it later requires deleting the “Warrden” webhook in the arr
              so it can re-register.
            </p>
          </div>
          <div className="space-y-3">
            {config.arrs.map((arr, i) => (
              <div key={i} className="grid gap-2 rounded-lg border p-3 md:grid-cols-[1fr_120px_1.5fr_1.5fr_auto]">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Name</label>
                  <Input placeholder="sonarr" value={arr.name} onChange={(e) => updateArr(i, { name: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Type</label>
                  <select
                    className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    value={arr.kind}
                    onChange={(e) => updateArr(i, { kind: e.target.value as ArrKind })}
                  >
                    <option value="sonarr">Sonarr</option>
                    <option value="radarr">Radarr</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Base URL</label>
                  <Input
                    placeholder="http://sonarr:8989"
                    value={arr.baseUrl}
                    onChange={(e) => updateArr(i, { baseUrl: e.target.value })}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">API key</label>
                  <Input
                    type="password"
                    placeholder="API key"
                    autoComplete="new-password"
                    value={arr.apiKey}
                    onChange={(e) => updateArr(i, { apiKey: e.target.value })}
                  />
                  <p className="mt-1 text-[0.7rem] text-muted-foreground">Leave as {SECRET_PLACEHOLDER} to keep stored key</p>
                </div>
                <div className="flex items-end">
                  <Button variant="ghost" size="sm" onClick={() => setConfig({ ...config, arrs: config.arrs.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setConfig({ ...config, arrs: [...config.arrs, { ...EMPTY_ARR }] })}>
              Add instance
            </Button>
          </div>
          <SectionFooter
            dirty={connectionsDirty}
            saving={savingSection === 'connections'}
            onSave={() => void saveConnections()}
            onDiscard={() => loadFormState(baseline)}
            error={sectionError.connections}
          />
        </CardContent>
      </Card>

      {/* Storage — three fixed mounts, never editable */}
      <Card>
        <CardHeader>
          <CardTitle>Storage mounts</CardTitle>
          <CardDescription>
            Warrden always expects exactly four bind mounts (Series, Anime, Movies, Downloads). Set them when you create
            the container — this page only checks that they are reachable. Not editable here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Container path</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {STANDARD_MOUNT_ROWS.map((row) => {
                  const check = storageChecks.find((c) => c.id === row.id);
                  const status = check?.status ?? 'missing';
                  const detail = check?.detail ?? (storageError ?? 'Waiting for health check…');
                  const path = check?.path ?? row.path;
                  return (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="px-3 py-3">
                        <div className="font-medium">{row.label}</div>
                        <div className="text-xs text-muted-foreground">{row.blurb}</div>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs">{path}</td>
                      <td className="px-3 py-3">
                        <Badge variant="outline" className={cn('font-medium', storageStatusClass(status))}>
                          {storageStatusLabel(status)}
                        </Badge>
                        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{detail}</p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {storageError && <p className="text-sm text-destructive">{storageError}</p>}
          <p className="text-xs text-muted-foreground">
            Example:{' '}
            <code className="rounded bg-muted px-1 py-0.5">
              -v …/Series:/tv -v …/Anime:/anime -v …/Movies:/movies -v …/Downloads:/downloads
            </code>
            . If Sonarr/Radarr use different paths than Warrden, set <code className="rounded bg-muted px-1">pathMappings</code>{' '}
            in <code className="rounded bg-muted px-1">config.json</code> (not here).
          </p>
          <Button variant="outline" size="sm" onClick={loadStorage}>
            Re-check
          </Button>
        </CardContent>
      </Card>

      {/* Picking */}
      <Card>
        <CardHeader>
          <CardTitle>Release picking</CardTitle>
          <CardDescription>
            Rules for which torrent Warrden will grab when a series or movie is added. Tags are soft preferences the
            picker prefers to see in release titles.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Preferred tags</label>
            <TagInput
              values={config.picking.tags}
              onChange={(tags) => setConfig({ ...config, picking: { ...config.picking, tags } })}
              placeholder="e.g. 1080p — Enter to add"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Minimum seeders</label>
              <Input type="number" value={seederFloorText} onChange={(e) => setSeederFloorText(e.target.value)} />
              <p className="mt-1 text-xs text-muted-foreground">Drop releases with fewer seeders than this</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Min size (MB)</label>
              <Input type="number" value={minSizeMBText} onChange={(e) => setMinSizeMBText(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Max size (MB)</label>
              <Input type="number" value={maxSizeMBText} onChange={(e) => setMaxSizeMBText(e.target.value)} />
            </div>
          </div>
          <SectionFooter
            dirty={pickingDirty}
            saving={savingSection === 'picking'}
            onSave={() => void savePicking()}
            onDiscard={() => loadFormState(baseline)}
            error={sectionError.picking}
          />
        </CardContent>
      </Card>

      {/* Subtitles */}
      <Card>
        <CardHeader>
          <CardTitle>Subtitles</CardTitle>
          <CardDescription>
            Languages a video must have before it counts as “has subtitles,” soft fansub preferences, and which public
            sites to search. Site health lives under Subtitle sources.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Languages</label>
            <TagInput
              values={config.subtitle.languages}
              onChange={(languages) => setConfig({ ...config, subtitle: { ...config.subtitle, languages } })}
              placeholder="e.g. en, zh"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Preferred fansub groups (soft)</label>
            <TagInput
              values={config.subtitle.preferredGroups ?? []}
              onChange={(preferredGroups) => setConfig({ ...config, subtitle: { ...config.subtitle, preferredGroups } })}
              placeholder="e.g. Airota"
            />
            <p className="mt-1 text-xs text-muted-foreground">Boosts ranking only — search continues if none match</p>
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium">Sites</label>
            <div className="space-y-2">
              {config.subtitle.sites.map((site, i) => (
                <div key={i} className="grid gap-2 rounded-lg border p-3 md:grid-cols-[1fr_1.5fr_1.5fr_auto]">
                  <Input placeholder="Name" value={site.name} onChange={(e) => updateSubtitleSite(i, { name: e.target.value })} />
                  <Input
                    placeholder="Base URL"
                    value={site.baseUrl}
                    onChange={(e) => updateSubtitleSite(i, { baseUrl: e.target.value })}
                  />
                  <Input
                    placeholder="Search URL template (optional, use {query})"
                    value={site.searchUrlTemplate ?? ''}
                    onChange={(e) => updateSubtitleSite(i, { searchUrlTemplate: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setConfig({
                        ...config,
                        subtitle: { ...config.subtitle, sites: config.subtitle.sites.filter((_, j) => j !== i) },
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() =>
                setConfig({
                  ...config,
                  subtitle: { ...config.subtitle, sites: [...config.subtitle.sites, { ...EMPTY_SUBTITLE_SITE }] },
                })
              }
            >
              Add site
            </Button>
          </div>
          <SectionFooter
            dirty={subtitlesDirty}
            saving={savingSection === 'subtitles'}
            onSave={() => void saveSubtitles()}
            onDiscard={() => loadFormState(baseline)}
            error={sectionError.subtitles}
          />
        </CardContent>
      </Card>

      {/* Browser agent */}
      <Card>
        <CardHeader>
          <CardTitle>Browser agent</CardTitle>
          <CardDescription>Limits for the subtitle site browser so a bad site can’t run forever.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium">Step budget</label>
              <Input type="number" value={stepBudgetText} onChange={(e) => setStepBudgetText(e.target.value)} />
              <p className="mt-1 text-xs text-muted-foreground">Max AI steps per site search</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Site cooldown (seconds)</label>
              <Input type="number" value={siteCooldownText} onChange={(e) => setSiteCooldownText(e.target.value)} />
              <p className="mt-1 text-xs text-muted-foreground">Minimum wait before hitting the same site again</p>
            </div>
          </div>
          <SectionFooter
            dirty={browserDirty}
            saving={savingSection === 'browser'}
            onSave={() => void saveBrowser()}
            onDiscard={() => loadFormState(baseline)}
            error={sectionError.browser}
          />
        </CardContent>
      </Card>

      {/* LLM */}
      <Card>
        <CardHeader>
          <CardTitle>AI models</CardTitle>
          <CardDescription>
            Which model handles each task. Call-sites: {CALLSITES.join(', ')}. Advanced routing stays as JSON this
            release — each profile maps call-sites to provider/model pairs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Active profile</label>
            <div className="flex gap-2">
              {(['dev', 'prod'] as const).map((profile) => (
                <Button
                  key={profile}
                  variant={config.llm.activeProfile === profile ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setConfig({ ...config, llm: { ...config.llm, activeProfile: profile } })}
                >
                  {profile}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Profiles (JSON)</label>
            <Textarea
              rows={12}
              className="font-mono text-xs"
              value={profilesText}
              onChange={(e) => setProfilesText(e.target.value)}
            />
          </div>
          <SectionFooter
            dirty={llmDirty}
            saving={savingSection === 'llm'}
            onSave={() => void saveLlm()}
            onDiscard={() => loadFormState(baseline)}
            error={sectionError.llm}
          />
        </CardContent>
      </Card>

      {/* API keys */}
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Leave a key as {SECRET_PLACEHOLDER} (or blank if it was already set) to keep it. Check Remove to delete a
            stored key. Not needed for the Claude Code provider (subscription auth).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {LLM_PROVIDERS.map((provider) => {
              const field = llmKeyFields[provider];
              return (
                <div key={provider}>
                  <label className="mb-1 block text-sm font-medium">{LLM_PROVIDER_LABELS[provider]}</label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    disabled={field.remove}
                    value={field.text}
                    onChange={(e) => updateLlmKeyField(provider, { text: e.target.value })}
                  />
                  {field.wasSet && (
                    <label className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={field.remove}
                        onChange={(e) => updateLlmKeyField(provider, { remove: e.target.checked })}
                      />
                      Remove stored key
                    </label>
                  )}
                </div>
              );
            })}
          </div>
          <SectionFooter
            dirty={keysDirty}
            saving={savingSection === 'keys'}
            onSave={() => void saveKeys()}
            onDiscard={() => loadFormState(baseline)}
            error={sectionError.keys}
          />
        </CardContent>
      </Card>
    </div>
  );
}
