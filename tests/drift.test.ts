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

/** `n` cues spaced 30s apart. The trailing cues (one per entry in
 * `deficientDurationsMs`) get a shorter, start-aligned candidate duration, fixing
 * their overlap ratio below 1 while every other cue matches exactly — the
 * aggregate score peaks uniquely at zero shift. */
function cuesWithDeficientOverlap(
  n: number,
  deficientDurationsMs: number[],
): { reference: SubtitleCue[]; candidate: SubtitleCue[] } {
  const fullCount = n - deficientDurationsMs.length;
  const reference = cues(Array.from({ length: n }, (_, i) => (i + 1) * 30));
  const candidate = reference.map((cue, i) =>
    i < fullCount ? cue : { startMs: cue.startMs, endMs: cue.startMs + deficientDurationsMs[i - fullCount]! },
  );
  return { reference, candidate };
}

describe('assessDrift', () => {
  const { reference: score82Ref, candidate: score82Candidate } = cuesWithDeficientOverlap(5, [200]);
  const { reference: score78Ref, candidate: score78Candidate } = cuesWithDeficientOverlap(5, [900, 900]);

  it.each<[string, SubtitleCue[], SubtitleCue[], DriftAssessment['state']]>([
    ['identical tables are in-sync', BASE, BASE, 'in-sync'],
    ['a tiny 50ms jitter is in-sync', BASE, shift(BASE, 50), 'in-sync'],
    ['a constant 5s shift is drifted', BASE, shift(BASE, 5000), 'drifted'],
    ['a constant -8.4s shift is drifted', BASE, shift(BASE, -8400), 'drifted'],
    ['unrelated cue tables are unscorable', BASE, cues([7, 19, 41, 77, 101, 150, 210, 290]), 'unscorable'],
    ['an empty candidate is unscorable', BASE, [], 'unscorable'],
    ['an empty reference is unscorable', [], BASE, 'unscorable'],
    ['a 0.82 overlap at zero shift is in-sync', score82Ref, score82Candidate, 'in-sync'],
    ['a 0.78 overlap at zero shift is drifted', score78Ref, score78Candidate, 'drifted'],
  ])('%s', (_name, a, b, state) => {
    expect(assessDrift(a, b).state).toBe(state);
  });

  it('a drifted assessment carries the recovered offset', () => {
    const r = assessDrift(BASE, shift(BASE, 5000));
    expect(r.state).toBe('drifted');
    expect(r.offsetMs).toBe(5000);
  });

  it('scores the 0.82 candidate at 0.82 with no shift', () => {
    const r = assessDrift(score82Ref, score82Candidate);
    expect(r.offsetMs).toBe(0);
    expect(r.score).toBeCloseTo(0.82, 5);
  });

  it('scores the 0.78 candidate at 0.78 with no shift', () => {
    const r = assessDrift(score78Ref, score78Candidate);
    expect(r.offsetMs).toBe(0);
    expect(r.score).toBeCloseTo(0.78, 5);
  });
});
