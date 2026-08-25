import { describe, expect, it } from 'vitest';
import { dialogueCues, MIN_DIALOGUE_CUES, parseSubtitleCues, type SubtitleCue } from '../src/media/subtitles.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello

2
01:02:03,000 --> 01:02:05,000
World
on two lines

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
Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Wait, no, stop
Dialogue: 0,1:02:03.00,1:02:05.00,Default,,0,0,0,,World
Comment: 0,0:00:00.00,0:00:00.00,Default,,0,0,0,,not a dialogue line
`;

const ASS_CUES: SubtitleCue[] = [
  { startMs: 1000, endMs: 3500, text: 'Hello' },
  { startMs: 5000, endMs: 6000, text: 'Wait, no, stop' },
  { startMs: 3723000, endMs: 3725000, text: 'World' },
];

describe('parseSubtitleCues', () => {
  it('parses SRT cues with their body text and skips malformed blocks', () => {
    expect(parseSubtitleCues(SRT)).toEqual([
      { startMs: 1000, endMs: 3500, text: 'Hello' },
      { startMs: 10250, endMs: 12000, text: 'Dot millis also accepted' },
      { startMs: 3723000, endMs: 3725000, text: 'World\non two lines' },
    ]);
  });

  it('parses ASS Dialogue lines, ignoring comments and other sections', () => {
    expect(parseSubtitleCues(ASS)).toEqual(ASS_CUES);
  });

  it.each(['[Events]', '[events]', '[EVENTS]'])('auto-detects ASS from a %s section regardless of case', (section) => {
    expect(parseSubtitleCues(ASS.replace(/\[Events\]/, section))).toEqual(ASS_CUES);
  });

  it('returns [] for content with no parseable cues', () => {
    expect(parseSubtitleCues('not a subtitle file')).toEqual([]);
  });
});

function cueOf(text: string, i: number): SubtitleCue {
  return { startMs: i * 1000, endMs: i * 1000 + 500, text };
}

/** `count` plain dialogue cues — enough to clear the safety valve — plus the cue under test. */
function withDialogueFloor(text: string, count = MIN_DIALOGUE_CUES): SubtitleCue[] {
  return [...Array.from({ length: count }, (_, i) => cueOf(`line ${i}`, i + 1)), cueOf(text, count + 1)];
}

describe('dialogueCues', () => {
  it.each([
    ['\\k', '{\\k12}shi{\\k8}ro'],
    ['\\K', '{\\K30}na{\\K22}mi'],
    ['\\kf', '{\\kf20}so{\\kf15}ra'],
    ['\\ko', '{\\ko20}ho{\\ko18}shi'],
    ['\\pos(', '{\\an5\\pos(640,80)}Sign: Cafe'],
    ['\\move(', '{\\move(0,0,320,240)}scrolling credit'],
    ['\\org(', '{\\org(320,240)\\frz30}tilted sign'],
    ['\\clip(', '{\\clip(0,0,100,100)}masked sign'],
    ['\\iclip(', '{\\iclip(m 0 0 l 5 5)}masked sign'],
    ['\\t(', '{\\t(0,500,\\fscx120)}pulsing sign'],
  ])('drops a cue carrying %s', (_tag, text) => {
    const kept = dialogueCues(withDialogueFloor(text));
    expect(kept).toHaveLength(MIN_DIALOGUE_CUES);
    expect(kept.map((c) => c.text)).not.toContain(text);
  });

  it.each([
    ['plain dialogue', 'Are you going to the festival?'],
    ['faded dialogue', '{\\fad(150,150)}Are you going to the festival?'],
    ['styled dialogue', '{\\i1}Are you{\\i0} going?'],
    ['line-broken dialogue', 'Are you going\\Nto the festival?'],
  ])('keeps %s', (_name, text) => {
    expect(dialogueCues(withDialogueFloor(text)).map((c) => c.text)).toContain(text);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['override tags only', '{\\an8}{\\blur3}'],
  ])('drops a %s cue', (_name, text) => {
    expect(dialogueCues(withDialogueFloor(text))).toHaveLength(MIN_DIALOGUE_CUES);
  });

  const SIGNS = 500;

  it.each([
    ['falls back to the whole table when one cue too few survives', MIN_DIALOGUE_CUES - 1, SIGNS + MIN_DIALOGUE_CUES - 1],
    ['filters when exactly the floor survives', MIN_DIALOGUE_CUES, MIN_DIALOGUE_CUES],
  ])('%s', (_name, survivors, expectedLength) => {
    const input = [
      ...Array.from({ length: survivors }, (_, i) => cueOf(`line ${i}`, i + 1)),
      ...Array.from({ length: SIGNS }, (_, i) => cueOf('{\\pos(640,80)}sign', i + 100)),
    ];
    expect(dialogueCues(input)).toHaveLength(expectedLength);
  });

  it('returns [] for []', () => {
    expect(dialogueCues([])).toEqual([]);
  });
});
