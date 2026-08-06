import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, fetchConfig, saveConfig, type ArrInstance, type ArrKind, type Config } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

const EMPTY_ARR: ArrInstance = { name: '', kind: 'sonarr', baseUrl: '', apiKey: '' };

export default function ConfigPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [tagsText, setTagsText] = useState('');
  const [profilesText, setProfilesText] = useState('');
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
        setTagsText(c.picking.tags.join('\n'));
        setProfilesText(JSON.stringify(c.llm.profiles, null, 2));
      })
      .catch((err: unknown) => toast.error(err instanceof ApiError ? err.message : 'failed to load config'));
  }, []);

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

  function updatePicking(patch: Partial<Config['picking']>): void {
    setConfig((prev) => (prev ? { ...prev, picking: { ...prev.picking, ...patch } } : prev));
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

    const tags = tagsText
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // Full replace: round-trip everything from the last GET/save, with just the edited
    // fields overlaid — llm.keys is sent back untouched (still '•••' where unset by the
    // user) and the server merges it specially.
    const payload: Config = {
      ...config,
      picking: { ...config.picking, tags },
      llm: { ...config.llm, profiles },
    };

    setSaving(true);
    setSaveError(null);
    try {
      const result = await saveConfig(payload);
      toast.success(result.restartRequired ? 'Config saved — restart required to apply' : 'Config saved');
      const fresh = await fetchConfig();
      setConfig(fresh);
      setTagsText(fresh.picking.tags.join('\n'));
      setProfilesText(JSON.stringify(fresh.llm.profiles, null, 2));
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
            Leave the API key as ••• to keep the stored value. Renaming an instance requires re-entering its key.
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
              <Input placeholder="API key" value={arr.apiKey} onChange={(e) => updateArr(i, { apiKey: e.target.value })} />
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
                value={config.picking.seederFloor}
                onChange={(e) => updatePicking({ seederFloor: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Min size (MB)</label>
              <Input
                type="number"
                value={config.picking.minSizeMB}
                onChange={(e) => updatePicking({ minSizeMB: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Max size (MB)</label>
              <Input
                type="number"
                value={config.picking.maxSizeMB}
                onChange={(e) => updatePicking({ maxSizeMB: Number(e.target.value) })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>LLM</CardTitle>
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

      {saveError && <p className="text-sm text-destructive">{saveError}</p>}
      <Button onClick={() => void handleSave()} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
