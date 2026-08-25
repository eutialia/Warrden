import { describe, expect, it } from 'vitest';
import { assessDrift, bestOffsetScore, type DriftAssessment } from '../src/pipelines/subtitle/drift.js';
import { dialogueCues, type SubtitleCue } from '../src/media/subtitles.js';

const CUE_MS = 2000;

function cues(startsSec: number[], durationMs = CUE_MS): SubtitleCue[] {
  return startsSec.map((s) => ({ startMs: s * 1000, endMs: s * 1000 + durationMs, text: `line at ${s}s` }));
}

const BASE = cues([10, 30, 62, 95, 130, 180, 240, 300]);

function shift(c: SubtitleCue[], deltaMs: number): SubtitleCue[] {
  return c.map((x) => ({ ...x, startMs: x.startMs + deltaMs, endMs: x.endMs + deltaMs }));
}

function byStart(a: SubtitleCue, b: SubtitleCue): number {
  return a.startMs - b.startMs;
}

describe('bestOffsetScore', () => {
  it('finds zero offset for identical cue tables', () => {
    const r = bestOffsetScore(BASE, BASE);
    expect(r.offsetMs).toBe(0);
    expect(r.score).toBeCloseTo(1, 2);
  });

  it('recovers a constant +5s offset', () => {
    const r = bestOffsetScore(BASE, shift(BASE, 5000));
    expect(r.offsetMs).toBe(5000);
    expect(r.score).toBeCloseTo(1, 1);
  });

  it('recovers a constant -8.4s offset (sub-step precision snaps to nearest step)', () => {
    const r = bestOffsetScore(BASE, shift(BASE, -8400));
    expect(r.offsetMs).toBe(-8400);
    expect(r.score).toBeGreaterThan(0.8);
  });
});

/** Unevenly spaced cue starts: an evenly spaced table realigns with itself one whole cue
 * over, which hands the sweep a second offset scoring exactly as well as zero shift. */
function spacedStarts(n: number): number[] {
  const gaps = [31, 47, 29, 53, 37, 41, 59, 43];
  const starts: number[] = [];
  for (let i = 0; i < n; i++) starts.push((starts[i - 1] ?? 0) + gaps[i % gaps.length]!);
  return starts;
}

/** Reference cues 2s each, against a candidate whose cue `i` lags by `lagsMs[i]` — so that
 * cue overlaps its reference at `1 - |lag| / 2000`. Callers pair the lags off symmetrically
 * around zero so no sweep offset can beat zero shift. */
function cuesWithLags(lagsMs: number[]): { reference: SubtitleCue[]; candidate: SubtitleCue[] } {
  const reference = cues(spacedStarts(lagsMs.length));
  const candidate = reference.map((cue, i) => ({
    ...cue,
    startMs: cue.startMs + lagsMs[i]!,
    endMs: cue.endMs + lagsMs[i]!,
  }));
  return { reference, candidate };
}

/** `matched` cues both tracks share, plus cues only one side carries — songs, signs, an ED
 * card. The candidate gets more orphans than the reference, so the list the scorer walks is
 * the one polluted by unmatched cues. */
function cuesWithOrphans(
  matched: number,
  refOrphans: number,
  candOrphans: number,
): { reference: SubtitleCue[]; candidate: SubtitleCue[] } {
  const starts = spacedStarts(matched);
  const at = (count: number, offsetSec: number): SubtitleCue[] =>
    cues(starts.slice(0, count).map((s) => s + offsetSec));
  const shared = at(matched, 0);
  return {
    reference: [...shared, ...at(refOrphans, 7)].sort(byStart),
    candidate: [...shared, ...at(candOrphans, 17)].sort(byStart),
  };
}

/** The lag that makes a cue overlap its reference at exactly `ratio`. */
function lagFor(ratio: number): number {
  return Math.round((1 - ratio) * CUE_MS);
}

const scoreAtZeroShift = (a: SubtitleCue[], b: SubtitleCue[]): number =>
  bestOffsetScore(a, b, { maxOffsetMs: 0 }).score;

describe('assessDrift', () => {
  const at82 = cuesWithLags([0, lagFor(0.82), -lagFor(0.82), 900, -900]);
  const at78 = cuesWithLags([0, lagFor(0.78), -lagFor(0.78), 900, -900]);
  const at60 = cuesWithLags(Array.from({ length: 5 }, () => lagFor(0.6)));
  const evenCount = cuesWithLags([lagFor(0.7), lagFor(0.9)]);
  const withOrphans = cuesWithOrphans(10, 3, 6);

  it.each<[string, SubtitleCue[], SubtitleCue[], DriftAssessment['state']]>([
    ['identical tables are in-sync', BASE, BASE, 'in-sync'],
    ['a tiny 50ms jitter is in-sync', BASE, shift(BASE, 50), 'in-sync'],
    ['a constant 5s shift is drifted', BASE, shift(BASE, 5000), 'drifted'],
    ['a constant -8.4s shift is drifted', BASE, shift(BASE, -8400), 'drifted'],
    ['unrelated cue tables are unscorable', BASE, cues([33, 48, 62, 75, 94, 139, 147, 190]), 'unscorable'],
    ['an empty candidate is unscorable', BASE, [], 'unscorable'],
    ['an empty reference is unscorable', [], BASE, 'unscorable'],
    ['a 0.82 median overlap at zero shift is in-sync', at82.reference, at82.candidate, 'in-sync'],
    ['a 0.78 median overlap at zero shift is drifted', at78.reference, at78.candidate, 'drifted'],
    ['a table overlapping at 0.6 per cue is drifted', at60.reference, at60.candidate, 'drifted'],
    ['30% unmatched cues on the shorter side stay in-sync', withOrphans.reference, withOrphans.candidate, 'in-sync'],
  ])('%s', (_name, a, b, state) => {
    expect(assessDrift(a, b).state).toBe(state);
  });

  it('a drifted assessment carries the recovered offset', () => {
    const r = assessDrift(BASE, shift(BASE, 5000));
    expect(r.state).toBe('drifted');
    expect(r.offsetMs).toBe(5000);
  });

  it.each<[string, number, SubtitleCue[], SubtitleCue[]]>([
    ['0.82 boundary', 0.82, at82.reference, at82.candidate],
    ['0.78 boundary', 0.78, at78.reference, at78.candidate],
    ['0.6 per cue', 0.6, at60.reference, at60.candidate],
    ['30% unmatched cues', 1, withOrphans.reference, withOrphans.candidate],
    ['even cue count, upper of the two middles', 0.9, evenCount.reference, evenCount.candidate],
  ])('scores the %s table at %s with no shift', (_name, score, a, b) => {
    expect(scoreAtZeroShift(a, b)).toBeCloseTo(score, 5);
  });

  it.each<[string, SubtitleCue[], SubtitleCue[]]>([
    ['0.82 boundary', at82.reference, at82.candidate],
    ['30% unmatched cues', withOrphans.reference, withOrphans.candidate],
  ])('peaks at zero shift for the %s table', (_name, a, b) => {
    expect(bestOffsetScore(a, b).offsetMs).toBe(0);
  });
});

/** A fansub .ass as the gate really sees it: a few hundred dialogue cues plus a per-syllable
 * karaoke carpet under the OP, where the carpet outnumbers the dialogue 10:1 and therefore
 * owns the median. `karaokeShiftMs` staggers the two carpets so they align at a bogus
 * offset instead of at the true one. */
function withKaraokeCarpet(karaokeShiftMs: number): SubtitleCue[] {
  const dialogue = Array.from({ length: 300 }, (_, i) => ({
    startMs: 95_000 + i * 4000,
    endMs: 95_000 + i * 4000 + 2000,
    text: `dialogue ${i}`,
  }));
  const karaoke = Array.from({ length: 3000 }, (_, i) => ({
    startMs: karaokeShiftMs + i * 30 + (i % 97),
    endMs: karaokeShiftMs + i * 30 + (i % 97) + 25,
    text: `{\\k12}syl${i}`,
  }));
  return [...karaoke, ...dialogue].sort(byStart);
}

describe('assessDrift over karaoke-heavy cue tables', () => {
  const reference = withKaraokeCarpet(0);
  const candidate = withKaraokeCarpet(1000);
  const sweep = { maxOffsetMs: 1500 };

  it('scores an unfiltered table on the karaoke carpet that outnumbers dialogue', () => {
    const r = assessDrift(reference, candidate, sweep);
    expect(r.state).toBe('drifted');
    expect(r.offsetMs).toBe(1000);
  });

  it('reads the same tables as in-sync once scored on dialogue cues only', () => {
    const r = assessDrift(dialogueCues(reference), dialogueCues(candidate), sweep);
    expect(r.state).toBe('in-sync');
    expect(r.offsetMs).toBe(0);
  });
});
