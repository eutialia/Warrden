import { describe, expect, it } from 'vitest';
import { detectSubtitleFormat, parseSubtitleCues } from '../src/media/subtitles.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello

2
01:02:03,000 --> 01:02:05,000
World

bad block with no timing

3
00:00:10.250 --> 00:00:12.000
Dot millis also accepted
`;

const ASS = `[Script Info]
Title: x

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello
Dialogue: 0,1:02:03.00,1:02:05.00,Default,,0,0,0,,World
Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,not a dialogue line
`;

describe('parseSubtitleCues', () => {
  it('parses SRT cues and skips malformed blocks', () => {
    const cues = parseSubtitleCues(SRT);
    expect(cues).toEqual([
      { startMs: 1000, endMs: 3500 },
      { startMs: 10250, endMs: 12000 },
      { startMs: 3723000, endMs: 3725000 },
    ]);
  });

  it('parses ASS Dialogue lines, ignoring comments and other sections', () => {
    const cues = parseSubtitleCues(ASS);
    expect(cues).toEqual([
      { startMs: 1000, endMs: 3500 },
      { startMs: 3723000, endMs: 3725000 },
    ]);
  });

  it.each(['[Events]', '[events]', '[EVENTS]'])('auto-detects ASS from a %s section regardless of case', (section) => {
    const cues = parseSubtitleCues(ASS.replace(/\[Events\]/, section));
    expect(cues).toEqual([
      { startMs: 1000, endMs: 3500 },
      { startMs: 3723000, endMs: 3725000 },
    ]);
  });

  it('returns [] for content with no parseable cues', () => {
    expect(parseSubtitleCues('not a subtitle file')).toEqual([]);
  });
});

describe('detectSubtitleFormat', () => {
  it.each([
    ['a.srt', 'srt'],
    ['a.SRT', 'srt'],
    ['a.ass', 'ass'],
    ['a.ssa', 'ass'],
    ['a.mkv', null],
    ['noext', null],
  ])('%s -> %s', (name, expected) => {
    expect(detectSubtitleFormat(name)).toBe(expected);
  });
});
