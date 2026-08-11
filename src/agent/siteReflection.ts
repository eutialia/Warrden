import { z } from 'zod';
import { siteLabel } from '../config/siteLabel.js';
import type { SubtitleSiteConfig } from '../config/schema.js';
import type { AppContext } from '../context.js';
import type { TranscriptEntry } from '../db/subtitleRuns.js';
import { targetEventData } from '../events/target.js';
import type { JobRow } from '../jobs/queue.js';
import { LlmError } from '../llm/generator.js';
import { errorMessage } from '../util/errors.js';
import {
  AGENT_SECTIONS,
  KNOWLEDGE_CHAR_CAP,
  agentCharCount,
  loadKnowledge,
  pruneStale,
  renderKnowledge,
  saveKnowledge,
  type KnowledgeSection,
  type SiteKnowledge,
} from './siteKnowledge.js';
import { scanForThreats } from './threatPatterns.js';

/** The call-site reflection resolves against. Leaving it out of the active LLM profile is
 * the off switch for self-learning: `resolveModel` throws `LlmError`, `reflectOnRun`
 * catches exactly that and the run finishes with the site's file untouched. */
export const REFLECT_CALLSITE = 'site-notes';

/** What the run says about the site itself, independent of whether anything was learned. */
export type SiteVerdict = 'usable' | 'transient-failure' | 'unusable';

/** Most recent transcript steps handed to the model. A run is bounded by the step budget
 * already; this bounds the prompt against a budget an operator raised. */
const MAX_TRANSCRIPT_LINES = 40;

/** Per-step detail cap. Details carry page text, which is attacker-chosen and unbounded. */
const DETAIL_CAP = 300;

/** Trailing `(confirmed YYYY-MM-DD)` stamp, with the whitespace before it. */
const STAMP_RE = /\s*\(confirmed \d{4}-\d{2}-\d{2}\)\s*$/;

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

/** One operation that did not land, with the reason an operator can read back. */
export interface DroppedOp {
  op: KnowledgeOp;
  why: string;
}

/** Bullet text without its `(confirmed …)` stamp — what `update`/`remove` match on, so
 * re-confirming a rule doesn't make its own earlier stamp a mismatch. */
function withoutStamp(text: string): string {
  return text.replace(STAMP_RE, '').trim();
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
 * 1. A section outside `AGENT_SECTIONS` — `## Operator notes` above all, but also any name
 *    a model invented — is refused. The schema's enum cannot even express the operator
 *    section, so a well-formed response never reaches this; it is here because a schema is
 *    a contract with a cooperative model, not a security boundary.
 * 2. `allowProtocol` false refuses `add`/`update` against `Access`/`Search`/`Download`.
 *    Agents that wrote protocol lessons after every run, successful or not, scored worse
 *    than agents with no memory at all, so those writes need a verified success behind
 *    them. `remove` still applies: a run that failed *because* a rule is wrong is the
 *    evidence that retires it, and `Pitfalls` stays open either way.
 * 3. The new bullet is scanned at `'strict'` before it can land. Stored knowledge is
 *    replayed into a later system prompt, so a bullet is the one place an injection gets to
 *    persist past the page it came from.
 * 4. `update`/`remove` match on exact bullet text ignoring a trailing stamp. Zero matches
 *    or more than one is a dropped operation — guessing which of two similar bullets the
 *    model meant is how the wrong rule gets deleted.
 *
 * Operations apply in order against the running result, so a later one sees an earlier
 * one's effect (an `add` followed by an `update` of the same text works).
 */
export function applyOps(
  k: SiteKnowledge,
  ops: KnowledgeOp[],
  opts: { allowProtocol: boolean; today: string },
): { knowledge: SiteKnowledge; dropped: DroppedOp[] } {
  const knowledge = cloneKnowledge(k);
  const dropped: DroppedOp[] = [];
  const drop = (op: KnowledgeOp, why: string): void => {
    dropped.push({ op, why });
  };

  for (const op of ops) {
    const section = op.section as string;
    if (!isAgentSection(section)) {
      drop(op, `"${section}" is not an agent-writable section — the operator section is not writable`);
      continue;
    }

    const isProtocol = PROTOCOL_SECTIONS.includes(section);
    if (!opts.allowProtocol && isProtocol && op.op !== 'remove') {
      drop(op, `unverified run may not ${op.op} protocol knowledge in ${section}`);
      continue;
    }

    if (op.op !== 'remove') {
      if (withoutStamp(op.text) === '') {
        drop(op, `${op.op} with no bullet text`);
        continue;
      }
      if (scanForThreats(op.text, 'strict').length > 0) {
        drop(op, 'injection patterns in bullet');
        continue;
      }
    }

    if (op.op === 'add') {
      knowledge.sections[section].push(stamped(op.text, opts.today));
      continue;
    }

    const wanted = withoutStamp(op.target);
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
    'The notes file as it stands:',
    '```markdown',
    renderKnowledge(knowledge),
    '```',
    '',
    'What each section is for:',
    '- Access: getting a page at all — which fetch tier works, what the site does to unknown clients.',
    '- Search: finding candidates — the search URL shape, parameters, how results are laid out.',
    '- Download: turning a candidate into a file — the link or endpoint that serves the archive.',
    '- Pitfalls: what goes wrong and what to do about it.',
    '- Operator notes: written by a human, authoritative, and not yours to edit. No operation may target it.',
    '',
    'Bullets are conditional rules: "IF <observable condition> THEN <action>." A conditional can be proved wrong on the next run; "the search is flaky" cannot. One rule per bullet. Do not write the date yourself — every bullet you add or update is stamped `(confirmed ' +
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
      : 'This run did NOT produce a usable subtitle file. Nothing here proves how the site works, so add/update against Access, Search and Download will be refused. Write what went wrong in Pitfalls instead.',
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
 * Returns `null`, having changed nothing, when the `site-notes` call-site is unconfigured
 * (or the call fails): reflection is opt-in, and an install that never configured it must
 * keep working exactly as before rather than take a failure per run.
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
}): Promise<{ verdict: SiteVerdict; reason: string } | null> {
  const { ctx, job, site, transcript, verifiedSuccess, today } = input;
  const label = siteLabel(site.baseUrl);
  const knowledge = loadKnowledge(ctx.dataDir, site.baseUrl);

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
    // Not a warning: an unconfigured call-site is how self-learning stays off, and this is
    // also where a failed call lands — either way the site's file is simply left alone.
    ctx.events.append({
      kind: 'subtitle.knowledge-skipped',
      jobId: job.id,
      message: `No knowledge update for ${label}: ${errorMessage(err)}`,
      data: targetEventData(job, { site: label }),
    });
    return null;
  }

  const { knowledge: applied, dropped } = applyOps(knowledge, reflection.ops, {
    allowProtocol: verifiedSuccess,
    today,
  });
  const appliedCount = reflection.ops.length - dropped.length;

  if (dropped.length > 0) {
    ctx.events.append({
      kind: 'subtitle.knowledge-dropped',
      level: 'warn',
      jobId: job.id,
      message: `${dropped.length} knowledge edit(s) for ${label} were refused`,
      data: targetEventData(job, { site: label, dropped }),
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
      data: targetEventData(job, { site: label, size, cap: KNOWLEDGE_CHAR_CAP, dedupeKey: label }),
    });
    return { verdict: reflection.verdict, reason: reflection.reason };
  }

  saveKnowledge(ctx.dataDir, { ...pruned, updated: today });
  ctx.events.append({
    kind: 'subtitle.knowledge-updated',
    jobId: job.id,
    message: `Site knowledge for ${label} updated (${appliedCount} edit(s), ${prunedCount} stale bullet(s) pruned)`,
    data: targetEventData(job, { site: label, applied: appliedCount, dropped, pruned: prunedCount }),
  });

  return { verdict: reflection.verdict, reason: reflection.reason };
}
