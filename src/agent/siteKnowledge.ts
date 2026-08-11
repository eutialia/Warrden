import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { siteKey, siteLabel } from '../config/siteLabel.js';
import { ensureDataSubdir } from '../fs/paths.js';

/** The four sections the browse agent itself reads and rewrites. `Operator notes` is a
 * fifth heading every file also carries, but it is human-owned — the agent never writes
 * to it, so it isn't part of this union. */
export type KnowledgeSection = 'Access' | 'Search' | 'Download' | 'Pitfalls';

export const AGENT_SECTIONS: readonly KnowledgeSection[] = ['Access', 'Search', 'Download', 'Pitfalls'];

/** Ceiling on the agent-owned portion of a knowledge file (Task 4 enforces this). */
export const KNOWLEDGE_CHAR_CAP = 10_000;

/** A bullet older than this, once the site has succeeded again since, is assumed
 * superseded and dropped by `pruneStale`. */
export const STALE_AFTER_DAYS = 90;

/**
 * One site's learned knowledge file, parsed into structure. `sections` holds bullet text
 * with the leading `- ` marker stripped — callers re-add it when rendering. `operatorNotes`
 * is the `## Operator notes` section body, verbatim but trimmed of surrounding blank lines:
 * the one part of the file a human writes and the agent must never touch.
 */
export interface SiteKnowledge {
  baseUrl: string;
  updated: string | null;
  sections: Record<KnowledgeSection, string[]>;
  operatorNotes: string;
}

const HEADING_RE = /^##\s+(.+?)\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s/;
const BULLET_RE = /^-\s(.*)$/;
const UPDATED_RE = /^updated:\s*(.*)$/;
const CONFIRMED_RE = /\(confirmed (\d{4}-\d{2}-\d{2})\)/;
const FENCE_RE = /^```/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The one heading in the file the agent may not write to. */
const OPERATOR_HEADING = 'Operator notes';

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
 * none. The search for that closing line stops at the first markdown heading, so a `---`
 * horizontal rule further down the body can never be mistaken for it — an unbounded
 * search would take everything above that rule, sections included, as frontmatter and
 * drop it. An unterminated fence therefore parses as "no frontmatter" rather than as
 * "the whole file is frontmatter".
 */
function frontmatterEnd(lines: string[]): number {
  if (lines[0] !== '---') return 0;
  for (let i = 1; i < lines.length && !ANY_HEADING_RE.test(lines[i]); i++) {
    if (lines[i] === '---') return i + 1;
  }
  return 0;
}

/**
 * Which lines sit inside a *closed* ``` fence, delimiters included, and so must not be
 * read as structure — a `## Access` in a pasted snippet is an example, not a section.
 *
 * Two containment rules keep a stray fence from eating the file, both learned the hard
 * way. An opener with no closer is not a fence at all: a single unbalanced ``` used to
 * mask every heading below it to end of file. And the search for a closer never crosses a
 * `## Operator notes` line, so a fence opened above that heading can never hide it —
 * hiding it parses the operator's notes as empty, and the next save writes their section
 * back blank. Masking a heading is a cosmetic loss; blanking a human's file is not, so
 * the human-owned boundary wins whenever the two rules disagree.
 */
function maskFencedLines(lines: string[], from: number): boolean[] {
  const masked = new Array<boolean>(lines.length).fill(false);

  for (let i = from; i < lines.length; i++) {
    if (!FENCE_RE.test(lines[i])) continue;

    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (headingName(lines[j]) === OPERATOR_HEADING) break;
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
 * Reads a knowledge file's markdown into structure. Frontmatter (`site`, `updated`) is
 * optional; `## <Section>` headings and their `- ` bullets are read for the four agent
 * sections, `## Operator notes` is captured verbatim (trimmed), and any other heading is
 * ignored — a human or a future version can add sections this reader doesn't know about
 * without losing the ones it does. Never throws: anything it can't make sense of falls
 * back to `emptyKnowledge(baseUrl)` rather than taking down the caller.
 *
 * The line scan is deliberately small, because every past bug here was one state leaking
 * past the boundary it belonged to. It runs in three stages — normalize, then decide the
 * body's start and which lines are fenced, then a single left-to-right pass that only
 * ever consults those decisions — and holds exactly three pieces of state: the current
 * section, whether we are in operator notes, and the bullet still being assembled.
 *
 * The rules that pass enforces:
 *
 * - Input is normalized to `\n` line endings up front. A file re-saved with CRLF would
 *   otherwise fail every `- `/`updated:` regex (both anchor `$` at true end-of-string,
 *   which a trailing `\r` breaks) while headings kept matching, zeroing out every bullet
 *   while leaving the file looking structurally intact.
 * - A line in an agent section that follows a bullet and is neither a new bullet, a
 *   heading, a fence, nor blank is a continuation of that bullet, joined to it with a
 *   single space. Hand-written files wrap long rules across lines, and dropping the tail
 *   truncated the rule mid-sentence along with its `(confirmed ...)` stamp. Rendering
 *   re-emits the joined bullet on one line, so a wrapped file is reflowed once on the
 *   first save and is byte-stable from then on.
 * - `## Operator notes` may appear anywhere, not only last, and owns lines only until the
 *   next `## Access` / `## Search` / `## Download` / `## Pitfalls` heading. Those four
 *   names are the format's reserved vocabulary; any other `##` line inside the notes
 *   (`## Mirrors`, a pasted snippet) stays part of them verbatim. Letting notes run to end
 *   of file instead would keep the bytes but flip ownership of every section below: those
 *   bullets would be injected as authoritative, exempt from pruning, uncounted against
 *   the character cap, and unrewritable by the agent.
 */
export function parseKnowledge(baseUrl: string, rawText: string): SiteKnowledge {
  try {
    const lines = rawText.replace(/\r\n/g, '\n').split('\n');
    const bodyStart = frontmatterEnd(lines);
    const masked = maskFencedLines(lines, bodyStart);

    let updated: string | null = null;
    for (let i = 1; i < bodyStart - 1; i++) {
      const m = UPDATED_RE.exec(lines[i]);
      if (m) updated = m[1].trim() || null;
    }

    const sections: Record<KnowledgeSection, string[]> = { Access: [], Search: [], Download: [], Pitfalls: [] };
    const operatorLines: string[] = [];
    let currentSection: KnowledgeSection | null = null;
    let inOperatorNotes = false;
    let pending: { section: KnowledgeSection; text: string } | null = null;

    const flush = (): void => {
      if (pending) sections[pending.section].push(pending.text);
      pending = null;
    };

    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i];
      const name = headingName(line);

      // The operator boundary is recognized even inside a fence — see maskFencedLines.
      if (name === OPERATOR_HEADING) {
        flush();
        inOperatorNotes = true;
        currentSection = null;
        continue;
      }

      if (inOperatorNotes) {
        const reclaimed = masked[i] || name === null ? null : agentSection(name);
        if (reclaimed) {
          inOperatorNotes = false;
          currentSection = reclaimed;
          continue;
        }
        operatorLines.push(line);
        continue;
      }

      if (masked[i]) {
        flush();
        continue;
      }

      if (ANY_HEADING_RE.test(line)) {
        flush();
        if (name !== null) currentSection = agentSection(name);
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

    return { baseUrl, updated, sections, operatorNotes: operatorLines.join('\n').trim() };
  } catch {
    return emptyKnowledge(baseUrl);
  }
}

/**
 * Renders a `SiteKnowledge` back to markdown: frontmatter, a `# <siteLabel>` title, then
 * `## Access` / `## Search` / `## Download` / `## Pitfalls` / `## Operator notes` in that
 * fixed order — every heading always present, even when its section is empty, so the file
 * shape never depends on what's been learned yet. Inverse of `parseKnowledge`: rendering a
 * parsed file reproduces it byte-for-byte.
 *
 * One normalization, not a round-trip loss: a bullet a human wrapped across several lines
 * comes back from the parser joined, so it is re-emitted on one line. The text is intact;
 * only the wrapping is gone, and the file is byte-stable from that first save on.
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

  lines.push('## Operator notes');
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

/**
 * The subset of a knowledge file worth putting in the agent's prompt: operator notes
 * first (marked authoritative, since they override anything the agent learned on its
 * own), then each non-empty agent section as a heading and its bullets. Empty sections —
 * including an empty operator-notes section, heading and all — are omitted. Returns `''`
 * when there's nothing to say, so a caller can skip adding an empty block to the prompt.
 */
export function knowledgeForPrompt(k: SiteKnowledge): string {
  const parts: string[] = [];

  if (k.operatorNotes) {
    parts.push(`## Operator notes (authoritative — overrides the learned rules below)\n${k.operatorNotes}`);
  }
  const agentPart = renderAgentSections(k);
  if (agentPart) parts.push(agentPart);

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
