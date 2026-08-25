/** Timestamp math + cue extraction for the two subtitle text formats Warrden handles.
 * Pure string parsing — no file IO — so the drift gate's unit tests feed it synthetic
 * cue tables directly. Tolerant by design: a malformed cue block is skipped, never fatal,
 * because fansub files routinely carry junk lines. */

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  /** The cue's rendered line: the ASS Text column, or the SRT block body. Carries the
   * override tags the drift gate uses to tell dialogue from karaoke and typesetting. */
  text: string;
}

// SRT: 00:00:01,000 or 00:00:01.000
function parseSrtTimestamp(t: string): number | null {
  const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!m) return null;
  return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]);
}

// ASS: h:mm:ss.cc (centiseconds)
function parseAssTimestamp(t: string): number | null {
  const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]) * 10;
}

const SRT_TIMING = /(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})/;

function parseSrt(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of content.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    const lines = block.split('\n');
    const timingLine = lines.findIndex((l) => SRT_TIMING.test(l));
    if (timingLine === -1) continue;
    const m = lines[timingLine]!.match(SRT_TIMING)!;
    const startMs = parseSrtTimestamp(m[1]!);
    const endMs = parseSrtTimestamp(m[2]!);
    if (startMs === null || endMs === null) continue;
    cues.push({ startMs, endMs, text: lines.slice(timingLine + 1).join('\n').trim() });
  }
  return cues;
}

function parseAss(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  let startCol = 1;
  let endCol = 2;
  let textCol = 9;
  for (const line of content.split(/\r?\n/)) {
    if (/^\[.*\]$/.test(line.trim())) {
      inEvents = line.trim().toLowerCase() === '[events]';
      continue;
    }
    if (!inEvents) continue;
    const format = line.match(/^Format:\s*(.+)$/i);
    if (format) {
      const cols = format[1]!.split(',').map((c) => c.trim().toLowerCase());
      const start = cols.indexOf('start');
      const end = cols.indexOf('end');
      const text = cols.indexOf('text');
      if (start !== -1) startCol = start;
      if (end !== -1) endCol = end;
      if (text !== -1) textCol = text;
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    // The Text column is last and may itself contain commas, so re-join its split pieces.
    const parts = line.slice(line.indexOf(':') + 1).split(',');
    const startMs = parseAssTimestamp(parts[startCol] ?? '');
    const endMs = parseAssTimestamp(parts[endCol] ?? '');
    if (startMs === null || endMs === null) continue;
    cues.push({ startMs, endMs, text: parts.slice(textCol).join(',').trim() });
  }
  return cues;
}

/** Parses SRT or ASS cue timings, auto-detected by content, sorted by start time. */
export function parseSubtitleCues(content: string): SubtitleCue[] {
  const cues = /\[events\]/i.test(content) ? parseAss(content) : parseSrt(content);
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** Override tags that mark an event as karaoke timing or as positioned/animated typesetting
 * rather than a spoken line. Matched as substrings, so `\k` already covers `\kf`/`\ko`; the
 * rest is spelled out because it is the gate's contract, not an implementation shortcut. */
const NON_DIALOGUE_TAGS = ['\\k', '\\K', '\\pos(', '\\move(', '\\org(', '\\clip(', '\\iclip(', '\\t('] as const;

/** Below this many survivors the filter is distrusted and the unfiltered table is used —
 * some groups `\pos` every line, and a handful of cues scores worse than a noisy full table.
 * A don't-filter valve only: whether a table is worth scoring at all is the drift gate's
 * `minScorableCues`. */
export const MIN_DIALOGUE_CUES = 40;

function isDialogue(cue: SubtitleCue): boolean {
  if (NON_DIALOGUE_TAGS.some((tag) => cue.text.includes(tag))) return false;
  return cue.text.replace(/\{[^}]*\}/g, '').trim().length > 0;
}

/**
 * Narrows a cue table to spoken dialogue for drift scoring. A per-syllable OP/ED karaoke
 * carpet routinely outnumbers a fansub's dialogue ten to one, and scoring against it lets
 * the carpet — not the dialogue — pick the offset, which is how the gate lands on bogus
 * alignments. Returns the input untouched when too little survives (see MIN_DIALOGUE_CUES).
 */
export function dialogueCues(cues: SubtitleCue[]): SubtitleCue[] {
  const kept = cues.filter(isDialogue);
  return kept.length < MIN_DIALOGUE_CUES ? cues : kept;
}

/**
 * Decodes subtitle file bytes to a UTF-16/UTF-8/GBK string before cue parsing.
 * Chinese fansub packs routinely ship UTF-16-LE .ass (CASO-style) or GBK text; reading
 * those as naive UTF-8 yields garbage and an empty cue table, which the drift gate then
 * treats as unscorable/unverified for the wrong reason.
 */
export function decodeSubtitleBytes(raw: Buffer): string {
  if (raw.length === 0) return '';
  // UTF-16 LE/BE BOM
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return raw.subarray(2).toString('utf16le');
  }
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    // Node has no utf16be; swap pairs into LE.
    const swapped = Buffer.alloc(raw.length - 2);
    for (let i = 2; i + 1 < raw.length; i += 2) {
      swapped[i - 2] = raw[i + 1]!;
      swapped[i - 1] = raw[i]!;
    }
    return swapped.toString('utf16le');
  }
  // UTF-8 BOM
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return raw.subarray(3).toString('utf8');
  }
  const utf8 = raw.toString('utf8');
  // If UTF-8 produced replacement chars and doesn't look like a subtitle, try GBK (Node ICU).
  if (utf8.includes('\uFFFD') && !/\[events\]/i.test(utf8) && !/-->/.test(utf8)) {
    try {
      return new TextDecoder('gbk').decode(raw);
    } catch {
      // ICU without gbk — keep utf8 best-effort
    }
  }
  return utf8;
}

