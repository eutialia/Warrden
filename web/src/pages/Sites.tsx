import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Globe, Pencil, Plus, Power, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  ApiError,
  apiErrorMessage,
  fetchConfig,
  fetchSiteKnowledge,
  fetchSiteProfiles,
  KNOWLEDGE_CHAR_CAP,
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
import { LanguageInput } from '@/components/LanguageInput';
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

  // Languages and preferred groups persist on each chip add/remove. Sites are
  // edited through dialogs and persist on confirm.
  const [languages, setLanguages] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const languagesRef = useRef<string[]>([]);
  const groupsRef = useRef<string[]>([]);
  languagesRef.current = languages;
  groupsRef.current = groups;

  // The last config the server handed us, read by the chip rollback path from inside a
  // promise callback that closed over an older render's `config`.
  const configRef = useRef<Config | null>(null);
  configRef.current = config;

  const [draft, setDraft] = useState<SiteDraft | null>(null);
  const [removing, setRemoving] = useState<SubtitleSite | null>(null);

  // Knowledge view: which site's file is open, its markdown draft, and the three async
  // states a hand-editor needs (loading the file in, saving an edit, resetting to seed).
  const [knowledgeSite, setKnowledgeSite] = useState<SubtitleSite | null>(null);
  const [knowledgeMarkdown, setKnowledgeMarkdown] = useState('');
  const [knowledgeAgentChars, setKnowledgeAgentChars] = useState(0);
  // The compare-and-swap token the last GET/PUT/reset response returned. Threaded back on
  // the next Save so the server can tell a reflection run wrote the file in the meantime
  // and refuse (409) rather than silently overwrite it.
  const [knowledgeVersion, setKnowledgeVersion] = useState('');
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resettingKnowledge, setResettingKnowledge] = useState(false);

  // True while a chip write hasn't round-tripped. Held in a ref because `refetch`
  // runs on a 45-second heartbeat and on every server event: re-seeding the fields
  // from the server mid-write would snap the chip back off.
  const prefsDirtyRef = useRef(false);
  // Tail of the chain every config write runs on, so no two are ever in flight together.
  const writeQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const beginFetch = useFetchGeneration();
  // Only the newest chip edit owns the fields, so an older one's failure must not roll
  // back over a newer one's optimistic state.
  const beginPrefsWrite = useFetchGeneration();
  // The knowledge dialog gets its own counter, separate from `refetch`'s. Sharing one
  // (round 1's approach) meant any SSE event or the 45 s heartbeat landing mid-open bumped
  // the same generation the dialog was waiting on, wedging it on a permanent skeleton —
  // `refetch` and the dialog are unrelated resources and must not be able to cancel each
  // other. This same counter also guards `saveKnowledge` and `resetKnowledge`: without it,
  // closing a slow save and opening a different site's dialog let the stale response
  // overwrite that other site's editor and, on the next Save, its file.
  const beginKnowledgeFetch = useFetchGeneration();
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

  /** This page only owns `subtitle`. Everything else is rebased on a fresh read:
   * `PUT /api/config` replaces the whole document, so sending our stale copy would
   * undo a Settings save from the last heartbeat. Patch merges into `current.subtitle`
   * so a language write can't clobber a site add in the other direction.
   *
   * Each call is a read-modify-write, so two overlapping ones both read the pre-edit
   * document and whichever PUT lands last erases the other's edit. Chip edits make that
   * reachable by clicking — nothing gates them behind a disabled button — so every write
   * queues behind the previous one instead. */
  const persistSubtitle = useCallback(
    (patch: Partial<Config['subtitle']>, successMsg?: string): Promise<boolean> => {
      setSaving(true);
      const run: Promise<boolean> = writeQueueRef.current.then(async () => {
        try {
          const current = await fetchConfig();
          await saveConfig({ ...current, subtitle: { ...current.subtitle, ...patch } });
          if (successMsg) toast.success(successMsg);
          refetch();
          return true;
        } catch (err) {
          toast.error(apiErrorMessage(err, 'Failed to save'));
          return false;
        } finally {
          // Only the write still at the tail clears the flag: an earlier one finishing
          // while a later one is queued must not re-enable the dialogs mid-sequence.
          if (writeQueueRef.current === run) setSaving(false);
        }
      });
      writeQueueRef.current = run;
      return run;
    },
    [refetch],
  );

  /** Chip edits persist as they happen, so a failed write has to undo itself. Rolling the
   * fields back to the last config the server gave us is deterministic, and it makes
   * `prefsDirty` false again so the next heartbeat is free to re-seed them. Clearing
   * `prefsDirtyRef` and leaning on a refetch is not: that ref is recomputed from state on
   * every render, and any render landing before the response flips it back to true and the
   * re-seed is skipped, stranding a chip that never reached the server. */
  function commitList(kind: 'languages' | 'groups', next: string[]): void {
    if (kind === 'languages') {
      languagesRef.current = next;
      setLanguages(next);
    } else {
      groupsRef.current = next;
      setGroups(next);
    }
    const isStale = beginPrefsWrite();
    void persistSubtitle({
      languages: languagesRef.current,
      preferredGroups: groupsRef.current,
    }).then((ok) => {
      // A newer chip edit has taken over the fields; its own outcome decides what they show.
      if (ok || isStale()) return;
      const server = configRef.current;
      if (!server) return;
      languagesRef.current = server.subtitle.languages;
      groupsRef.current = server.subtitle.preferredGroups ?? [];
      setLanguages(languagesRef.current);
      setGroups(groupsRef.current);
    });
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
    const ok = await persistSubtitle({ sites }, draft.original ? 'Site updated' : 'Site added');
    if (ok) setDraft(null);
  }

  async function removeSite(): Promise<void> {
    if (!config || !removing) return;
    const sites = config.subtitle.sites.filter((s) => s.baseUrl !== removing.baseUrl);
    const ok = await persistSubtitle({ sites }, `Removed ${siteLabel(removing.baseUrl)}`);
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
    setKnowledgeAgentChars(0);
    setKnowledgeVersion('');
    setKnowledgeError(null);
    setKnowledgeLoading(true);
    // A fresh open is a clean slate: an abandoned save/reset from before this dialog was
    // closed (its own state writes below are already gated by generation) must not leave
    // this site's Save/Reset buttons stuck disabled from a "Saving…"/"Resetting…" that
    // will now never clear, since its `finally` will see itself as stale and skip.
    setKnowledgeSaving(false);
    setResettingKnowledge(false);
    // The dialog's own generation, shared by all three of its async flows (this one,
    // `saveKnowledge`, `resetKnowledge`) — never `beginFetch`, which belongs to `refetch`
    // and fires on every SSE event and the 45 s heartbeat. Sharing it with `refetch` would
    // let an unrelated page refresh wedge the dialog on its skeleton forever.
    const isStale = beginKnowledgeFetch();
    fetchSiteKnowledge(site.baseUrl)
      .then((k) => {
        if (isStale()) return;
        setKnowledgeMarkdown(k.markdown);
        setKnowledgeAgentChars(k.agentChars);
        setKnowledgeVersion(k.version);
      })
      .catch((err: unknown) => {
        if (isStale()) return;
        setKnowledgeError(apiErrorMessage(err, 'Failed to load knowledge file'));
      })
      .finally(() => {
        if (isStale()) return;
        setKnowledgeLoading(false);
      });
  }

  async function saveKnowledge(): Promise<void> {
    if (!knowledgeSite) return;
    setKnowledgeSaving(true);
    // Captured before the await, same as `openKnowledge`: if the dialog closes (bumping
    // this on its way out) or switches to another site before the PUT resolves, the
    // response below must not land in whichever editor happens to be open by then.
    const isStale = beginKnowledgeFetch();
    try {
      // The response is the post-normalization markdown that actually landed on disk
      // (bullets reflowed, sections reordered) — the editor shows that, not an echo of
      // what was typed, so a hand-edit round-trips visibly rather than silently.
      const saved = await updateSiteKnowledge({
        baseUrl: knowledgeSite.baseUrl,
        markdown: knowledgeMarkdown,
        version: knowledgeVersion,
      });
      if (isStale()) return;
      setKnowledgeMarkdown(saved.markdown);
      setKnowledgeAgentChars(saved.agentChars);
      setKnowledgeVersion(saved.version);
      toast.success('Knowledge saved');
    } catch (err) {
      if (isStale()) return;
      // A 409 means the file changed underneath this edit (almost always a reflection run)
      // — the server already refused the write, so the message just has to say why the
      // dashboard's copy is now stale rather than let the operator assume the save failed
      // for some other reason and retry blind into a second 409.
      const message =
        err instanceof ApiError && err.status === 409
          ? 'This site\'s knowledge changed since it was loaded (probably a background run). Reopen the file to see the current version before editing again.'
          : apiErrorMessage(err, 'Failed to save knowledge');
      toast.error(message);
    } finally {
      if (!isStale()) setKnowledgeSaving(false);
    }
  }

  async function resetKnowledge(): Promise<void> {
    if (!knowledgeSite) return;
    setResettingKnowledge(true);
    // Same guard as `saveKnowledge`, and for the same reason: a reset is a write, so a
    // stale response is exactly as dangerous as a stale save.
    const isStale = beginKnowledgeFetch();
    try {
      const seeded = await resetSiteKnowledge(knowledgeSite.baseUrl);
      if (isStale()) return;
      setKnowledgeMarkdown(seeded.markdown);
      setKnowledgeAgentChars(seeded.agentChars);
      setKnowledgeVersion(seeded.version);
      toast.success('Reset to the shipped seed');
      setConfirmingReset(false);
    } catch (err) {
      if (isStale()) return;
      toast.error(apiErrorMessage(err, 'No seed exists for this site'));
    } finally {
      if (!isStale()) setResettingKnowledge(false);
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
            <StatTile label="Accepted languages" value={languages.length} hint="Before a video counts as covered" />
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
                A video needs a track in at least one language listed here before Warrden considers it done.
                Preferred groups only boost ranking — a search never skips a pack because its group is missing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Languages</Label>
                <LanguageInput values={languages} onChange={(next) => commitList('languages', next)} />
                <p className="text-xs text-muted-foreground">
                  First is preferred. One of these is enough for an episode to count as subtitled; a run still grabs
                  every one it can find.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Preferred fansub groups</Label>
                <TagInput
                  values={groups}
                  onChange={(next) => commitList('groups', next)}
                  placeholder="e.g. Airota — Enter to add"
                />
              </div>
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
      <Dialog
        open={knowledgeSite !== null}
        onOpenChange={(open) => {
          if (open) return;
          // Escape/overlay-click closes even while a save or reset is in flight (the
          // buttons are disabled, but the dialog itself isn't). Bump the generation here,
          // on the way out, so that response — whenever it lands — finds itself stale
          // rather than repopulating whatever site's editor happens to be open by then.
          beginKnowledgeFetch();
          setKnowledgeSite(null);
        }}
      >
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
              <div className="space-y-1">
                <Textarea
                  rows={24}
                  className="font-mono text-xs"
                  value={knowledgeMarkdown}
                  onChange={(e) => setKnowledgeMarkdown(e.target.value)}
                />
                {/* What the agent itself is held to — operator notes below don't count
                    against this, and saving over it is refused with the reason why. */}
                <p
                  className={`text-xs ${knowledgeAgentChars > KNOWLEDGE_CHAR_CAP ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                  agent sections {knowledgeAgentChars.toLocaleString()} / {KNOWLEDGE_CHAR_CAP.toLocaleString()}
                </p>
              </div>
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
              <Button
                disabled={knowledgeLoading || knowledgeSaving || resettingKnowledge || knowledgeError !== null}
                onClick={() => void saveKnowledge()}
              >
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
            <AlertDialogCancel render={<Button variant="ghost" disabled={resettingKnowledge}>Cancel</Button>} />
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
