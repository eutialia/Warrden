import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { CALLSITES, type CallsiteModel, type Config, type Provider } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'claude-code', label: 'Claude Code' },
];

const NONE = 'none';

// base-ui renders the raw value in the trigger unless the root is given a
// value→label map, so every select that shows friendly text needs one.
const PROVIDER_ITEMS: Record<string, string> = Object.fromEntries(PROVIDERS.map((p) => [p.value, p.label]));
const FALLBACK_ITEMS: Record<string, string> = { [NONE]: 'No fallback', ...PROVIDER_ITEMS };

type Profiles = Config['llm']['profiles'];

/**
 * Per-call-site model routing, previously a raw JSON textarea. The call-site list
 * is open (the backend accepts any key), so the known ones are offered as rows and
 * anything extra already in the config is shown alongside rather than hidden.
 */
export function LlmProfileEditor({
  profile,
  profiles,
  onChange,
}: {
  profile: string;
  profiles: Profiles;
  onChange: (next: Profiles) => void;
}) {
  const [newCallsite, setNewCallsite] = useState('');
  const current = profiles[profile] ?? {};

  // Known call-sites first (stable order), then anything custom the config carries.
  const callsites = [...CALLSITES, ...Object.keys(current).filter((k) => !CALLSITES.includes(k as never))];

  function update(callsite: string, next: CallsiteModel | undefined): void {
    const nextProfile = { ...current };
    if (next) nextProfile[callsite] = next;
    else delete nextProfile[callsite];
    onChange({ ...profiles, [profile]: nextProfile });
  }

  return (
    <div className="space-y-3">
      {callsites.map((callsite) => {
        const entry = current[callsite];
        const configured = entry !== undefined;
        return (
          <div key={callsite} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-sm font-medium">{callsite}</code>
              {!configured && <span className="text-xs text-muted-foreground">not routed — falls back to defaults</span>}
              {configured && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  aria-label={`Clear routing for ${callsite}`}
                  onClick={() => update(callsite, undefined)}
                >
                  <X />
                </Button>
              )}
            </div>

            {configured ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Provider</Label>
                  <Select
                    items={PROVIDER_ITEMS}
                    value={entry.provider}
                    onValueChange={(v) => v && update(callsite, { ...entry, provider: v as Provider })}
                  >
                    <SelectTrigger>
                      <SelectValue />
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
                <div className="space-y-1.5">
                  <Label className="text-xs">Model</Label>
                  <Input
                    value={entry.model}
                    placeholder="e.g. sonnet"
                    onChange={(e) => update(callsite, { ...entry, model: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Fallback provider</Label>
                  <Select
                    items={FALLBACK_ITEMS}
                    value={entry.fallback?.provider ?? NONE}
                    onValueChange={(v) =>
                      update(
                        callsite,
                        !v || v === NONE
                          ? { provider: entry.provider, model: entry.model }
                          : { ...entry, fallback: { provider: v as Provider, model: entry.fallback?.model ?? '' } },
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>No fallback</SelectItem>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Fallback model</Label>
                  <Input
                    value={entry.fallback?.model ?? ''}
                    disabled={!entry.fallback}
                    placeholder={entry.fallback ? 'e.g. gpt-4o-mini' : 'Pick a fallback provider first'}
                    onChange={(e) =>
                      entry.fallback &&
                      update(callsite, { ...entry, fallback: { ...entry.fallback, model: e.target.value } })
                    }
                  />
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => update(callsite, { provider: 'openrouter', model: '' })}
              >
                <Plus />
                Route this call-site
              </Button>
            )}
          </div>
        );
      })}

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="new-callsite" className="text-xs">
            Add a call-site not listed above
          </Label>
          <Input
            id="new-callsite"
            value={newCallsite}
            placeholder="call-site name"
            onChange={(e) => setNewCallsite(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          disabled={newCallsite.trim() === '' || current[newCallsite.trim()] !== undefined}
          onClick={() => {
            update(newCallsite.trim(), { provider: 'openrouter', model: '' });
            setNewCallsite('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
