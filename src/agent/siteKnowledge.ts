import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteKey, siteLabel } from '../config/siteLabel.js';
import { ensureDataSubdir } from '../fs/paths.js';

/**
 * Where seed knowledge files live for a fresh install: `seeds/sites` at the repo root,
 * resolved relative to this module's own location (not `process.cwd()`), the same
 * convention as `db.ts`'s migrations dir and `app.ts`'s web dist dir — this file sits one
 * level under the root at `agent/` whether it's running from `src/` (tsx) or `dist/`
 * (compiled). Cwd resolution looked equivalent and is not: an operator starting the
 * server from anywhere but the app root would get no seeds at all, and silently, since a
 * missing directory is indistinguishable from "this site has no seed" by design —
 * `loadKnowledge` only ever asks whether the file exists, and never throws.
 *
 * It lives beside `loadKnowledge` rather than in one of its callers because every caller
 * needs the same default: a reader that skipped the seed would write a local file over a
 * seed that had never been copied in, and lose it.
 */
export function defaultSeedsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'seeds', 'sites');
}

/** The four sections the browse agent itself reads and rewrites. `Operator notes` is a
 * fifth heading every file also carries, but it is human-owned — the agent never writes
 * to it, so it isn't part of this union. */
export type KnowledgeSection = 'Access' | 'Search' | 'Download' | 'Pitfalls';

export const AGENT_SECTIONS: readonly KnowledgeSection[] = ['Access', 'Search', 'Download', 'Pitfalls'];

/** Ceiling on the agent-owned portion of a knowledge file (Task 4 enforces this). */
export const KNOWLEDGE_CHAR_CAP = 10_000;

/** Longest a single bullet in an agent section may be. A rule is one sentence; anything
 * far longer is prose that belongs in `## Operator notes`, the one section with no length
 * limit. Lives here rather than in `siteReflection.ts` (where it originated, bounding the
 * agent's own delta-op writes) because it is really a property of the file *format* — both
 * the agent's writes and an operator's raw PUT need to hold the same line, and a route
 * under `server/` importing from the LLM-facing reflection module would be the stranger
 * dependency of the two. */
export const MAX_BULLET_CHARS = 400;

/** A bullet older than this, once the site has succeeded again since, is assumed
 * superseded and dropped by `pruneStale`. */
export const STALE_AFTER_DAYS = 90;

/**
 * One site's learned knowledge file, parsed into structure. `sections` holds bullet text
 * with the leading `- ` marker stripped — callers re-add it when rendering. `operatorNotes`
 * is everything below the `## Operator notes` line, held as one opaque string: the exact
 * bytes the human typed, minus at most one trailing newline (the one the heading's own
 * line break re-supplies on render). Nothing inside it is interpreted — not headings, not
 * fences, not bullets — because it is the one part of the file a human writes and the
 * agent must never touch.
 */
export interface SiteKnowledge {
  baseUrl: string;
  updated: string | null;
  sections: Record<KnowledgeSection, string[]>;
  operatorNotes: string;
}

const HEADING_RE = /^##\s+(.+?)\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s/;
const SECTION_HEADING_RE = /^##\s/;
const BULLET_RE = /^-\s(.*)$/;
const UPDATED_RE = /^updated:\s*(.*)$/;
const CONFIRMED_RE = /\(confirmed (\d{4}-\d{2}-\d{2})\)/;
const FENCE_RE = /^```/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The line that hands the rest of the file to the human. Matched case-insensitively, with
 * a variable-width `#{2,6}` run, optional leading indentation, and anything at all after
 * the words (a colon, "(authoritative)", whatever a human typed) so a file written
 * `## Operator Notes`, `## Operator notes:`, `  ## Operator notes`, or `### Operator notes`
 * is still recognized as the operator's. Getting this wrong is not cosmetic: an
 * unrecognized heading is parsed as an unknown agent-half heading, which silently drops the
 * operator's ENTIRE half — the one part of the file a human owns — on the very next save. */
const OPERATOR_HEADING_RE = /^\s*#{2,6}\s+operator\s+notes\b.*$/i;

/** How `renderKnowledge` always spells that heading, whatever case the file used. */
const OPERATOR_HEADING = '## Operator notes';

/** Parses a `YYYY-MM-DD` stamp strictly, rejecting anything `Date.parse` would otherwise
 * silently roll over (a hallucinated `2026-02-30` becomes March 2 under plain
 * `Date.parse`) as well as anything shaped wrong. Returns `null` — never `NaN` — for
 * "can't judge this", so a caller can treat it the same as "no stamp at all" instead of
 * having a bad date silently compare as always-stale. */
function parseStrictDate(stamp: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stamp);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(ms);
  const valid = roundTrip.getUTCFullYear() === year && roundTrip.getUTCMonth() === month - 1 && roundTrip.getUTCDate() === day;
  return valid ? ms : null;
}

/** The local path a site's knowledge file lives at. */
export function knowledgePath(dataDir: string, baseUrl: string): string {
  return join(dataDir, 'sites', `${siteKey(baseUrl)}.md`);
}

/** A knowledge file with nothing learned yet — every fresh site, and the fallback for
 * anything `parseKnowledge` can't make sense of. */
export function emptyKnowledge(baseUrl: string): SiteKnowledge {
  return {
    baseUrl,
    updated: null,
    sections: { Access: [], Search: [], Download: [], Pitfalls: [] },
    operatorNotes: '',
  };
}

/** The name in a `## <name>` heading, or `null` for any other line (including `# title`
 * and `### sub`, whose leading run of `#` is the wrong length). */
function headingName(line: string): string | null {
  const m = HEADING_RE.exec(line);
  return m ? m[1] : null;
}

function agentSection(name: string): KnowledgeSection | null {
  return (AGENT_SECTIONS as readonly string[]).includes(name) ? (name as KnowledgeSection) : null;
}

/**
 * Where the body starts: past the closing `---` of frontmatter, or line 0 when there is
 * none. The search for that closing line stops at the first `## ` section heading, so a
 * `---` horizontal rule further down the body can never be mistaken for it — an unbounded
 * search would take everything above that rule, sections included, as frontmatter and
 * drop it. An unterminated fence therefore parses as "no frontmatter" rather than as
 * "the whole file is frontmatter".
 *
 * The bound is `## ` and not any `#` run, because `#` also starts a YAML comment: bailing
 * on `#{1,6}\s` meant one commented line inside real frontmatter hid the closing `---`
 * and lost the `updated` stamp with it.
 */
function frontmatterEnd(lines: string[]): number {
  if (lines[0] !== '---') return 0;
  for (let i = 1; i < lines.length && !SECTION_HEADING_RE.test(lines[i]); i++) {
    if (lines[i] === '---') return i + 1;
  }
  return 0;
}

/**
 * Which lines in `[from, to)` sit inside a *closed* ``` fence, delimiters included, and so
 * must not be read as structure — a `## Access` in a pasted snippet is an example, not a
 * section.
 *
 * An opener with no closer inside the range is not a fence at all: it masks nothing, so a
 * single unbalanced ``` can't hide every heading below it. The range stops at the operator
 * heading, so no fence in the agent's half of the file can reach into the human's half or
 * pair with a fence there.
 */
function maskFencedLines(lines: string[], from: number, to: number): boolean[] {
  const masked = new Array<boolean>(lines.length).fill(false);

  for (let i = from; i < to; i++) {
    if (!FENCE_RE.test(lines[i])) continue;

    let close = -1;
    for (let j = i + 1; j < to; j++) {
      if (FENCE_RE.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) continue;

    for (let j = i; j <= close; j++) masked[j] = true;
    i = close;
  }

  return masked;
}

/**
 * Reads a knowledge file's markdown into structure. Never throws: anything it can't make
 * sense of falls back to `emptyKnowledge(baseUrl)` rather than taking down the caller.
 *
 * The file has exactly two halves, split by the first column-0 `## Operator notes` line:
 *
 * - **Below it, the human's half.** Everything from the next line to end of file is one
 *   opaque slice, copied out byte for byte and copied back the same way. Nothing in there
 *   is looked at — a `## Access`, a bullet, a fence closed or not, a second
 *   `## Operator notes`, all of it is just text the operator typed. This is the whole
 *   point of the split: three earlier versions parsed inside the notes, and each one found
 *   a new shape of note whose content it silently ate on the next save. A parser that
 *   never reads the region cannot lose anything in it.
 * - **Above it, the agent's half.** Optional `---` frontmatter (`site`, `updated`), then
 *   `## <Section>` headings and their `- ` bullets for the four agent sections. Any other
 *   heading is ignored, so a human or a future version can add sections this reader
 *   doesn't know about without losing the ones it does.
 *
 * The split costs one thing, and it is deliberate: a hand-written file that puts
 * `## Operator notes` *before* an agent section has that section swallowed into the notes.
 * The bytes all survive and are written back intact — only ownership moves, and only for a
 * file shaped in a way `renderKnowledge` never produces. Reading inside the notes to
 * "reclaim" those sections is what destroyed operator prose in the first place.
 *
 * The rules the agent half's single left-to-right pass enforces:
 *
 * - CRLF is stripped per line before anything is matched. A file re-saved with CRLF would
 *   otherwise fail every `- `/`updated:` regex (both anchor `$` at true end-of-string,
 *   which a trailing `\r` breaks) while headings kept matching, zeroing out every bullet
 *   while leaving the file looking structurally intact. The operator slice is cut from the
 *   *unstripped* text, so line endings a human chose survive there untouched.
 * - A line that follows a bullet and is neither a new bullet, a heading, a fence, nor
 *   blank is a continuation of that bullet, joined to it with a single space. Hand-written
 *   files wrap long rules across lines, and dropping the tail truncated the rule
 *   mid-sentence along with its `(confirmed ...)` stamp. Rendering re-emits the joined
 *   bullet on one line, so a wrapped file is reflowed once on the first save and is
 *   byte-stable from then on.
 * - Lines inside a closed ``` fence are text, not structure. A fence with no closer above
 *   the operator heading is not a fence, but it still ends any bullet it follows — an
 *   unclosed fence and its prose glued onto a bullet would otherwise be saved back as a
 *   learned rule and stay one forever, since that form is byte-stable too.
 */
export function parseKnowledge(baseUrl: string, rawText: string): SiteKnowledge {
  try {
    // Split on `\n` only, then keep a CR-stripped view for matching. `rawLines` still holds
    // whatever line endings the file had, which is what makes the operator slice verbatim.
    const rawLines = rawText.split('\n');
    const lines = rawLines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

    const operatorAt = lines.findIndex((line) => OPERATOR_HEADING_RE.test(line));
    const agentEnd = operatorAt === -1 ? lines.length : operatorAt;
    // One trailing newline comes off: `renderKnowledge` re-supplies it as the file's final
    // line break. Nothing else is touched, not even a leading blank line.
    const operatorNotes = operatorAt === -1 ? '' : rawLines.slice(operatorAt + 1).join('\n').replace(/\n$/, '');

    const bodyStart = frontmatterEnd(lines);
    const masked = maskFencedLines(lines, bodyStart, agentEnd);

    let updated: string | null = null;
    for (let i = 1; i < bodyStart - 1; i++) {
      const m = UPDATED_RE.exec(lines[i]);
      if (m) updated = m[1].trim() || null;
    }

    const sections: Record<KnowledgeSection, string[]> = { Access: [], Search: [], Download: [], Pitfalls: [] };
    let currentSection: KnowledgeSection | null = null;
    let pending: { section: KnowledgeSection; text: string } | null = null;

    const flush = (): void => {
      if (pending) sections[pending.section].push(pending.text);
      pending = null;
    };

    for (let i = bodyStart; i < agentEnd; i++) {
      const line = lines[i];

      if (masked[i]) {
        flush();
        continue;
      }

      if (ANY_HEADING_RE.test(line)) {
        flush();
        const name = headingName(line);
        if (name !== null) currentSection = agentSection(name);
        continue;
      }

      // An unclosed fence: not structure, but still the end of the bullet above it.
      if (FENCE_RE.test(line)) {
        flush();
        continue;
      }

      if (currentSection === null) continue;

      const bullet = BULLET_RE.exec(line);
      if (bullet) {
        flush();
        pending = { section: currentSection, text: bullet[1] };
        continue;
      }

      if (line.trim() === '') {
        flush();
        continue;
      }

      if (pending) pending.text = `${pending.text} ${line.trim()}`;
    }
    flush();

    return { baseUrl, updated, sections, operatorNotes };
  } catch {
    return emptyKnowledge(baseUrl);
  }
}

/**
 * Renders a `SiteKnowledge` back to markdown: frontmatter, a `# <siteLabel>` title, then
 * `## Access` / `## Search` / `## Download` / `## Pitfalls` / `## Operator notes` in that
 * fixed order — every heading always present, even when its section is empty, so the file
 * shape never depends on what's been learned yet. Operator notes are written back as the
 * exact bytes `parseKnowledge` cut out, under a heading that is always last.
 *
 * Not a general inverse of `parseKnowledge`: the agent half is re-emitted in canonical
 * form, so a file already in that form round-trips byte-for-byte and any other file is
 * normalized once on its first save and byte-stable from then on. What gets normalized:
 * a bullet a human wrapped across several lines comes back joined and is re-emitted on one
 * line (the text and its stamp are intact, only the wrapping is gone), sections move into
 * the fixed order, an unknown heading in the agent half is dropped, and the operator
 * heading is respelled in canonical case. The operator's own bytes are never in that list.
 */
export function renderKnowledge(k: SiteKnowledge): string {
  const lines: string[] = [
    '---',
    `site: ${k.baseUrl}`,
    `updated: ${k.updated ?? ''}`,
    '---',
    '',
    `# ${siteLabel(k.baseUrl)}`,
    '',
  ];

  for (const section of AGENT_SECTIONS) {
    lines.push(`## ${section}`);
    for (const bullet of k.sections[section]) {
      lines.push(`- ${bullet}`);
    }
    lines.push('');
  }

  lines.push(OPERATOR_HEADING);
  if (k.operatorNotes) lines.push(k.operatorNotes);

  return `${lines.join('\n')}\n`;
}

/**
 * Loads a site's knowledge file: the local copy if one exists, else a seed under
 * `seedsDir` (copied to the local path first, so the local file exists from then on and
 * every later save/prune only ever touches the local copy), else empty knowledge.
 */
export function loadKnowledge(dataDir: string, baseUrl: string, seedsDir?: string): SiteKnowledge {
  const path = knowledgePath(dataDir, baseUrl);

  if (!existsSync(path) && seedsDir) {
    const seedPath = join(seedsDir, `${siteKey(baseUrl)}.md`);
    if (existsSync(seedPath)) {
      ensureDataSubdir(dataDir, 'sites');
      copyFileSync(seedPath, path);
    }
  }

  if (!existsSync(path)) return emptyKnowledge(baseUrl);
  return parseKnowledge(baseUrl, readFileSync(path, 'utf8'));
}

/**
 * Writes a site's knowledge file, keeping the previous version as `<path>.bak` and never
 * leaving a partially-written file at the target: any existing file is copied to `.bak`
 * first, the new content is written to `<path>.tmp`, then renamed over the target (atomic
 * on the same filesystem).
 */
export function saveKnowledge(dataDir: string, k: SiteKnowledge): void {
  ensureDataSubdir(dataDir, 'sites');
  const path = knowledgePath(dataDir, k.baseUrl);

  if (existsSync(path)) copyFileSync(path, `${path}.bak`);

  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, renderKnowledge(k), 'utf8');
  renameSync(tmpPath, path);
}

/** Each non-empty agent section as a `## <Section>` heading and its bullets, joined with
 * a blank line — the agent-owned portion of both `knowledgeForPrompt` and
 * `agentCharCount`, factored out so the two can't drift on what "agent-owned" covers. */
function renderAgentSections(k: SiteKnowledge): string {
  return AGENT_SECTIONS.filter((section) => k.sections[section].length > 0)
    .map((section) => `## ${section}\n${k.sections[section].map((b) => `- ${b}`).join('\n')}`)
    .join('\n\n');
}

/** Says what the `## Access` / `## Search` / … block that follows it is, and what to do
 * with it. Without a line like this the prompt runs from the site's URL straight into a
 * bare markdown heading, and nothing tells the model those bullets are the site's own
 * protocol rather than, say, a page it already fetched. This module emits it — a caller
 * pasting the block into a prompt shouldn't have to know how to introduce it, and there
 * is no second call site to keep in step. */
const AGENT_KNOWLEDGE_HEADER =
  'Site protocol notes learned on earlier runs — follow them step by step. They can be out of date: if a step does not match what the page shows, trust the page.';

/**
 * The subset of a knowledge file worth putting in the agent's prompt: operator notes
 * first (marked authoritative, since they override anything the agent learned on its
 * own), then the agent's own sections under a line saying what they are. Empty sections —
 * including an empty operator-notes section, heading and all — are omitted, header
 * included. Returns `''` when there's nothing to say, so a caller can skip adding an
 * empty block to the prompt.
 *
 * Operator notes are trimmed here and only here: the stored copy stays byte-exact for the
 * file, while the prompt doesn't spend tokens on the blank lines around them (and a notes
 * section holding nothing but whitespace counts as empty, not as a stub worth injecting).
 */
export function knowledgeForPrompt(k: SiteKnowledge): string {
  const parts: string[] = [];

  const notes = k.operatorNotes.trim();
  if (notes) {
    parts.push(`## Operator notes (authoritative — overrides the learned rules below)\n${notes}`);
  }
  const agentPart = renderAgentSections(k);
  if (agentPart) parts.push(`${AGENT_KNOWLEDGE_HEADER}\n${agentPart}`);

  return parts.join('\n\n');
}

/**
 * Drops agent-section bullets whose `(confirmed YYYY-MM-DD)` stamp is older than
 * `STALE_AFTER_DAYS` before `today` — but only once `hadSuccessSince` is true, i.e. the
 * site has actually run again since that bullet was confirmed and had the chance to
 * contradict it. Without a success to judge them by, stale bullets are the only knowledge
 * there is and are kept. Operator notes are never touched — they're human-owned, not the
 * agent's to decay. Returns a new object; `k` is never mutated.
 *
 * Kept, not dropped, on anything this can't confidently judge: a bullet with no stamp at
 * all, a bullet whose stamp is shaped right but calendar-invalid (an LLM-hallucinated
 * `2026-13-45`, which writes this stamp in a later task), and — since one bad date
 * shouldn't cost every bullet in every section — a `today` that itself fails to parse.
 * `today` is read as its first 10 characters, so a full ISO timestamp
 * (`new Date().toISOString()`, the obvious thing to pass) lands on the same UTC-midnight
 * cutoff as a bare `YYYY-MM-DD` instead of shifting the boundary by up to a day.
 */
export function pruneStale(k: SiteKnowledge, today: string, hadSuccessSince: boolean): SiteKnowledge {
  const todayMs = hadSuccessSince ? parseStrictDate(today.slice(0, 10)) : null;
  const cutoffMs = todayMs !== null ? todayMs - STALE_AFTER_DAYS * MS_PER_DAY : null;

  const clone = (bullets: string[]): string[] => {
    if (cutoffMs === null) return [...bullets];
    return bullets.filter((bullet) => {
      const m = CONFIRMED_RE.exec(bullet);
      if (!m) return true;
      const stampMs = parseStrictDate(m[1]);
      if (stampMs === null) return true;
      return stampMs >= cutoffMs;
    });
  };

  return {
    ...k,
    sections: {
      Access: clone(k.sections.Access),
      Search: clone(k.sections.Search),
      Download: clone(k.sections.Download),
      Pitfalls: clone(k.sections.Pitfalls),
    },
  };
}

/** Rendered length of the agent-owned sections only (no frontmatter, title, or operator
 * notes) — what Task 4's `KNOWLEDGE_CHAR_CAP` ceiling is measured against. Zero when no
 * agent section has any bullets. */
export function agentCharCount(k: SiteKnowledge): number {
  return renderAgentSections(k).length;
}
