import { z } from 'zod';
import { siteLabel } from '../config/siteLabel.js';
import type { SubtitleSiteConfig } from '../config/schema.js';
import type { AppContext } from '../context.js';
import type { TranscriptEntry } from './transcript.js';
import { targetEventData } from '../events/target.js';
import type { JobRow } from '../jobs/queue.js';
import { LlmError, resolveModel } from '../llm/generator.js';
import {
  AGENT_SECTIONS,
  KNOWLEDGE_CHAR_CAP,
  KnowledgeConflictError,
  agentCharCount,
  defaultSeedsDir,
  loadKnowledgeWithVersion,
  renderKnowledge,
  saveKnowledge,
  type KnowledgeSection,
  type SiteKnowledge,
} from './siteKnowledge.js';
import { describeStop, stopFromError, type StopReason } from './stop.js';
import { scanForThreats } from './threatPatterns.js';

/** The call-site reflection resolves against. Leaving it out of the active LLM profile is
 * the off switch for self-learning: `reflectOnRun` resolves it before anything else and,
 * finding nothing, finishes quietly with the site's file untouched. */
export const REFLECT_CALLSITE = 'site-notes';

/** What the run says about the site itself, independent of whether anything was learned. */
export type SiteVerdict = 'usable' | 'transient-failure' | 'unusable';

/** What one reflection call ended as. A verdict only exists when the model actually
 * answered, so it and its evidence sentence arrive together or not at all. */
export type ReflectionResult =
  | { stop: StopReason; verdict?: undefined; reason?: undefined }
  | { stop: StopReason; verdict: SiteVerdict; reason: string };

/** Most recent transcript steps handed to the model. A run is bounded by the step budget
 * already; this bounds the prompt against a budget an operator raised. */
const MAX_TRANSCRIPT_LINES = 40;

/** Per-step detail cap. Details carry page text, which is attacker-chosen and unbounded. */
const DETAIL_CAP = 300;

/** Operations honoured from one reflection. A run that learned twenty separate rules did
 * not learn twenty rules; the tail is dropped rather than applied, which also bounds what
 * one response can do to the file and to the event it is reported in. */
const MAX_OPS = 20;

/** Refused operations carried in an event's `data`. The rest are counted, not quoted. */
const MAX_DROPPED_REPORTED = 10;

/** Bounds what a dropped operation quotes back into the event row, nothing else. */
const DROPPED_FIELD_CAP = 400;

/** Any `(confirmed YYYY-MM-DD)` stamp with the whitespace around it, anywhere in the text
 * — not just a trailing one. A stamp buried mid-bullet survives a trailing-only strip and
 * would otherwise leave a second, contradictory stamp in the stored text once the real one
 * is appended, muddying the one freshness signal an operator reads off the file. */
const STAMP_RE = /\s*\(confirmed \d{4}-\d{2}-\d{2}\)\s*/g;

/** The code points a text format most commonly treats as ending a line: CR, LF, next line,
 * vertical tab, form feed, and the Unicode line/paragraph separators. `parseKnowledge`
 * splits on LF alone, but the file is also read by a language model whose tokenizer's idea
 * of a line break is its own — a bullet carrying U+0085 renders as a forged
 * `## Operator notes` heading in the prompt whether or not our parser agrees. U+2028 and
 * U+2029 are worse than cosmetic: `.` in `BULLET_RE` does not match them, so a bullet
 * containing one stops parsing as a bullet at all and disappears on the next save, after
 * the operator was told the write applied.
 *
 * Not exhaustive, despite the ambition: the C1 control block's U+001C-U+001E (file/group/
 * record separator) and the visible line-break SYMBOLS U+2424/U+240A are accepted and
 * stored (D-28). They forge nothing today — `parseKnowledge` splits on `\n` only, `.` in
 * `BULLET_RE` matches them, and `renderKnowledge` re-emits one line — so this is not a
 * security hole, only a doc comment that used to claim more totality than this set has. */
const LINE_BREAK_RE = /[\r\n\v\f\u0085\u2028\u2029]/;

/** Bullet text that would forge file structure once rendered, mapped to why it's refused.
 * `renderKnowledge` writes a bullet as `- ${text}` with no escaping, so any of these turn
 * one operation into markdown the next `parseKnowledge` reads as something else entirely:
 * a newline can open a `## Operator notes` heading (whose contents are trusted, exempt
 * from scanning, and injected as authoritative), or a protocol section an unverified run
 * may not write, or simply more bullets than the one operation being applied. The parser
 * was made strict at exactly these boundaries; the writer must not be able to forge them
 * from the other side. */
const FORGERY_CHECKS: readonly { test: RegExp; why: string; hostile?: true }[] = [
  // A line break is the one that cannot be a mistake: nothing about writing one rule on one
  // line produces a second line, and what follows it is a forged heading or a second bullet.
  { test: LINE_BREAK_RE, why: 'line break in bullet text — a bullet is one line', hostile: true },
  // These two are ordinary markdown habits. A model that writes `## Access` or a nested `- `
  // at the start of a rule is far more likely to be formatting than attacking, and calling
  // that an attack put typos on the channel reserved for recorded attempts to poison the
  // file. One leading marker is stripped before we get here; what is left is a real refusal,
  // and a plain one.
  { test: /^#{1,6}\s/, why: 'bullet text starts a markdown heading' },
  { test: /^[-*+]\s/, why: 'bullet text starts a markdown bullet marker' },
];

/** One leading list marker, as a model writing markdown will produce. `renderKnowledge`
 * adds the `- ` itself, so a marker the model wrote is duplication, not structure — stripping
 * it is what makes a bullet copied straight out of the rendered file a usable `target`. */
const LEADING_MARKER_RE = /^[-*+]\s+/;

/** Bullet text as the file means it: without the list marker the renderer supplies. */
function withoutMarker(text: string): string {
  return text.replace(LEADING_MARKER_RE, '');
}

/**
 * Flat root object, every field REQUIRED — the same strict-mode constraint documented on
 * `AgentActionSchema` in `loop.ts`: `.optional()`/`.default()` drop a field from the JSON
 * schema's `required` array and OpenAI's strict mode rejects the schema outright. So the
 * absent value is a `''` sentinel instead: `target` is '' for `add`, and `applyOps` reads
 * '' as "not given". There is no `remove` op: the operator ruled that the reflection agent
 * has no deletion authority at all — websites are stable skeletons, a correction is
 * `update`'s job, and only the operator deletes a bullet, via the dashboard.
 */
export const KnowledgeOpSchema = z.object({
  op: z.enum(['add', 'update']).describe('what to do with one bullet'),
  section: z.enum(['Access', 'Search', 'Download', 'Pitfalls']).describe('which section the bullet belongs to'),
  text: z.string().describe('the new bullet as an IF/THEN rule'),
  target: z.string().describe('the exact existing bullet to update; empty string for add'),
});

export type KnowledgeOp = z.infer<typeof KnowledgeOpSchema>;

export const ReflectionSchema = z.object({
  verdict: z.enum(['usable', 'transient-failure', 'unusable']).describe('whether this site can be automated at all'),
  reason: z.string().describe('one sentence of evidence for the verdict'),
  ops: z.array(KnowledgeOpSchema).describe('bullet edits; an empty list is a fine outcome'),
});

/** One operation that did not land, with the reason an operator can read back. `hostile`
 * marks the refusals that are an attempt to poison the agent's memory rather than a
 * mistake — the caller raises the event's level on those, so a recorded attack doesn't
 * read the same as a typo'd target. */
export interface DroppedOp {
  op: KnowledgeOp;
  why: string;
  hostile?: true;
}

/** Whether `capped` — a `DroppedOp`'s copy of an op, with its long fields truncated — is the
 * refusal of `op`. Identity never matches (the copy is rebuilt), and the truncation means the
 * heads are what still identify it. */
function isDroppedCopyOf(capped: KnowledgeOp, op: KnowledgeOp): boolean {
  const headMatches = (full: string, head: string): boolean =>
    head.endsWith('…') ? full.startsWith(head.slice(0, -1)) : full === head;
  return (
    capped.op === op.op &&
    capped.section === op.section &&
    headMatches(op.text, capped.text) &&
    headMatches(op.target, capped.target)
  );
}

/** Bullet text without any `(confirmed …)` stamp — what `update` matches on, so
 * re-confirming a rule doesn't make its own earlier stamp a mismatch. Every occurrence
 * goes, not just a trailing one, and each leaves a single space behind so removing one
 * from mid-sentence doesn't run two words together. */
function withoutStamp(text: string): string {
  return text.replace(STAMP_RE, ' ').trim();
}

/**
 * Bullet text stamped with `today`. Any stamp the model wrote itself is replaced rather
 * than kept: the stamp means "this run confirmed it", and a model-chosen date is either
 * today's (no difference) or a claim about a run that isn't this one.
 */
function stamped(text: string, today: string): string {
  return `${withoutStamp(text)} (confirmed ${today})`;
}

/**
 * What this run has earned the right to write, in the model's own terms. A verified file is
 * the strongest evidence and opens everything. A run that only read a search listing has
 * still seen the search work, first-hand — that is exactly the fact `## Search` is for, and
 * gating it on a download meant a site whose search the agent had figured out three times
 * over could never write it down. A run that saw neither has nothing to describe.
 */
function protocolPermission(verifiedSuccess: boolean, searchObserved: boolean): string {
  if (verifiedSuccess) {
    return 'This run verifiably succeeded: it produced a usable subtitle file. Access, Search and Download are open to you.';
  }
  if (searchObserved) {
    return 'This run produced no subtitle file, but it did get search results back from the site. Access, Search and Download are open to you for what this run actually OBSERVED — how the page was reached, how the search was made, what came back. A download route nobody took is not something this run observed.';
  }
  return 'This run did NOT produce a usable subtitle file, and never got search results back. Nothing here proves how the site works, so add/update against Access, Search and Download will be refused. Pitfalls is still open, if there is a rule worth writing.';
}

function isAgentSection(section: string): section is KnowledgeSection {
  return (AGENT_SECTIONS as readonly string[]).includes(section);
}

/** Protocol sections — the ones a run has to have observed the site working to write: a
 * download, or at least a search listing it got back. `Pitfalls` is deliberately not here:
 * a failure is exactly the evidence a pitfall records. */
const PROTOCOL_SECTIONS: readonly KnowledgeSection[] = ['Access', 'Search', 'Download'];

/** Deep-enough copy for operation application: `sections` is rebuilt so the caller's
 * knowledge object is never mutated, `operatorNotes` rides along as the same string. */
function cloneKnowledge(k: SiteKnowledge): SiteKnowledge {
  return {
    ...k,
    sections: {
      Access: [...k.sections.Access],
      Search: [...k.sections.Search],
      Download: [...k.sections.Download],
      Pitfalls: [...k.sections.Pitfalls],
    },
  };
}

/**
 * Applies delta operations to one site's knowledge, one bullet at a time. Bullets no
 * operation names come out byte-exact, and there is no operation that rewrites the file:
 * wholesale rewriting is the mechanism measured collapsing a context file below its
 * no-memory baseline (see the design note), so it isn't offered. There is also no operation
 * that deletes: the operator ruled that the reflection agent has no deletion authority at
 * all — websites are stable skeletons, a correction is `update`'s job (one bullet absorbs
 * what mattered from another, or is shortened), and only the operator deletes a bullet, via
 * the dashboard's Knowledge view.
 *
 * Every refusal is returned in `dropped` with a reason rather than silently discarded, and
 * one dropped operation never costs its siblings. The checks, per operation, in order:
 *
 * 0. Anything past `MAX_OPS` is dropped unread, bounding what one response can do to the
 *    file. Bullet length itself is not capped: the only bound on size is
 *    `KNOWLEDGE_CHAR_CAP` across the agent sections, checked after the whole batch applies.
 * 1. A section outside `AGENT_SECTIONS` — `## Operator notes` above all, but also any name
 *    a model invented — is refused. The schema's enum cannot even express the operator
 *    section, so a well-formed response never reaches this; it is here because a schema is
 *    a contract with a cooperative model, not a security boundary.
 * 2. `allowProtocol` false refuses `add`/`update` against `Access`/`Search`/`Download`.
 *    Agents that wrote protocol lessons regardless of outcome scored worse than agents with
 *    no memory at all, so those writes need a verified success behind them. `Pitfalls` stays
 *    open either way.
 * 3. The text may not forge file structure (`FORGERY_CHECKS`) and is scanned at `'strict'`
 *    before it can land. Stored knowledge is replayed into a later system prompt, so a
 *    bullet is the one place an injection gets to persist past the page it came from.
 *    Both of these checks (forgery and scan) run against the STAMPED, de-stuffed
 *    candidate (`stamped(op.text, today)`, the exact bytes that get stored), not
 *    against the raw `op.text`. `withoutStamp` deletes every `(confirmed YYYY-MM-DD)` found
 *    anywhere in the text before the real stamp is appended, so a fake stamp buried in the
 *    op is free padding at validation time — enough of it pushes a match past a
 *    length-bounded scanner gap or hides a forged heading/bullet marker behind text that
 *    never survives to the file. Validating what actually gets written closes that gap.
 * 4. An `add` whose text already exists in the section is refused, and so is an `update`
 *    whose result would. Two identical bullets make every later `update` on that text
 *    ambiguous, so a duplicate is not merely noise: it permanently locks both copies in
 *    place until the operator prunes one from the dashboard.
 * 5. `update` matches on exact bullet text ignoring stamps. Zero matches or more than one is
 *    a dropped operation — guessing which of two similar bullets the model meant is how the
 *    wrong rule gets overwritten.
 *
 * Operations apply in order against the running result, so a later one sees an earlier
 * one's effect (an `add` followed by an `update` of the same text works).
 */
export function applyOps(
  k: SiteKnowledge,
  ops: KnowledgeOp[],
  opts: {
    allowProtocol: boolean;
    today: string;
  },
): { knowledge: SiteKnowledge; dropped: DroppedOp[] } {
  const knowledge = cloneKnowledge(k);
  const dropped: DroppedOp[] = [];
  // The refused op is quoted back into the `subtitle.knowledge-dropped` event, which streams
  // over SSE and renders in the dashboard. `op.text`/`op.target` are raw model output with no
  // length bound of their own: a single refused op can be 50KB, and MAX_DROPPED_REPORTED of
  // them would put a half-megabyte in one event row. Truncate each here so the reported op is
  // bounded.
  const capField = (s: string): string =>
    s.length <= DROPPED_FIELD_CAP ? s : `${s.slice(0, DROPPED_FIELD_CAP)}…`;
  const drop = (op: KnowledgeOp, why: string, hostile?: true): void => {
    const capped: KnowledgeOp = { ...op, text: capField(op.text), target: capField(op.target) };
    dropped.push(hostile ? { op: capped, why, hostile } : { op: capped, why });
  };

  for (const [i, op] of ops.entries()) {
    if (i >= MAX_OPS) {
      drop(op, `over the ${MAX_OPS}-operation limit for one reflection`);
      continue;
    }

    const section = op.section as string;
    if (!isAgentSection(section)) {
      drop(op, `"${section}" is not an agent-writable section — the operator section is not writable`);
      continue;
    }

    const isProtocol = PROTOCOL_SECTIONS.includes(section);
    if (isProtocol && !opts.allowProtocol) {
      drop(op, `this run may not ${op.op} protocol knowledge in ${section}`);
      continue;
    }

    // The candidate is what actually lands in the file if this op is accepted — every
    // validation below runs against THESE bytes, not the raw `op.text`, so a fake
    // `(confirmed ...)` stamp buried in the op can't pad past a scanner gap or hide a
    // forged heading/marker behind text that `withoutStamp` deletes before storage (C-01).
    const text = withoutMarker(op.text);
    if (withoutStamp(text) === '') {
      drop(op, `${op.op} with no bullet text`);
      continue;
    }
    const candidate = stamped(text, opts.today);
    const forgery = FORGERY_CHECKS.find((check) => check.test.test(candidate));
    if (forgery) {
      drop(op, forgery.why, forgery.hostile);
      continue;
    }
    if (scanForThreats(candidate, 'strict').length > 0) {
      drop(op, 'injection patterns in bullet', true);
      continue;
    }
    /** Whether the section already holds this bullet, ignoring the bullet at `exclude` —
     * which for an `update` is the one being replaced, since a rule matching only itself is
     * a re-confirmation and not a duplicate. */
    const duplicates = (text: string, exclude?: number): boolean =>
      knowledge.sections[section].some((bullet, index) => index !== exclude && withoutStamp(bullet) === text);

    if (op.op === 'add') {
      if (duplicates(withoutStamp(text))) {
        drop(op, `${section} already has this bullet`);
        continue;
      }
      knowledge.sections[section].push(candidate);
      continue;
    }

    const wanted = withoutStamp(withoutMarker(op.target));
    if (wanted === '') {
      drop(op, `${op.op} with no target bullet`);
      continue;
    }
    const matches = knowledge.sections[section]
      .map((bullet, index) => ({ bullet, index }))
      .filter(({ bullet }) => withoutStamp(bullet) === wanted);

    if (matches.length === 0) {
      drop(op, `no match in ${section} for the target bullet`);
      continue;
    }
    if (matches.length > 1) {
      drop(op, `ambiguous target: ${matches.length} bullets in ${section} match it`);
      continue;
    }

    const { index } = matches[0]!;
    // Same reason an `add` is deduped, reached through the other door: an `update` that
    // rewrites one bullet into the text of another leaves two identical bullets, and from
    // then on every `update` naming that text is ambiguous, so neither copy can be edited
    // again except by the operator.
    if (duplicates(withoutStamp(text), index)) {
      drop(op, `${section} already has this bullet`);
      continue;
    }
    knowledge.sections[section][index] = candidate;
  }

  return { knowledge, dropped };
}

/** The transcript as `action: detail` lines, most recent steps only and each detail capped
 * — a long run must not be able to push the file itself out of the prompt. */
function renderTranscript(transcript: TranscriptEntry[]): string {
  const recent = transcript.slice(-MAX_TRANSCRIPT_LINES);
  if (recent.length === 0) return '(no steps recorded)';
  return recent
    .map((e) => `[${e.tier}] ${e.action}: ${e.detail.slice(0, DETAIL_CAP)}`)
    .join('\n');
}

function buildSystemPrompt(input: {
  site: SubtitleSiteConfig;
  knowledge: SiteKnowledge;
  verifiedSuccess: boolean;
  searchObserved: boolean;
  today: string;
}): string {
  const { site, knowledge, verifiedSuccess, searchObserved, today } = input;
  return [
    `You keep the notes on ${site.baseUrl} for an agent that searches it for subtitle files. A run just finished. Decide what, if anything, the notes should now say.`,
    '',
    // The whole file, operator half included: `update` targets are copied from here rather
    // than remembered, and the operator's rules are what the agent's own have to stay
    // consistent with.
    // Fenced with `~~~`, not backticks: operator notes are free text a human wrote, and a
    // code sample in them would close a backtick fence early and spill the rest of the file
    // out of the block.
    'The notes file as it stands:',
    '~~~markdown',
    renderKnowledge(knowledge),
    '~~~',
    '',
    'What each section is for:',
    '- Access: getting a page at all — which fetch tier works, what the site does to unknown clients.',
    '- Search: finding candidates — the search URL shape, parameters, how results are laid out.',
    '- Download: turning a candidate into a file — the link or endpoint that serves the archive.',
    '- Pitfalls: what goes wrong and what to do about it.',
    '- Operator notes: written by a human, authoritative, and not yours to edit. No operation may target it.',
    '',
    'Bullets are conditional rules: "IF <observable condition> THEN <action>." A conditional can be proved wrong on the next run; "the search is flaky" cannot. The file above renders each bullet with a leading `- `, which is not part of the rule: write `text` and `target` without it (one leading marker is stripped for you if you include it anyway). One rule per bullet, on a single line: `text` carrying a line break, a heading, or a further bullet marker is refused. Do not write the date yourself — every bullet you add or update is stamped `(confirmed ' +
      today +
      ')` for you.',
    '',
    'A Pitfall that this run and an earlier one both confirmed, and that describes how to search the site rather than what went wrong, belongs in `## Search` instead: update it into a step ("POST the search form at /search.php with formhash from the page"), not an IF/THEN about a failure.',
    '',
    'The file is a set of distinct facts, one bullet per fact — not a log of edits. Before writing anything, check what this run observed against the facts already on file: same endpoint, same failure mode, same page behavior as an existing bullet means that fact is already covered, even if the condition or the conclusion has changed since. Covered is an update, always — correcting a bullet this run showed wrong, refreshing the date on a bullet this run relied on and found still true, or folding one bullet into another that overlaps it (leave the now-redundant one for the operator to prune). `add` is only for a subject the file has never described. When in doubt, update: a lazy add next to a near-duplicate just sits there, since nothing here can delete it.',
    '',
    'Operations:',
    '- add: a new bullet in a section, for a fact not already covered.',
    '- update: replace one existing bullet. `target` must be an existing bullet copied exactly, its stamp optional.',
    'A target that matches no bullet, or more than one, is discarded rather than guessed at.',
    '',
    'There is no delete operation. You cannot remove a bullet — only the operator can, from the dashboard. If a bullet is wrong, correct it with update; if two bullets overlap, update one to absorb the other and leave the redundant one alone.',
    '',
    // No push to write something on a run that saw nothing: that is the run most likely to
    // have been fed attacker-chosen page text, and "write what went wrong" is an invitation
    // to copy it into the file.
    protocolPermission(verifiedSuccess, searchObserved),
    '',
    'Two rules about honesty, and they matter more than the volume of what you write:',
    '- Do not write a sequence of failed attempts up as a recommended approach. Something that did not work is a pitfall, never a protocol.',
    '- Returning zero operations is a perfectly good outcome. Most runs teach nothing new, and a note nobody learned is worse than no note: it costs the next run prompt space and can send it the wrong way. Write only what you would bet on next time.',
    '',
    'Also return a verdict on the site itself:',
    '- usable: automation can get through, whether or not this particular run found a file.',
    '- transient-failure: a timeout, a rate limit, a mirror that was down — nothing structural.',
    '- unusable: automation cannot get through at all — a hard bot wall, a captcha, a login requirement, or connection failures that keep recurring. This one is shown to a human, so use it only with evidence from this run behind it.',
    '',
    'Respond with JSON matching the schema — no prose outside the JSON.',
  ].join('\n');
}

/**
 * One reflection call per site run: the model sees the site's current notes, the run's
 * transcript and its outcome, and answers with delta operations plus a verdict on the site.
 * Operations are applied and the file saved — unless the result would break the ceiling, in
 * which case the previous file stands. Nothing here ever deletes a bullet: the `(confirmed
 * YYYY-MM-DD)` stamp is the only signal of age, refreshed whenever a bullet is re-confirmed
 * or updated, and it is the operator's to act on from the dashboard.
 *
 * Always returns a `stop`, and a verdict only when the model actually produced one. Two
 * endings change nothing and are reported differently: the `site-notes` call-site is
 * unconfigured, which is the off switch and is quiet (`skipped`), or anything past that point
 * failed — the generate call, the notes file read, the save — which is a warning. The
 * off-switch check runs before any file I/O so it stays quiet even when the site's notes path
 * itself is unreadable. Every failure after it, whatever raised it, is caught here: this
 * function is the caller's whole contract for "reflection never fails a job," so nothing it
 * does may propagate.
 */
export async function reflectOnRun(input: {
  ctx: AppContext;
  job: JobRow;
  site: SubtitleSiteConfig;
  transcript: TranscriptEntry[];
  /** The pipeline's own oracle: this run produced at least one usable subtitle file for
   * this site. Opens every protocol section. */
  verifiedSuccess: boolean;
  /** The run read at least one search result page. Weaker evidence than a file, and enough
   * for the sections describing how the site is reached and searched. */
  searchObserved: boolean;
  today: string;
  /** Overrides `defaultSeedsDir()`, as in `searchSite` — tests point it at a fixture. */
  seedsDir?: string;
}): Promise<ReflectionResult> {
  const { ctx, job, site, transcript, verifiedSuccess, searchObserved, today } = input;
  const label = siteLabel(site.baseUrl);

  try {
    // Before any provider work: no model configured is how self-learning stays off (along
    // with every other LLM feature), and `resolveModel` is the only thing that can tell
    // that apart from a call that was configured and failed. Both throw `LlmError` out of
    // `generate`.
    resolveModel(ctx.config);
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    const stop: StopReason = { kind: 'skipped', why: 'no-model' };
    ctx.events.append({
      kind: 'subtitle.knowledge-skipped',
      jobId: job.id,
      message: `No knowledge update for ${label}: ${describeStop(stop)}`,
      data: targetEventData(job, { site: label, stop }),
    });
    return { stop };
  }

  try {
    // With the seeds dir, same as the reader in `searchSite`: reflection normally runs
    // after a search that already copied the seed in, but if it ever runs first, saving
    // without the seed would leave a local file behind and the seed would never be copied
    // again. Inside this guard because an unreadable notes file (bad permissions, a
    // directory where the file should be) is exactly the kind of failure this function
    // promises never to let escape.
    // The version is captured here, before the provider round trip below — an operator PUT
    // landing in that window (G2) must be caught by the save's compare-and-swap rather than
    // silently overwritten by whatever this reflection decides to write.
    const { knowledge, version } = loadKnowledgeWithVersion(ctx.dataDir, site.baseUrl, input.seedsDir ?? defaultSeedsDir());

    const reflection = await ctx.llm.generate({
      callsite: REFLECT_CALLSITE,
      schema: ReflectionSchema,
      system: buildSystemPrompt({ site, knowledge, verifiedSuccess, searchObserved, today }),
      prompt: [
        `Run outcome: ${verifiedSuccess ? 'a usable subtitle file was produced' : 'no usable subtitle file was produced'}.`,
        '',
        'Steps taken:',
        renderTranscript(transcript),
      ].join('\n'),
      trace: { jobId: job.id },
    });

    const { knowledge: applied, dropped } = applyOps(knowledge, reflection.ops, {
      allowProtocol: verifiedSuccess || searchObserved,
      today,
    });
    const appliedCount = reflection.ops.length - dropped.length;

    if (dropped.length > 0) {
      const hostile = dropped.some((d) => d.hostile);
      ctx.events.append({
        kind: 'subtitle.knowledge-dropped',
        // A bullet that tried to forge structure or carried an injection is a recorded
        // attempt to poison the agent's memory — the one thing here a human should see. An
        // ordinary refusal (a typo'd target, a section that was closed) stays a warning.
        level: hostile ? 'attention' : 'warn',
        jobId: job.id,
        message: hostile
          ? `${dropped.length} knowledge edit(s) for ${label} were refused, including one that tried to tamper with the notes file`
          : `${dropped.length} knowledge edit(s) for ${label} were refused`,
        data: targetEventData(job, {
          site: label,
          droppedCount: dropped.length,
          dropped: dropped.slice(0, MAX_DROPPED_REPORTED),
        }),
      });
    }

    if (appliedCount === 0) {
      // Nothing changed, so nothing is written: a no-op run leaves the file — and its
      // single `.bak` — exactly as it found them.
      ctx.trace.event({
        jobId: job.id,
        kind: 'knowledge.unchanged',
        summary: `${label}: nothing to write`,
        payload: () => ({ ops: reflection.ops.length, dropped: dropped.length, reason: 'no-op' }),
      });
      return { stop: { kind: 'done' }, verdict: reflection.verdict, reason: reflection.reason };
    }

    const size = agentCharCount(applied);
    if (size > KNOWLEDGE_CHAR_CAP) {
      // Not truncated: cutting markdown to fit corrupts a file that was fine, and the old
      // file is still a working one. The next run sees the same over-full file and can
      // consolidate it with `update` operations of its own.
      ctx.events.append({
        kind: 'subtitle.knowledge-overflow',
        level: 'warn',
        jobId: job.id,
        message: `Knowledge update for ${label} dropped — it would reach ${size} chars, over the ${KNOWLEDGE_CHAR_CAP} cap`,
        data: targetEventData(job, { site: label, size, cap: KNOWLEDGE_CHAR_CAP }),
      });
      ctx.trace.event({
        jobId: job.id,
        kind: 'knowledge.unchanged',
        summary: `${label}: over cap, not written`,
        payload: () => ({ ops: reflection.ops.length, dropped: dropped.length, reason: 'overflow' }),
      });
      return { stop: { kind: 'done' }, verdict: reflection.verdict, reason: reflection.reason };
    }

    try {
      saveKnowledge(ctx.dataDir, { ...applied, updated: today }, version);
    } catch (err) {
      if (!(err instanceof KnowledgeConflictError)) throw err;
      // Someone else — almost always an operator's dashboard PUT — wrote the file in the
      // window between the load above and this save (a provider round trip wide). This
      // run's edits are dropped rather than overwriting whatever they just saved: the
      // operator's file wins, and the next reflection sees it and can re-derive whatever
      // this run would have written.
      ctx.events.append({
        kind: 'subtitle.knowledge-conflict',
        level: 'warn',
        jobId: job.id,
        message: `Site knowledge for ${label} was edited elsewhere while this run's reflection was in progress; its edits were dropped rather than overwrite that change`,
        data: targetEventData(job, { site: label }),
      });
      return { stop: { kind: 'done' }, verdict: reflection.verdict, reason: reflection.reason };
    }
    ctx.trace.event({
      jobId: job.id,
      kind: 'knowledge.update',
      sideEffect: true,
      summary: `${label}: ${appliedCount} edit(s) applied, ${dropped.length} refused`,
      payload: () => ({
        applied: reflection.ops.filter((op) => !dropped.some((d) => isDroppedCopyOf(d.op, op))),
        dropped,
      }),
    });
    ctx.events.append({
      kind: 'subtitle.knowledge-updated',
      jobId: job.id,
      message: `Site knowledge for ${label} updated (${appliedCount} edit(s))`,
      data: targetEventData(job, {
        site: label,
        applied: appliedCount,
        droppedCount: dropped.length,
        dropped: dropped.slice(0, MAX_DROPPED_REPORTED),
      }),
    });

    return { stop: { kind: 'done' }, verdict: reflection.verdict, reason: reflection.reason };
  } catch (err) {
    // The call-site resolved a moment ago, so this is a configured feature failing — a
    // provider outage, a timeout, a response that didn't match the schema, or a filesystem
    // error reading/saving the notes file. Worth a warning: left alone it would silently
    // learn nothing, run after run.
    const stop = stopFromError(err);
    ctx.events.append({
      kind: 'subtitle.knowledge-failed',
      level: 'warn',
      jobId: job.id,
      message: `Knowledge update for ${label} failed: ${describeStop(stop)}`,
      data: targetEventData(job, { site: label, stop }),
    });
    return { stop };
  }
}
