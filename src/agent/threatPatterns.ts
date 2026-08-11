/**
 * Prompt-injection patterns for text the agent stores and later replays into its own
 * system prompt.
 *
 * The two-scope split follows the design of the scanner in Nous Research's hermes-agent
 * (`tools/threat_patterns.py`, MIT): 'all' covers classic instruction-override and
 * exfiltration attempts and applies to anything the agent reads, while 'strict' adds rules
 * that only make sense for text about to be stored, where a payload persists across runs
 * instead of dying with the page it came from. The patterns here are this project's own,
 * written against its own threat model; no code was copied.
 */

export type ThreatScope = 'all' | 'strict';

export interface ThreatHit {
  pattern: string;
  excerpt: string;
}

interface ThreatPattern {
  name: string;
  regex: RegExp;
}

/** Bounded filler between an attack verb and its object — enough room for evasive phrasing
 * ("ignore any and all of your earlier instructions") without ever letting an unbounded
 * `.*` sit between two anchors, which is what turns a hostile input into a regex hang.
 * Matches non-whitespace tokens rather than word characters, so an object that isn't plain
 * English (a file path, a URL) still counts as filler instead of breaking the match. */
const FILLER = String.raw`(?:\S+\s+){0,8}`;

/** Applied to anything the agent reads: classic instruction-override, a fake system-role
 * marker, and sending data to an external URL. */
const ALL_PATTERNS: ThreatPattern[] = [
  {
    name: 'instruction-override',
    regex: new RegExp(String.raw`\bignore\s+${FILLER}(?:previous|prior|earlier|above|preceding|all|any)\s+${FILLER}instructions?\b`, 'i'),
  },
  {
    name: 'role-hijack',
    regex: new RegExp(String.raw`\byou\s+are\s+${FILLER}now\s+(?:a|an|the)\b`, 'i'),
  },
  {
    name: 'fake-system-directive',
    regex: /\bsystem\s*:\s*(?:you must|obey|comply|ignore|do as (?:i|instructed))\b/i,
  },
  {
    name: 'exfiltration-to-url',
    regex: new RegExp(String.raw`\b(?:send|email|post|upload|exfiltrate)\s+${FILLER}(?:to|via)\s+https?:\/\/`, 'i'),
  },
  {
    name: 'prompt-or-credential-leak',
    regex: new RegExp(String.raw`\b(?:reveal|print|output|dump)\s+${FILLER}(?:system prompt|api[ _-]?key|password|secret|credentials)\b`, 'i'),
  },
];

/** Only meaningful for text about to be written to a knowledge file and replayed into a
 * future system prompt: a payload that waits for that later read instead of firing on the
 * page that carried it, or one that asks to be preserved across runs. */
const STRICT_PATTERNS: ThreatPattern[] = [
  {
    name: 'deferred-execution',
    regex: new RegExp(String.raw`\bwhen\s+you\s+${FILLER}(?:read|open|load|reread)\s+${FILLER}(?:run|execute|do)\b`, 'i'),
  },
  {
    name: 'persistent-instruction',
    regex: new RegExp(
      String.raw`\b(?:remember|store|save)\s+${FILLER}(?:instruction|command|rule)\b\s+${FILLER}(?:future|next\s+time|later|every\s+run|from\s+now\s+on)\b`,
      'i',
    ),
  },
];

/** Codepoints of zero-width and bidi-override characters an evasive payload can use to
 * split a keyword across two halves that no keyword-matching pattern will recognize as one
 * word: zero-width space/non-joiner/joiner, word joiner, BOM / zero-width no-break space,
 * bidi embedding/override controls, and bidi isolates. Listed as decimal code points and
 * assembled below rather than written as literal characters or string escapes, so the
 * source itself never carries a byte a reviewer can't read directly off the page. */
const INVISIBLE_CODE_POINTS = [
  8203, 8204, 8205, // zero-width space, zero-width non-joiner, zero-width joiner
  8288, // word joiner
  65279, // BOM / zero-width no-break space
  8234, 8235, 8236, 8237, 8238, // left-to-right/right-to-left embedding, pop, override
  8294, 8295, 8296, 8297, // left-to-right/right-to-left/first-strong isolate, pop
];

const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CODE_POINTS.map((codePoint) => String.fromCharCode(codePoint)).join('')}]`, 'g');

/** Removes zero-width and bidirectional-override characters. Exported so a caller can
 * normalize text the same way the scanner does before doing its own inspection. */
export function stripInvisible(content: string): string {
  return content.replace(INVISIBLE_RE, '');
}

/** Up to 120 characters of context around a match, centered where possible, so an operator
 * reading the event log can see what tripped without the excerpt growing with the input. */
function excerptAround(text: string, index: number, matchLength: number): string {
  const radius = 60;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLength + radius);
  return text.slice(start, end).slice(0, 120);
}

/**
 * Scans `content` for prompt-injection and exfiltration attempts. `'strict'` runs its own
 * patterns plus every pattern in `'all'` — it is a superset, not a separate rule set — so a
 * caller scanning knowledge about to be written to disk should always pass `'strict'`.
 *
 * Matches against `stripInvisible(content)`, never the raw text, so an evasive payload can't
 * use zero-width or bidi characters to split a keyword across a pattern's anchors.
 */
export function scanForThreats(content: string, scope: ThreatScope): ThreatHit[] {
  const clean = stripInvisible(content);
  const patterns = scope === 'strict' ? [...STRICT_PATTERNS, ...ALL_PATTERNS] : ALL_PATTERNS;

  const hits: ThreatHit[] = [];
  for (const { name, regex } of patterns) {
    const match = regex.exec(clean);
    if (match) {
      hits.push({ pattern: name, excerpt: excerptAround(clean, match.index, match[0].length) });
    }
  }
  return hits;
}
