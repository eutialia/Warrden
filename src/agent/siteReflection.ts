import { z } from 'zod';
import { siteLabel } from '../config/siteLabel.js';
import type { SubtitleSiteConfig } from '../config/schema.js';
import type { AppContext } from '../context.js';
import type { TranscriptEntry } from '../db/subtitleRuns.js';
import { targetEventData } from '../events/target.js';
import type { JobRow } from '../jobs/queue.js';
import { LlmError, resolveModel } from '../llm/generator.js';
import { errorMessage } from '../util/errors.js';
import {
  AGENT_SECTIONS,
  KNOWLEDGE_CHAR_CAP,
  agentCharCount,
  defaultSeedsDir,
  loadKnowledge,
  pruneStale,
  renderKnowledge,
  saveKnowledge,
  type KnowledgeSection,
  type SiteKnowledge,
} from './siteKnowledge.js';
import { scanForThreats } from './threatPatterns.js';

/** The call-site reflection resolves against. Leaving it out of the active LLM profile is
 * the off switch for self-learning: `reflectOnRun` resolves it before anything else and,
 * finding nothing, finishes quietly with the site's file untouched. */
export const REFLECT_CALLSITE = 'site-notes';

/** What the run says about the site itself, independent of whether anything was learned. */
export type SiteVerdict = 'usable' | 'transient-failure' | 'unusable';

/** Most recent transcript steps handed to the model. A run is bounded by the step budget
 * already; this bounds the prompt against a budget an operator raised. */
const MAX_TRANSCRIPT_LINES = 40;

/** Per-step detail cap. Details carry page text, which is attacker-chosen and unbounded. */
const DETAIL_CAP = 300;

/** Operations honoured from one reflection. A run that learned twenty separate rules did
 * not learn twenty rules; the tail is dropped rather than applied, which also bounds what
 * one response can do to the file and to the event it is reported in. */
const MAX_OPS = 20;

/** Longest a single bullet (or a target) may be. A rule is one sentence; anything far
 * longer is prose, and unbounded model text is what fills the file's ceiling in one go. */
const MAX_BULLET_CHARS = 400;

/** Refused operations carried in an event's `data`. The rest are counted, not quoted. */
const MAX_DROPPED_REPORTED = 10;

/** Any `(confirmed YYYY-MM-DD)` stamp with the whitespace around it, anywhere in the text
 * — not just a trailing one. A stamp buried mid-bullet survives a trailing-only strip and
 * then wins, because `pruneStale` reads the FIRST match: `IF x (confirmed 2099-01-01)
 * THEN y.` would be immune to decay forever. */
const STAMP_RE = /\s*\(confirmed \d{4}-\d{2}-\d{2}\)\s*/g;

/** Bullet text that would forge file structure once rendered, mapped to why it's refused.
 * `renderKnowledge` writes a bullet as `- ${text}` with no escaping, so any of these turn
 * one operation into markdown the next `parseKnowledge` reads as something else entirely:
 * a newline can open a `## Operator notes` heading (whose contents are trusted, exempt
 * from scanning, and injected as authoritative), or a protocol section an unverified run
 * may not write, or simply more bullets than the one operation being applied. The parser
 * was made strict at exactly these boundaries; the writer must not be able to forge them
 * from the other side. */
const FORGERY_CHECKS: readonly { test: RegExp; why: string }[] = [
  { test: /[\r\n]/, why: 'line break in bullet text — a bullet is one line' },
  { test: /^#{1,6}\s/, why: 'bullet text starts a markdown heading' },
  { test: /^-\s/, why: 'bullet text starts a markdown bullet marker' },
];

/**
 * Flat root object, every field REQUIRED — the same strict-mode constraint documented on
 * `AgentActionSchema` in `loop.ts`: `.optional()`/`.default()` drop a field from the JSON
 * schema's `required` array and OpenAI's strict mode rejects the schema outright. So the
 * absent value is a `''` sentinel instead: `text` is '' for `remove`, `target` is '' for
 * `add`, and `applyOps` reads '' as "not given".
 */
export const KnowledgeOpSchema = z.object({
  op: z.enum(['add', 'update', 'remove']).describe('what to do with one bullet'),
  section: z.enum(['Access', 'Search', 'Download', 'Pitfalls']).describe('which section the bullet belongs to'),
  text: z.string().describe('the new bullet as an IF/THEN rule; empty string for remove'),
  target: z.string().describe('the exact existing bullet to update or remove; empty string for add'),
});

export type KnowledgeOp = z.infer<typeof KnowledgeOpSchema>;

export const ReflectionSchema = z.object({
  verdict: z.enum(['usable', 'transient-failure', 'unusable']).describe('whether this site can be automated at all'),
  reason: z.string().describe('one sentence of evidence for the verdict'),
  ops: z.array(KnowledgeOpSchema).describe('bullet edits; an empty list is a fine outcome'),
});

export type Reflection = z.infer<typeof ReflectionSchema>;

/** One operation that did not land, with the reason an operator can read back. `hostile`
 * marks the refusals that are an attempt to poison the agent's memory rather than a
 * mistake — the caller raises the event's level on those, so a recorded attack doesn't
 * read the same as a typo'd target. */
export interface DroppedOp {
  op: KnowledgeOp;
  why: string;
  hostile?: true;
}

/** Bullet text without any `(confirmed …)` stamp — what `update`/`remove` match on, so
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

function isAgentSection(section: string): section is KnowledgeSection {
  return (AGENT_SECTIONS as readonly string[]).includes(section);
}

/** Protocol sections — the ones a run has to have actually succeeded to write. `Pitfalls`
 * is deliberately not here: a failure is exactly the evidence a pitfall records. */
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
 * no-memory baseline (see the design note), so it isn't offered.
 *
 * Every refusal is returned in `dropped` with a reason rather than silently discarded, and
 * one dropped operation never costs its siblings. The checks, per operation, in order:
 *
 * 0. Anything past `MAX_OPS` is dropped unread, and so is any bullet or target longer than
 *    `MAX_BULLET_CHARS`. Both bound what one response can do — to the file, and to the
 *    event that quotes the refusals back.
 * 1. A section outside `AGENT_SECTIONS` — `## Operator notes` above all, but also any name
 *    a model invented — is refused. The schema's enum cannot even express the operator
 *    section, so a well-formed response never reaches this; it is here because a schema is
 *    a contract with a cooperative model, not a security boundary.
 * 2. `allowProtocol` false refuses `add`/`update` against `Access`/`Search`/`Download`.
 *    Agents that wrote protocol lessons after every run, successful or not, scored worse
 *    than agents with no memory at all, so those writes need a verified success behind
 *    them. `Pitfalls` stays open either way.
 * 3. `allowProtocolRemove` false refuses `remove` there too. Normally a `remove` survives a
 *    failed run — a run that failed *because* a rule is wrong is the evidence that retires
 *    it — but a run whose own verdict is `transient-failure` has asserted that nothing
 *    structural happened, so it has no evidence about the protocol to retire it with.
 * 4. The text may not forge file structure (`FORGERY_CHECKS`) and is scanned at `'strict'`
 *    before it can land. Stored knowledge is replayed into a later system prompt, so a
 *    bullet is the one place an injection gets to persist past the page it came from.
 * 5. An `add` whose text already exists in the section is refused. Two identical bullets
 *    make every later `update`/`remove` ambiguous, so a duplicate is not merely noise: it
 *    permanently locks both copies in place, with only decay able to retire them.
 * 6. `update`/`remove` match on exact bullet text ignoring stamps. Zero matches or more
 *    than one is a dropped operation — guessing which of two similar bullets the model
 *    meant is how the wrong rule gets deleted.
 *
 * Operations apply in order against the running result, so a later one sees an earlier
 * one's effect (an `add` followed by an `update` of the same text works).
 */
export function applyOps(
  k: SiteKnowledge,
  ops: KnowledgeOp[],
  opts: {
    allowProtocol: boolean;
    /** Whether protocol bullets may be retired. Separate from `allowProtocol` because the
     * two answer to different evidence — see check 3. */
    allowProtocolRemove: boolean;
    today: string;
  },
): { knowledge: SiteKnowledge; dropped: DroppedOp[] } {
  const knowledge = cloneKnowledge(k);
  const dropped: DroppedOp[] = [];
  const drop = (op: KnowledgeOp, why: string, hostile?: true): void => {
    dropped.push(hostile ? { op, why, hostile } : { op, why });
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
    if (isProtocol && (op.op === 'remove' ? !opts.allowProtocolRemove : !opts.allowProtocol)) {
      drop(op, `this run may not ${op.op} protocol knowledge in ${section}`);
      continue;
    }

    if (op.op !== 'remove') {
      if (withoutStamp(op.text) === '') {
        drop(op, `${op.op} with no bullet text`);
        continue;
      }
      if (op.text.length > MAX_BULLET_CHARS) {
        drop(op, `bullet text over ${MAX_BULLET_CHARS} characters`);
        continue;
      }
      const forgery = FORGERY_CHECKS.find((check) => check.test.test(op.text));
      if (forgery) {
        drop(op, forgery.why, true);
        continue;
      }
      if (scanForThreats(op.text, 'strict').length > 0) {
        drop(op, 'injection patterns in bullet', true);
        continue;
      }
    }

    if (op.op === 'add') {
      const text = withoutStamp(op.text);
      if (knowledge.sections[section].some((bullet) => withoutStamp(bullet) === text)) {
        drop(op, `${section} already has this bullet`);
        continue;
      }
      knowledge.sections[section].push(stamped(op.text, opts.today));
      continue;
    }

    const wanted = withoutStamp(op.target);
    if (wanted === '') {
      drop(op, `${op.op} with no target bullet`);
      continue;
    }
    if (op.target.length > MAX_BULLET_CHARS) {
      // No stored bullet can be this long, so this only ever fails to match — but it is
      // quoted back in the dropped event, and that is what needs bounding.
      drop(op, `target text over ${MAX_BULLET_CHARS} characters`);
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
    if (op.op === 'remove') {
      knowledge.sections[section].splice(index, 1);
    } else {
      knowledge.sections[section][index] = stamped(op.text, opts.today);
    }
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
  today: string;
}): string {
  const { site, knowledge, verifiedSuccess, today } = input;
  return [
    `You keep the notes on ${site.baseUrl} for an agent that searches it for subtitle files. A run just finished. Decide what, if anything, the notes should now say.`,
    '',
    // The whole file, operator half included: `update`/`remove` targets are copied from
    // here rather than remembered, and the operator's rules are what the agent's own have
    // to stay consistent with.
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
    'Bullets are conditional rules: "IF <observable condition> THEN <action>." A conditional can be proved wrong on the next run; "the search is flaky" cannot. One rule per bullet, on a single line: text containing a line break, a heading or a bullet marker is refused. Do not write the date yourself — every bullet you add or update is stamped `(confirmed ' +
      today +
      ')` for you.',
    '',
    'Operations:',
    '- add: a new bullet in a section.',
    '- update: replace one existing bullet. `target` must be an existing bullet copied exactly, its stamp optional. Use this to re-confirm a rule this run relied on, which refreshes its date.',
    '- remove: drop one existing bullet, matched the same way. Use it when this run showed the rule to be wrong.',
    'A target that matches no bullet, or more than one, is discarded rather than guessed at.',
    '',
    verifiedSuccess
      ? 'This run verifiably succeeded: it produced a usable subtitle file. Access, Search and Download are open to you.'
      // No push to write something: a failed run is the one most likely to have been fed
      // attacker-chosen page text, and "write what went wrong" is an invitation to copy it
      // into the file.
      : 'This run did NOT produce a usable subtitle file. Nothing here proves how the site works, so add/update against Access, Search and Download will be refused. Pitfalls is still open, if there is a rule worth writing.',
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
 * Operations are applied, stale bullets pruned, and the file saved — unless the result
 * would break the ceiling, in which case the previous file stands.
 *
 * Returns `null`, having changed nothing, in two cases that are reported differently: the
 * `site-notes` call-site is unconfigured, which is the off switch and is quiet, or the
 * call itself failed, which is a warning. Either way the run continues and the site's file
 * is left exactly as it was — reflection is opt-in and never fails a job.
 */
export async function reflectOnRun(input: {
  ctx: AppContext;
  job: JobRow;
  site: SubtitleSiteConfig;
  transcript: TranscriptEntry[];
  /** The pipeline's own oracle: this run produced at least one usable subtitle file for
   * this site. Gates protocol writes, and lets decay judge stale bullets. */
  verifiedSuccess: boolean;
  today: string;
  /** Overrides `defaultSeedsDir()`, as in `searchSite` — tests point it at a fixture. */
  seedsDir?: string;
}): Promise<{ verdict: SiteVerdict; reason: string } | null> {
  const { ctx, job, site, transcript, verifiedSuccess, today } = input;
  const label = siteLabel(site.baseUrl);
  // With the seeds dir, same as the reader in `searchSite`: reflection normally runs after
  // a search that already copied the seed in, but if it ever runs first, saving without
  // the seed would leave a local file behind and the seed would never be copied again.
  const knowledge = loadKnowledge(ctx.dataDir, site.baseUrl, input.seedsDir ?? defaultSeedsDir());

  try {
    // Before any provider work: an unconfigured call-site is how self-learning stays off,
    // and `resolveModel` is the only thing that can tell that apart from a call that was
    // configured and failed. Both throw `LlmError` out of `generate`.
    resolveModel(ctx.config, REFLECT_CALLSITE);
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    ctx.events.append({
      kind: 'subtitle.knowledge-skipped',
      jobId: job.id,
      message: `No knowledge update for ${label}: ${errorMessage(err)}`,
      data: targetEventData(job, { site: label }),
    });
    return null;
  }

  let reflection: Reflection;
  try {
    reflection = await ctx.llm.generate({
      callsite: REFLECT_CALLSITE,
      schema: ReflectionSchema,
      system: buildSystemPrompt({ site, knowledge, verifiedSuccess, today }),
      prompt: [
        `Run outcome: ${verifiedSuccess ? 'a usable subtitle file was produced' : 'no usable subtitle file was produced'}.`,
        '',
        'Steps taken:',
        renderTranscript(transcript),
      ].join('\n'),
    });
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    // The call-site resolved a moment ago, so this is a configured feature failing —
    // a provider outage, a timeout, a response that didn't match the schema. Worth a
    // warning: left alone it would silently learn nothing, run after run.
    ctx.events.append({
      kind: 'subtitle.knowledge-failed',
      level: 'warn',
      jobId: job.id,
      message: `Knowledge update for ${label} failed: ${errorMessage(err)}`,
      data: targetEventData(job, { site: label }),
    });
    return null;
  }

  const { knowledge: applied, dropped } = applyOps(knowledge, reflection.ops, {
    allowProtocol: verifiedSuccess,
    // The verdict is the model's own, so this guards an honest contradiction — a run that
    // reports nothing structural happened while deleting the site's protocol — rather than
    // an adversary, who would simply not report `transient-failure`.
    allowProtocolRemove: reflection.verdict !== 'transient-failure',
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

  const pruned = pruneStale(applied, today, verifiedSuccess);
  const prunedCount = AGENT_SECTIONS.reduce(
    (sum, section) => sum + (applied.sections[section].length - pruned.sections[section].length),
    0,
  );

  if (appliedCount === 0 && prunedCount === 0) {
    // Nothing changed, so nothing is written: a no-op run leaves the file — and its single
    // `.bak` — exactly as it found them.
    return { verdict: reflection.verdict, reason: reflection.reason };
  }

  const size = agentCharCount(pruned);
  if (size > KNOWLEDGE_CHAR_CAP) {
    // Not truncated: cutting markdown to fit corrupts a file that was fine, and the old
    // file is still a working one. The next run sees the same over-full file and can
    // consolidate it with `remove`/`update` operations of its own.
    ctx.events.append({
      kind: 'subtitle.knowledge-overflow',
      level: 'warn',
      jobId: job.id,
      message: `Knowledge update for ${label} dropped — it would reach ${size} chars, over the ${KNOWLEDGE_CHAR_CAP} cap`,
      data: targetEventData(job, { site: label, size, cap: KNOWLEDGE_CHAR_CAP }),
    });
    return { verdict: reflection.verdict, reason: reflection.reason };
  }

  saveKnowledge(ctx.dataDir, { ...pruned, updated: today });
  ctx.events.append({
    kind: 'subtitle.knowledge-updated',
    jobId: job.id,
    message: `Site knowledge for ${label} updated (${appliedCount} edit(s), ${prunedCount} stale bullet(s) pruned)`,
    data: targetEventData(job, {
      site: label,
      applied: appliedCount,
      dropped: dropped.slice(0, MAX_DROPPED_REPORTED),
      pruned: prunedCount,
    }),
  });

  return { verdict: reflection.verdict, reason: reflection.reason };
}
