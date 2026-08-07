import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, CALLSITES, fetchConfig, saveConfig, SECRET_PLACEHOLDER, type ArrInstance, type ArrKind, type Config } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const EMPTY_ARR: ArrInstance = { name: '', kind: 'sonarr', baseUrl: '', apiKey: '' };

const LLM_PROVIDERS = ['openrouter', 'openai', 'anthropic'] as const;
type LlmProvider = (typeof LLM_PROVIDERS)[number];
const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = { openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic' };

/** One provider key field's editing state: `text` is what's shown (the sentinel, a typed
 * value, or blank), `wasSet` records whether the key was actually configured when the page
 * loaded (so a blank field can tell "never set" apart from "cleared"), and `remove` is the
 * explicit "delete this key" checkbox — the only path that actually unsets a previously-set
 * key (see `buildLlmKeys`). */
interface LlmKeyFieldState {
  text: string;
  wasSet: boolean;
  remove: boolean;
}
const EMPTY_KEY_FIELD: LlmKeyFieldState = { text: '', wasSet: false, remove: false };

/** Add/remove editor for a flat string list (`ingest.mountMarkers`, `ingest.downloadRoots`)
 * — pulled out since both fields need the identical add/edit/remove shape, just with
 * different labels and helper text. */
function StringListField({
  label,
  helperText,
  values,
  onChange,
}: {
  label: string;
  helperText: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      <p className="mb-2 text-xs text-muted-foreground">{helperText}</p>
      <div className="space-y-2">
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={v} onChange={(e) => onChange(values.map((existing, idx) => (idx === i ? e.target.value : existing)))} />
            <Button variant="ghost" size="sm" onClick={() => onChange(values.filter((_, idx) => idx !== i))}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => onChange([...values, ''])}>
        Add
      </Button>
    </div>
  );
}

export default function ConfigPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tagsText, setTagsText] = useState('');
  // Kept as free-form text (not the parsed numbers) so an in-progress edit — including a
  // momentarily empty field while the user retypes it — never gets coerced to 0 and saved.
  // Parsed and validated only in handleSave.
  const [seederFloorText, setSeederFloorText] = useState('');
  const [minSizeMBText, setMinSizeMBText] = useState('');
  const [maxSizeMBText, setMaxSizeMBText] = useState('');
  const [pickingError, setPickingError] = useState<string | null>(null);
  const [profilesText, setProfilesText] = useState('');
  const [profilesError, setProfilesError] = useState<string | null>(null);
  // One editing state per provider key, not bound directly to `config.llm.keys` — see
  // `LlmKeyFieldState` above for what each field tracks and why.
  const [llmKeyFields, setLlmKeyFields] = useState<Record<LlmProvider, LlmKeyFieldState>>({
    openrouter: EMPTY_KEY_FIELD,
    openai: EMPTY_KEY_FIELD,
    anthropic: EMPTY_KEY_FIELD,
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function loadFormState(c: Config): void {
    setConfig(c);
    setTagsText(c.picking.tags.join('\n'));
    setSeederFloorText(String(c.picking.seederFloor));
    setMinSizeMBText(String(c.picking.minSizeMB));
    setMaxSizeMBText(String(c.picking.maxSizeMB));
    setProfilesText(JSON.stringify(c.llm.profiles, null, 2));
    setLlmKeyFields({
      openrouter: { text: c.llm.keys.openrouter ?? '', wasSet: c.llm.keys.openrouter !== undefined, remove: false },
      openai: { text: c.llm.keys.openai ?? '', wasSet: c.llm.keys.openai !== undefined, remove: false },
      anthropic: { text: c.llm.keys.anthropic ?? '', wasSet: c.llm.keys.anthropic !== undefined, remove: false },
    });
  }

  function updateLlmKeyField(provider: LlmProvider, patch: Partial<LlmKeyFieldState>): void {
    setLlmKeyFields((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }));
  }

  /**
   * Builds the `llm.keys` object to send on save. Per key, in priority order:
   *  1. "Remove" checked — omitted entirely. This is the *only* path that actually
   *     deletes a previously-set key.
   *  2. A non-blank value (a freshly typed secret, or the sentinel round-tripped
   *     unchanged) — sent as-is; the server resolves the sentinel back to the stored
   *     secret, a real value rotates it.
   *  3. Blank, but the key was set when the page loaded — re-sent as the sentinel, so
   *     clearing the field back to empty is a no-op rather than a silent delete (the
   *     bug this whole scheme fixes: clearing used to erase the stored secret).
   *  4. Blank and never set — omitted; still unset either way.
   */
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

  function loadConfigFromServer(): void {
    setLoadError(null);
    fetchConfig()
      .then(loadFormState)
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.message : 'failed to load config';
        setLoadError(message);
        toast.error(message);
      });
  }

  useEffect(loadConfigFromServer, []);

  if (loadError) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" onClick={loadConfigFromServer}>
          Retry
        </Button>
      </div>
    );
  }

  if (!config) {
    return <p className="text-muted-foreground">Loading…</p>;
  }

  function updateArr(index: number, patch: Partial<ArrInstance>): void {
    setConfig((prev) => (prev ? { ...prev, arrs: prev.arrs.map((a, i) => (i === index ? { ...a, ...patch } : a)) } : prev));
  }

  function addArr(): void {
    setConfig((prev) => (prev ? { ...prev, arrs: [...prev.arrs, { ...EMPTY_ARR }] } : prev));
  }

  function removeArr(index: number): void {
    setConfig((prev) => (prev ? { ...prev, arrs: prev.arrs.filter((_, i) => i !== index) } : prev));
  }

  function updatePathMapping(index: number, patch: Partial<Config['pathMappings'][number]>): void {
    setConfig((prev) =>
      prev ? { ...prev, pathMappings: prev.pathMappings.map((m, i) => (i === index ? { ...m, ...patch } : m)) } : prev,
    );
  }

  function addPathMapping(): void {
    setConfig((prev) => (prev ? { ...prev, pathMappings: [...prev.pathMappings, { from: '', to: '' }] } : prev));
  }

  function removePathMapping(index: number): void {
    setConfig((prev) => (prev ? { ...prev, pathMappings: prev.pathMappings.filter((_, i) => i !== index) } : prev));
  }

  function updateIngest(patch: Partial<Config['ingest']>): void {
    setConfig((prev) => (prev ? { ...prev, ingest: { ...prev.ingest, ...patch } } : prev));
  }

  /** Parses one of the picking number fields, rejecting blank/non-numeric text outright —
   * `Number('')` is `0`, so without this a field the user cleared mid-edit would silently
   * save as zero instead of blocking the save like the LLM-profiles JSON check does. Has
   * no side effect so the caller can collect every failing field's message rather than
   * only the last one checked. */
  function parsePickingNumber(text: string): number | undefined {
    const trimmed = text.trim();
    const value = Number(trimmed);
    return trimmed === '' || Number.isNaN(value) ? undefined : value;
  }

  async function handleSave(): Promise<void> {
    if (!config) return;

    let profiles: Config['llm']['profiles'];
    try {
      profiles = JSON.parse(profilesText) as Config['llm']['profiles'];
      setProfilesError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid JSON';
      setProfilesError(message);
      toast.error(`LLM profiles is not valid JSON: ${message}`);
      return;
    }

    setPickingError(null);
    const seederFloor = parsePickingNumber(seederFloorText);
    const minSizeMB = parsePickingNumber(minSizeMBText);
    const maxSizeMB = parsePickingNumber(maxSizeMBText);
    if (seederFloor === undefined || minSizeMB === undefined || maxSizeMB === undefined) {
      // Collects every failing field's message (not just the last one checked) so the
      // user can fix them all in one pass instead of one save attempt per field.
      const messages = [
        seederFloor === undefined && 'Seeder floor must be a number',
        minSizeMB === undefined && 'Min size must be a number',
        maxSizeMB === undefined && 'Max size must be a number',
      ].filter((m): m is string => m !== false);
      setPickingError(messages.join('; '));
      toast.error('Picking fields must all be numbers');
      return;
    }

    const tags = tagsText
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // Full replace: round-trip everything from the last GET/save, with just the edited
    // fields overlaid — llm.keys entries are rebuilt from the per-provider text fields
    // (see `buildLlmKeys`) and the server merges sentinel values back to the stored secret.
    const payload: Config = {
      ...config,
      picking: { tags, seederFloor, minSizeMB, maxSizeMB },
      llm: { ...config.llm, profiles, keys: buildLlmKeys() },
    };

    setSaving(true);
    setSaveError(null);
    try {
      const result = await saveConfig(payload);
      toast.success(result.restartRequired ? 'Config saved — restart required to apply' : 'Config saved');
      const fresh = await fetchConfig();
      loadFormState(fresh);
    } catch (err) {
      if (err instanceof ApiError) {
        const issueText = err.issues?.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        setSaveError(issueText ? `${err.message} — ${issueText}` : err.message);
        toast.error(err.message);
      } else {
        setSaveError('failed to save config');
        toast.error('failed to save config');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Arr instances</CardTitle>
          <CardDescription>
            Leave the API key as {SECRET_PLACEHOLDER} to keep the stored value. Renaming an instance requires
            re-entering its key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {config.arrs.map((arr, i) => (
            <div key={i} className="grid grid-cols-[1fr_120px_1.5fr_1.5fr_auto] items-center gap-2">
              <Input placeholder="name" value={arr.name} onChange={(e) => updateArr(i, { name: e.target.value })} />
              <select
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                value={arr.kind}
                onChange={(e) => updateArr(i, { kind: e.target.value as ArrKind })}
              >
                <option value="sonarr">sonarr</option>
                <option value="radarr">radarr</option>
              </select>
              <Input placeholder="base URL" value={arr.baseUrl} onChange={(e) => updateArr(i, { baseUrl: e.target.value })} />
              <Input
                type="password"
                placeholder="API key"
                autoComplete="new-password"
                value={arr.apiKey}
                onChange={(e) => updateArr(i, { apiKey: e.target.value })}
              />
              <Button variant="ghost" size="sm" onClick={() => removeArr(i)}>
                Remove
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addArr}>
            Add instance
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Path mappings</CardTitle>
          <CardDescription>
            Translates a path the arr reports into Warrden's own filesystem view — needed whenever Warrden and the
            arr see the same files under different mount points (e.g. a NAS share mounted at a different path on
            each side).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {config.pathMappings.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <Input placeholder="from (arr-side)" value={m.from} onChange={(e) => updatePathMapping(i, { from: e.target.value })} />
              <Input placeholder="to (Warrden-side)" value={m.to} onChange={(e) => updatePathMapping(i, { to: e.target.value })} />
              <Button variant="ghost" size="sm" onClick={() => removePathMapping(i)}>
                Remove
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addPathMapping}>
            Add mapping
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ingest</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <StringListField
            label="Mount markers"
            helperText="Warrden-local paths that must exist before ingest touches the filesystem — e.g. a canary file at the root of each NAS mount. Empty means no mount verification."
            values={config.ingest.mountMarkers}
            onChange={(mountMarkers) => updateIngest({ mountMarkers })}
          />
          <StringListField
            label="Download roots"
            helperText="Arr-side paths of the torrent clients' download roots — used to find each torrent's own folder for bundle rescue."
            values={config.ingest.downloadRoots}
            onChange={(downloadRoots) => updateIngest({ downloadRoots })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Picking</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Tags (one per line)</label>
            <Textarea rows={4} value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Seeder floor</label>
              <Input
                type="number"
                value={seederFloorText}
                onChange={(e) => {
                  setSeederFloorText(e.target.value);
                  setPickingError(null);
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Min size (MB)</label>
              <Input
                type="number"
                value={minSizeMBText}
                onChange={(e) => {
                  setMinSizeMBText(e.target.value);
                  setPickingError(null);
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Max size (MB)</label>
              <Input
                type="number"
                value={maxSizeMBText}
                onChange={(e) => {
                  setMaxSizeMBText(e.target.value);
                  setPickingError(null);
                }}
              />
            </div>
          </div>
          {pickingError && <p className="text-sm text-destructive">{pickingError}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>LLM</CardTitle>
          <CardDescription>
            Call-sites: {CALLSITES.join(', ')}. Each profile below must map every call-site it's used for to a
            provider/model (with an optional fallback) — a call-site missing from the active profile fails outright
            when it's invoked.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Active profile</label>
            <div className="flex gap-2">
              {(['dev', 'prod'] as const).map((profile) => (
                <Button
                  key={profile}
                  variant={config.llm.activeProfile === profile ? 'default' : 'outline'}
                  size="sm"
                  onClick={() =>
                    setConfig((prev) => (prev ? { ...prev, llm: { ...prev.llm, activeProfile: profile } } : prev))
                  }
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
              onChange={(e) => {
                setProfilesText(e.target.value);
                setProfilesError(null);
              }}
            />
            {profilesError && <p className="mt-1 text-sm text-destructive">{profilesError}</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Leave a key as {SECRET_PLACEHOLDER} — or blank it out — to keep the stored value unchanged; a blank
            field only means "never set" if it was already blank. Check "Remove" to actually delete a stored key.
            Not needed for the claude-code provider, which uses subscription auth instead.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
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
        </CardContent>
      </Card>

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}
      <Button onClick={() => void handleSave()} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
