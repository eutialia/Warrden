import { useCallback, useEffect, useState } from 'react';
import { Globe, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  apiErrorMessage,
  fetchConfig,
  fetchSiteProfiles,
  saveConfig,
  updateSiteProfile,
  type Config,
  type SiteProfileRow,
  type SubtitleSite,
} from '@/api';
import { PageHeader } from '@/components/PageHeader';
import { StatusNotice } from '@/components/StatusNotice';
import { TagInput } from '@/components/TagInput';
import { ToneBadge } from '@/components/ToneBadge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useFetchGeneration } from '@/hooks/useFetchGeneration';
import { useSseRefetch } from '@/hooks/useSseRefetch';
import { tierLabel } from '@/lib/labels';
import { formatRelativeTime } from '@/lib/utils';

const EMPTY_SITE: SubtitleSite = { name: '', baseUrl: '', searchUrlTemplate: '' };

/** Draft state for the add/edit dialog — `original` is null when adding. */
interface SiteDraft {
  original: SubtitleSite | null;
  value: SubtitleSite;
}

export default function Sites() {
  const [config, setConfig] = useState<Config | null>(null);
  const [profiles, setProfiles] = useState<SiteProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Languages and preferred groups are a small form with its own save; sites are
  // edited through dialogs and persist on confirm.
  const [languages, setLanguages] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);

  const [draft, setDraft] = useState<SiteDraft | null>(null);
  const [removing, setRemoving] = useState<SubtitleSite | null>(null);
  const [notesFor, setNotesFor] = useState<SiteProfileRow | null>(null);
  const [notesDraft, setNotesDraft] = useState('');

  const beginFetch = useFetchGeneration();
  const refetch = useCallback(() => {
    const isStale = beginFetch();
    Promise.all([fetchConfig(), fetchSiteProfiles()])
      .then(([c, p]) => {
        if (isStale()) return;
        setConfig(c);
        setLanguages(c.subtitle.languages);
        setGroups(c.subtitle.preferredGroups ?? []);
        setProfiles(p.profiles);
        setError(null);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setError(apiErrorMessage(err, 'Failed to load subtitle sources'));
      })
      .finally(() => {
        if (isStale()) return;
        setLoading(false);
      });
  }, [beginFetch]);
  useSseRefetch(refetch);

  useEffect(refetch, [refetch]);

  /** Writes a whole config back. Secrets round-trip as the redaction sentinel the
   * API hands us, so re-sending the fetched object never rotates a stored key. */
  const persist = useCallback(
    async (next: Config, successMsg: string): Promise<boolean> => {
      setSaving(true);
      try {
        await saveConfig(next);
        toast.success(successMsg);
        refetch();
        return true;
      } catch (err) {
        toast.error(apiErrorMessage(err, 'Failed to save'));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refetch],
  );

  async function savePreferences(): Promise<void> {
    if (!config) return;
    await persist(
      { ...config, subtitle: { ...config.subtitle, languages, preferredGroups: groups } },
      'Subtitle preferences saved',
    );
  }

  async function saveSite(): Promise<void> {
    if (!config || !draft) return;
    const value: SubtitleSite = {
      name: draft.value.name.trim(),
      baseUrl: draft.value.baseUrl.trim(),
      searchUrlTemplate: draft.value.searchUrlTemplate?.trim() || undefined,
    };
    if (!value.name || !value.baseUrl) {
      toast.error('A site needs both a name and a base URL');
      return;
    }
    const sites = draft.original
      ? config.subtitle.sites.map((s) => (s.name === draft.original!.name ? value : s))
      : [...config.subtitle.sites, value];
    const ok = await persist({ ...config, subtitle: { ...config.subtitle, sites } }, draft.original ? 'Site updated' : 'Site added');
    if (ok) setDraft(null);
  }

  async function removeSite(): Promise<void> {
    if (!config || !removing) return;
    const sites = config.subtitle.sites.filter((s) => s.name !== removing.name);
    const ok = await persist({ ...config, subtitle: { ...config.subtitle, sites } }, `Removed ${removing.name}`);
    if (ok) setRemoving(null);
  }

  async function saveNotes(): Promise<void> {
    if (!notesFor) return;
    try {
      const updated = await updateSiteProfile(notesFor.name, { notes: notesDraft });
      setProfiles((prev) => prev.map((p) => (p.name === updated.name ? updated : p)));
      setNotesFor(null);
      toast.success('Notes saved');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to save notes'));
    }
  }

  async function clearFailures(row: SiteProfileRow): Promise<void> {
    try {
      const updated = await updateSiteProfile(row.name, { failCount: 0, lastFailureAt: null });
      setProfiles((prev) => prev.map((p) => (p.name === updated.name ? updated : p)));
      toast.success(`Cleared failures for ${row.name}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to clear failures'));
    }
  }

  const prefsDirty =
    config !== null &&
    (JSON.stringify(languages) !== JSON.stringify(config.subtitle.languages) ||
      JSON.stringify(groups) !== JSON.stringify(config.subtitle.preferredGroups ?? []));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subtitle sources"
        description="Everything about finding subtitles: which languages count as covered, which fansub groups to favour, and the public sites Warrden browses."
      />
      {error && <StatusNotice message={error} onRetry={refetch} />}

      {loading && !config && <Skeleton className="h-64 w-full" />}

      {config && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>What counts as covered</CardTitle>
              <CardDescription>
                A video needs a track in every language listed here before Warrden considers it done. Preferred groups
                only boost ranking — a search never skips a pack because its group is missing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Languages</Label>
                <TagInput values={languages} onChange={setLanguages} placeholder="e.g. zh-Hans — Enter to add" />
              </div>
              <div className="space-y-2">
                <Label>Preferred fansub groups</Label>
                <TagInput values={groups} onChange={setGroups} placeholder="e.g. Airota — Enter to add" />
              </div>
              {prefsDirty && (
                <div className="flex items-center gap-2 border-t pt-4">
                  <Button disabled={saving} onClick={() => void savePreferences()}>
                    {saving ? 'Saving…' : 'Save preferences'}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setLanguages(config.subtitle.languages);
                      setGroups(config.subtitle.preferredGroups ?? []);
                    }}
                  >
                    Discard
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sites</CardTitle>
              <CardDescription>
                Warrden browses these in order, remembering the cheapest access method that worked for each.
              </CardDescription>
              <CardAction>
                <Button size="sm" onClick={() => setDraft({ original: null, value: { ...EMPTY_SITE } })}>
                  <Plus />
                  Add site
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              {config.subtitle.sites.length === 0 && (
                <Empty className="py-10">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Globe />
                    </EmptyMedia>
                    <EmptyTitle>No sites configured</EmptyTitle>
                    <EmptyDescription>
                      Warrden can't search for subtitles until at least one public site is added.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button size="sm" onClick={() => setDraft({ original: null, value: { ...EMPTY_SITE } })}>
                      <Plus />
                      Add your first site
                    </Button>
                  </EmptyContent>
                </Empty>
              )}

              {config.subtitle.sites.map((site) => {
                const profile = profiles.find((p) => p.name === site.name);
                const failing = (profile?.fail_count ?? 0) > 0;
                return (
                  <div key={site.name} className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{site.name}</span>
                          <Badge variant="outline" className="text-muted-foreground">
                            {tierLabel(profile?.last_working_tier ?? null)}
                          </Badge>
                          {failing && (
                            <ToneBadge tone="warning">
                              {profile!.fail_count} recent {profile!.fail_count === 1 ? 'failure' : 'failures'}
                            </ToneBadge>
                          )}
                        </div>
                        <code className="mt-1 block truncate text-xs text-muted-foreground">{site.baseUrl}</code>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setDraft({ original: site, value: { ...site } })}>
                          <Pencil />
                          Edit
                        </Button>
                        {failing && (
                          <Button variant="ghost" size="sm" onClick={() => void clearFailures(profile!)}>
                            <RotateCcw />
                            Clear failures
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setRemoving(site)}>
                          <Trash2 />
                        </Button>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                      <span>Last success: {formatRelativeTime(profile?.last_success_at ?? null)}</span>
                      <span>Last failure: {formatRelativeTime(profile?.last_failure_at ?? null)}</span>
                    </div>

                    <div className="mt-3 flex items-start gap-2 border-t pt-3">
                      <p className="min-w-0 flex-1 text-xs whitespace-pre-wrap text-muted-foreground">
                        {profile?.notes || 'No notes. Anything you write here is given to the browse agent as context.'}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!profile}
                        onClick={() => {
                          setNotesFor(profile!);
                          setNotesDraft(profile!.notes);
                        }}
                      >
                        Edit notes
                      </Button>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}

      {/* Add / edit site */}
      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.original ? 'Edit site' : 'Add a subtitle site'}</DialogTitle>
            <DialogDescription>
              Warrden discovers the search endpoint itself when no template is given — supply one only if the site needs it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="site-name">Name</Label>
              <Input
                id="site-name"
                autoFocus
                value={draft?.value.name ?? ''}
                onChange={(e) => setDraft((d) => (d ? { ...d, value: { ...d.value, name: e.target.value } } : d))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-url">Base URL</Label>
              <Input
                id="site-url"
                placeholder="https://example.org"
                value={draft?.value.baseUrl ?? ''}
                onChange={(e) => setDraft((d) => (d ? { ...d, value: { ...d.value, baseUrl: e.target.value } } : d))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-template">Search URL template (optional)</Label>
              <Input
                id="site-template"
                placeholder="https://example.org/search?q={query}"
                value={draft?.value.searchUrlTemplate ?? ''}
                onChange={(e) =>
                  setDraft((d) => (d ? { ...d, value: { ...d.value, searchUrlTemplate: e.target.value } } : d))
                }
              />
              <p className="text-xs text-muted-foreground">
                Use <code>{'{query}'}</code> where the search term goes.
              </p>
            </div>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button disabled={saving} onClick={() => void saveSite()}>
              {saving ? 'Saving…' : draft?.original ? 'Save changes' : 'Add site'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Notes */}
      <Dialog open={notesFor !== null} onOpenChange={(open) => !open && setNotesFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Notes for {notesFor?.name}</DialogTitle>
            <DialogDescription>
              Injected into the browse agent's prompt for this site — quirks, working search patterns, things to avoid.
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={6} autoFocus value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} />
          <DialogFooter>
            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
            <Button onClick={() => void saveNotes()}>Save notes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove site */}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop searching {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Warrden will no longer browse this site. What it learned about the site is kept, so re-adding it later
              starts from the same memory rather than from scratch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel render={<Button variant="ghost">Cancel</Button>} />
            <AlertDialogAction
              render={
                <Button variant="destructive" disabled={saving} onClick={() => void removeSite()}>
                  Remove site
                </Button>
              }
            />
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
