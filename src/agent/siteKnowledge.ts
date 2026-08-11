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
const BULLET_RE = /^-\s(.*)$/;
const UPDATED_RE = /^updated:\s*(.*)$/;
const CONFIRMED_RE = /\(confirmed (\d{4}-\d{2}-\d{2})\)/;
const FENCE_RE = /^```/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

/**
 * Reads a knowledge file's markdown into structure. Frontmatter (`site`, `updated`) is
 * optional; `## <Section>` headings and their `- ` bullets are read for the four agent
 * sections, `## Operator notes` is captured verbatim (trimmed), and any other heading is
 * ignored — a human or a future version can add sections this reader doesn't know about
 * without losing the ones it does. Never throws: anything it can't make sense of falls
 * back to `emptyKnowledge(baseUrl)` rather than taking down the caller.
 *
 * Two defenses against silently losing content: (1) input is normalized to `\n` line
 * endings up front, so a file re-saved with CRLF by an editor doesn't fail every `- `/
 * `updated:` regex (both anchor `$` at true end-of-string, which a trailing `\r` breaks)
 * while headings — whose `\s*$` tail happens to swallow `\r` — keep matching, a mismatch
 * that would otherwise silently zero out every bullet while leaving the file looking
 * structurally intact. (2) once a `## Operator notes` heading is seen, no later line —
 * heading-shaped or not, fenced or not — hands control back to an agent section: operator
 * notes is always the last section by convention, and the alternative (a `##` inside a
 * pasted snippet or code fence quietly truncating notes and/or getting its trailing lines
 * adopted as agent-owned bullets subject to pruning) is worse than never exiting.
 * Fenced code blocks (```) are also tracked everywhere, not just inside operator notes,
 * so a `##`-looking line inside one is never mistaken for a real heading.
 */
export function parseKnowledge(baseUrl: string, rawText: string): SiteKnowledge {
  try {
    const lines = rawText.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    let updated: string | null = null;

    if (lines[0] === '---') {
      const closeIdx = lines.indexOf('---', 1);
      if (closeIdx === -1) {
        // No closing fence found by end of file: rather than swallow the whole file as
        // (unterminated) frontmatter and lose every section, treat it as if there were no
        // frontmatter at all and parse from the top.
        i = 0;
      } else {
        for (let j = 1; j < closeIdx; j++) {
          const m = UPDATED_RE.exec(lines[j]);
          if (m) updated = m[1].trim() || null;
        }
        i = closeIdx + 1;
      }
    }

    const sections: Record<KnowledgeSection, string[]> = { Access: [], Search: [], Download: [], Pitfalls: [] };
    const operatorLines: string[] = [];
    let currentSection: KnowledgeSection | null = null;
    let inOperatorNotes = false;
    let inFence = false;

    for (; i < lines.length; i++) {
      const line = lines[i];

      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        if (inOperatorNotes) operatorLines.push(line);
        continue;
      }

      if (!inFence && !inOperatorNotes) {
        const heading = HEADING_RE.exec(line);
        if (heading) {
          const name = heading[1];
          if (name === 'Operator notes') {
            inOperatorNotes = true;
          } else {
            currentSection = (AGENT_SECTIONS as readonly string[]).includes(name) ? (name as KnowledgeSection) : null;
          }
          continue;
        }
      }

      if (inOperatorNotes) {
        operatorLines.push(line);
        continue;
      }

      if (!inFence && currentSection) {
        const bullet = BULLET_RE.exec(line);
        if (bullet) sections[currentSection].push(bullet[1]);
      }
    }

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
