/** Timestamp math + cue extraction for the two subtitle text formats Warrden handles.
 * Pure string parsing — no file IO — so the drift gate's unit tests feed it synthetic
 * cue tables directly. Tolerant by design: a malformed cue block is skipped, never fatal,
 * because fansub files routinely carry junk lines. */

export interface SubtitleCue {
  startMs: number;
  endMs: number;
}

/** `.ssa` is ASS's predecessor — same event syntax, parsed identically. */
export function detectSubtitleFormat(fileName: string): 'srt' | 'ass' | null {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'srt') return 'srt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  return null;
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
  const cues = content.includes('[Events]') ? parseAss(content) : parseSrt(content);
  return cues.sort((a, b) => a.startMs - b.startMs);
}
