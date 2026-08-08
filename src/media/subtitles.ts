/** Timestamp math + cue extraction for the two subtitle text formats Warrden handles.
 * Pure string parsing — no file IO — so the drift gate's unit tests feed it synthetic
 * cue tables directly. Tolerant by design: a malformed cue block is skipped, never fatal,
 * because fansub files routinely carry junk lines. */

export interface SubtitleCue {
  startMs: number;
  endMs: number;
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

function parseSrt(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of content.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    const m = block.match(/(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})/);
    if (!m) continue;
    const startMs = parseSrtTimestamp(m[1]!);
    const endMs = parseSrtTimestamp(m[2]!);
    if (startMs !== null && endMs !== null) cues.push({ startMs, endMs });
  }
  return cues;
}

function parseAss(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  let startCol = 1;
  let endCol = 2;
  for (const line of content.split(/\r?\n/)) {
    if (/^\[.*\]$/.test(line.trim())) {
      inEvents = line.trim().toLowerCase() === '[events]';
      continue;
    }
    if (!inEvents) continue;
    const format = line.match(/^Format:\s*(.+)$/i);
    if (format) {
      const cols = format[1]!.split(',').map((c) => c.trim().toLowerCase());
      startCol = cols.indexOf('start');
      endCol = cols.indexOf('end');
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    // ASS text can itself contain commas — split only up to the Text column.
    const parts = line.slice(line.indexOf(':') + 1).split(',');
    const startMs = parseAssTimestamp(parts[startCol] ?? '');
    const endMs = parseAssTimestamp(parts[endCol] ?? '');
    if (startMs !== null && endMs !== null) cues.push({ startMs, endMs });
  }
  return cues;
}

/** Parses SRT or ASS cue timings, auto-detected by content, sorted by start time. */
export function parseSubtitleCues(content: string): SubtitleCue[] {
  const cues = /\[events\]/i.test(content) ? parseAss(content) : parseSrt(content);
  return cues.sort((a, b) => a.startMs - b.startMs);
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

