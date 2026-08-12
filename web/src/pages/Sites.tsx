import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Globe, Pencil, Plus, Power, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  apiErrorMessage,
  fetchConfig,
  fetchSiteKnowledge,
  fetchSiteProfiles,
  resetSiteKnowledge,
  saveConfig,
  updateSiteKnowledge,
  updateSiteProfile,
  type Config,
  type SiteProfileRow,
  type SubtitleSite,
} from '@/api';
import { PageHeader } from '@/components/PageHeader';
import { SectionStack } from '@/components/SectionStack';
import { StatBand, StatTile } from '@/components/StatTile';
import { StatusNotice } from '@/components/StatusNotice';
import { TagInput } from '@/components/TagInput';
import { StatusDot, ToneBadge } from '@/components/ToneBadge';
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
import { siteLabel, tierLabel } from '@/lib/labels';
import type { Tone } from '@/lib/tone';
import { formatRelativeTime } from '@/lib/utils';

/** A site's health at a glance: green once it has worked and has no failures on
 * record, amber while failures stand, neutral for one Warrden has never used. */
function siteTone(profile: SiteProfileRow | undefined): Tone {
  if (!profile) return 'neutral';
  if (profile.fail_count > 0) return 'warning';
  return profile.last_success_at === null ? 'neutral' : 'success';
}

const EMPTY_SITE: SubtitleSite = { baseUrl: '', searchUrlTemplate: '' };

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

  // Knowledge view: which site's file is open, its markdown draft, and the three async
  // states a hand-editor needs (loading the file in, saving an edit, resetting to seed).
  const [knowledgeSite, setKnowledgeSite] = useState<SubtitleSite | null>(null);
  const [knowledgeMarkdown, setKnowledgeMarkdown] = useState('');
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resettingKnowledge, setResettingKnowledge] = useState(false);

  // Whether the two tag fields hold edits nobody has saved yet. Held in a ref because
  // `refetch` runs on a 45-second heartbeat and on every server event: re-seeding the
  // fields from the server mid-sentence would wipe what someone is typing, and take the
  // save bar with it.
  const prefsDirtyRef = useRef(false);

  const beginFetch = useFetchGeneration();
  const refetch = useCallback(() => {
    const isStale = beginFetch();
    Promise.all([fetchConfig(), fetchSiteProfiles()])
      .then(([c, p]) => {
        if (isStale()) return;
        setConfig(c);
        if (!prefsDirtyRef.current) {
          setLanguages(c.subtitle.languages);
          setGroups(c.subtitle.preferredGroups ?? []);
        }
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
   * API hands us, so re-sending the fetched object never rotates a stored key.
   *
   * The write is built on a fresh read rather than on this page's copy, which can be up
   * to a heartbeat old: `PUT /api/config` replaces the whole document, so a stale copy
   * would quietly undo anything saved from Settings in the meantime. Mounts and path
   * mappings are taken from that fresh read too — they are fixed outside the UI, and no
   * page may rewrite them (the same guard Settings states in its own save). */
  const persist = useCallback(
    async (next: Config, successMsg: string): Promise<boolean> => {
      setSaving(true);
      try {
        const current = await fetchConfig();
        await saveConfig({ ...next, ingest: current.ingest, pathMappings: current.pathMappings });
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
      baseUrl: draft.value.baseUrl.trim(),
      searchUrlTemplate: draft.value.searchUrlTemplate?.trim() || undefined,
    };
    if (!value.baseUrl) {
      toast.error('A site needs a base URL');
      return;
    }
    const sites = draft.original
      ? config.subtitle.sites.map((s) => (s.baseUrl === draft.original!.baseUrl ? value : s))
      : [...config.subtitle.sites, value];
    const ok = await persist({ ...config, subtitle: { ...config.subtitle, sites } }, draft.original ? 'Site updated' : 'Site added');
    if (ok) setDraft(null);
  }

  async function removeSite(): Promise<void> {
    if (!config || !removing) return;
    const sites = config.subtitle.sites.filter((s) => s.baseUrl !== removing.baseUrl);
    const ok = await persist(
      { ...config, subtitle: { ...config.subtitle, sites } },
      `Removed ${siteLabel(removing.baseUrl)}`,
    );
    if (ok) setRemoving(null);
  }

  async function clearFailures(row: SiteProfileRow): Promise<void> {
    try {
      const updated = await updateSiteProfile({ baseUrl: row.base_url, failCount: 0, lastFailureAt: null });
      setProfiles((prev) => prev.map((p) => (p.base_url === updated.base_url ? updated : p)));
      toast.success(`Cleared failures for ${siteLabel(row.base_url)}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to clear failures'));
    }
  }

  /** Clears a site's disabled flag — the operator override for a site the browse agent's
   * evidence-gated verdict shut off. Same reset seam as `clearFailures`, one field wider. */
  async function reEnableSite(row: SiteProfileRow): Promise<void> {
    try {
      const updated = await updateSiteProfile({ baseUrl: row.base_url, disabledAt: null });
      setProfiles((prev) => prev.map((p) => (p.base_url === updated.base_url ? updated : p)));
      toast.success(`Re-enabled ${siteLabel(row.base_url)}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to re-enable site'));
    }
  }

  function openKnowledge(site: SubtitleSite): void {
    setKnowledgeSite(site);
    setKnowledgeMarkdown('');
    setKnowledgeError(null);
    setKnowledgeLoading(true);
    fetchSiteKnowledge(site.baseUrl)
      .then((k) => setKnowledgeMarkdown(k.markdown))
      .catch((err: unknown) => setKnowledgeError(apiErrorMessage(err, 'Failed to load knowledge file')))
      .finally(() => setKnowledgeLoading(false));
  }

  async function saveKnowledge(): Promise<void> {
    if (!knowledgeSite) return;
    setKnowledgeSaving(true);
    try {
      // The response is the post-normalization markdown that actually landed on disk
      // (bullets reflowed, sections reordered) — the editor shows that, not an echo of
      // what was typed, so a hand-edit round-trips visibly rather than silently.
      const saved = await updateSiteKnowledge({ baseUrl: knowledgeSite.baseUrl, markdown: knowledgeMarkdown });
      setKnowledgeMarkdown(saved.markdown);
      toast.success('Knowledge saved');
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Failed to save knowledge'));
    } finally {
      setKnowledgeSaving(false);
    }
  }

  async function resetKnowledge(): Promise<void> {
    if (!knowledgeSite) return;
    setResettingKnowledge(true);
    try {
      const seeded = await resetSiteKnowledge(knowledgeSite.baseUrl);
      setKnowledgeMarkdown(seeded.markdown);
      toast.success('Reset to the shipped seed');
      setConfirmingReset(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'No seed exists for this site'));
    } finally {
      setResettingKnowledge(false);
    }
  }

  const failingCount = profiles.filter((p) => p.fail_count > 0).length;
  const prefsDirty =
    config !== null &&
    (JSON.stringify(languages) !== JSON.stringify(config.subtitle.languages) ||
      JSON.stringify(groups) !== JSON.stringify(config.subtitle.preferredGroups ?? []));
  prefsDirtyRef.current = prefsDirty;

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
          <StatBand>
            <StatTile label="Languages wanted" value={languages.length} hint="Before a video counts as covered" />
            <StatTile label="Preferred groups" value={groups.length} hint="Ranking boost only" />
            <StatTile label="Sites" value={config.subtitle.sites.length} hint="Tried in order, top first" />
            <StatTile
              label="Sites failing"
              value={failingCount}
              hint={failingCount > 0 ? 'Recent failures on record' : 'None on record'}
              tone={failingCount > 0 ? 'warning' : 'neutral'}
            />
          </StatBand>

          <SectionStack className="[&>*:first-child]:border-t-0 [&>*:first-child]:pt-0">
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

              {config.subtitle.sites.map((site, rank) => {
                const profile = profiles.find((p) => p.base_url === site.baseUrl);
                const failing = (profile?.fail_count ?? 0) > 0;
                const disabled = profile?.disabled_at != null;
                return (
                  <div key={site.baseUrl} className="border-t pt-4">
                    <div className="flex flex-wrap items-start gap-3">
                      {/* The order they sit in is the order they are tried, so it is worth
                          showing rather than leaving to be inferred. */}
                      <span className="mt-0.5 w-4 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {rank + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusDot tone={disabled ? 'danger' : siteTone(profile)} />
                          <span className="font-medium">{siteLabel(site.baseUrl)}</span>
                          <Badge variant="outline" className="text-muted-foreground">
                            {tierLabel(profile?.last_working_tier ?? null)}
                          </Badge>
                          {disabled && <ToneBadge tone="danger">Disabled</ToneBadge>}
                          {!disabled && failing && (
                            <ToneBadge tone="warning">
                              {profile!.fail_count} recent {profile!.fail_count === 1 ? 'failure' : 'failures'}
                            </ToneBadge>
                          )}
                        </div>
                        <code className="mt-1 block truncate text-xs text-muted-foreground">{site.baseUrl}</code>
                        {disabled && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            The browse agent gave up on this site: {profile!.disabled_reason || 'no reason recorded'}.
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openKnowledge(site)}>
                          <BookOpen />
                          Knowledge
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDraft({ original: site, value: { ...site } })}>
                          <Pencil />
                          Edit
                        </Button>
                        {disabled ? (
                          <Button variant="ghost" size="sm" onClick={() => void reEnableSite(profile!)}>
                            <Power />
                            Re-enable
                          </Button>
                        ) : (
                          failing && (
                            <Button variant="ghost" size="sm" onClick={() => void clearFailures(profile!)}>
                              <RotateCcw />
                              Clear failures
                            </Button>
                          )
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
                  </div>
                );
              })}
            </CardContent>
          </Card>
          </SectionStack>
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
              <Label htmlFor="site-url">Base URL</Label>
              <Input
                id="site-url"
                autoFocus
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

      {/* Remove site */}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop searching {removing && siteLabel(removing.baseUrl)}?</AlertDialogTitle>
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

      {/* Knowledge: what the browse agent has learned about a site, hand-editable */}
      <Dialog open={knowledgeSite !== null} onOpenChange={(open) => !open && setKnowledgeSite(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{knowledgeSite && siteLabel(knowledgeSite.baseUrl)} knowledge</DialogTitle>
            <DialogDescription>
              The browse agent keeps this file up to date on its own — access method, search and download steps, and
              pitfalls it has hit. <code>## Operator notes</code> is yours; the agent reads it but never writes to it.
            </DialogDescription>
          </DialogHeader>
          {knowledgeError && <StatusNotice message={knowledgeError} onRetry={() => knowledgeSite && openKnowledge(knowledgeSite)} />}
          {knowledgeLoading ? (
            <Skeleton className="h-96 w-full" />
          ) : (
            !knowledgeError && (
              <Textarea
                rows={24}
                className="font-mono text-xs"
                value={knowledgeMarkdown}
                onChange={(e) => setKnowledgeMarkdown(e.target.value)}
              />
            )
          )}
          <DialogFooter className="sm:justify-between">
            <Button
              variant="outline"
              disabled={knowledgeLoading || knowledgeSaving || resettingKnowledge}
              onClick={() => setConfirmingReset(true)}
            >
              Reset to seed
            </Button>
            <div className="flex gap-2">
              <DialogClose render={<Button variant="ghost">Close</Button>} />
              <Button disabled={knowledgeLoading || knowledgeSaving} onClick={() => void saveKnowledge()}>
                {knowledgeSaving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset knowledge to seed — discards everything learned since, so it gets its own
          confirmation on top of the knowledge editor. */}
      <AlertDialog open={confirmingReset} onOpenChange={(open) => !open && setConfirmingReset(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset {knowledgeSite && siteLabel(knowledgeSite.baseUrl)} to the shipped seed?</AlertDialogTitle>
            <AlertDialogDescription>
              Discards everything the agent has learned since (and your operator notes, if any), replacing this
              file with the seed Warrden ships. Sites with no shipped seed can't be reset this way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel render={<Button variant="ghost">Cancel</Button>} />
            <AlertDialogAction
              render={
                <Button variant="destructive" disabled={resettingKnowledge} onClick={() => void resetKnowledge()}>
                  {resettingKnowledge ? 'Resetting…' : 'Reset to seed'}
                </Button>
              }
            />
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
