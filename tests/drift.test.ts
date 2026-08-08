import { describe, expect, it } from 'vitest';
import { assessDrift, bestOffsetScore, type DriftAssessment } from '../src/pipelines/subtitle/drift.js';
import type { SubtitleCue } from '../src/media/subtitles.js';

function cues(startsSec: number[], durationMs = 2000): SubtitleCue[] {
  return startsSec.map((s) => ({ startMs: s * 1000, endMs: s * 1000 + durationMs }));
}

const BASE = cues([10, 30, 62, 95, 130, 180, 240, 300]);

function shift(c: SubtitleCue[], deltaMs: number): SubtitleCue[] {
  return c.map((x) => ({ startMs: x.startMs + deltaMs, endMs: x.endMs + deltaMs }));
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

describe('assessDrift', () => {
  it.each<[string, SubtitleCue[], SubtitleCue[], DriftAssessment['state']]>([
    ['identical tables are in-sync', BASE, BASE, 'in-sync'],
    ['a tiny 50ms jitter is in-sync', BASE, shift(BASE, 50), 'in-sync'],
    ['a constant 5s shift is drifted', BASE, shift(BASE, 5000), 'drifted'],
    ['a constant -8.4s shift is drifted', BASE, shift(BASE, -8400), 'drifted'],
    ['unrelated cue tables are unscorable', BASE, cues([7, 19, 41, 77, 101, 150, 210, 290]), 'unscorable'],
    ['an empty candidate is unscorable', BASE, [], 'unscorable'],
    ['an empty reference is unscorable', [], BASE, 'unscorable'],
  ])('%s', (_name, a, b, state) => {
    expect(assessDrift(a, b).state).toBe(state);
  });

  it('a drifted assessment carries the recovered offset', () => {
    const r = assessDrift(BASE, shift(BASE, 5000));
    expect(r.state).toBe('drifted');
    expect(r.offsetMs).toBe(5000);
  });
});
