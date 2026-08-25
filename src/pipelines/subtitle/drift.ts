import type { SubtitleCue } from '../../media/subtitles.js';

/**
 * Drift detection over two subtitle cue tables (a reference — usually the video's embedded
 * track — and a candidate we might place). Pure math, no IO: the pipeline feeds it parsed
 * cues and it answers "aligned / shifted-but-fixable / unrelated". Deliberately NOT
 * audio-VAD-based in v1: an embedded reference track exists for the overwhelming majority
 * of fansub releases, and VAD (whisper.cpp) stays the spec's reserved future tier for the
 * no-reference case, which today just marks the candidate unverifiable upstream.
 */

const DRIFT_CONFIG = {
  /** 0 = score the whole file. Reserved for future golden-section windowed sampling. */
  windowSize: 0,
  maxOffsetMs: 120_000,
  offsetStepMs: 100,
  /** Below this the best offset barely overlaps at all: a track from a different cut or a
   * different show. A wrong-season file of the same show still scores 0.60-0.78, so this
   * threshold rejects noise, not mismatches — `acceptRatio` is what sorts those out. */
  qualityThreshold: 0.4,
  /** At/above this the candidate is placed as-is. */
  acceptRatio: 0.8,
  /** Refuse to score at all below this many cues on the shorter side: a forced-signs track's
   * handful of cues clears `acceptRatio` by chance often enough to be worthless as evidence.
   * A don't-score valve, unlike `MIN_DIALOGUE_CUES`, which only declines to filter. */
  minScorableCues: 20,
};

interface OffsetScore {
  offsetMs: number;
  score: number;
}

export interface DriftAssessment {
  // Exported for unit tests that type expected assessDrift states.
  state: 'in-sync' | 'drifted' | 'unscorable';
  offsetMs: number;
  score: number;
}

/** Scoring only ever needs a cue's timing, never its text. */
export type Span = Pick<SubtitleCue, 'startMs' | 'endMs'>;

function overlapMs(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/** Scores `b` shifted by `offsetMs` against `a`: the median per-cue best overlap ratio over
 * the shorter list, 0..1. Two real releases always disagree about what to typeset — song
 * lyrics, signs, an ED card one track carries and the other doesn't — and those cues have no
 * partner at any offset, so a mean lets a minority of them drag a perfectly aligned file
 * under the accept ratio. The median asks the majority of cues instead. Two-pointer overlap
 * plus one sort of the ratios per offset step, not O(n·m). */
function scoreAtOffset(a: Span[], b: Span[], offsetMs: number): number {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const shiftedLong: Span[] = long.map((c) => ({ startMs: c.startMs - offsetMs * (long === b ? 1 : -1), endMs: c.endMs - offsetMs * (long === b ? 1 : -1) }));
  const ratios: number[] = [];
  let j = 0;
  for (const cue of short) {
    const dur = Math.max(1, cue.endMs - cue.startMs);
    let best = 0;
    while (j < shiftedLong.length && shiftedLong[j]!.endMs < cue.startMs) j++;
    for (let k = j; k < shiftedLong.length && shiftedLong[k]!.startMs < cue.endMs; k++) {
      best = Math.max(best, overlapMs(cue, shiftedLong[k]!) / dur);
    }
    ratios.push(best);
  }
  ratios.sort((x, y) => x - y);
  // On an even count this takes the upper of the two middles: the permissive choice.
  return ratios[Math.floor(ratios.length / 2)] ?? 0;
}

/** Sweeps `±maxOffsetMs` in `offsetStepMs` steps and returns the best-scoring offset. Exact
 * ties are routine — a periodic cue table realigns with itself a whole period over — so a tie
 * goes to the offset nearest zero rather than to whichever end of the sweep came first. */
export function bestOffsetScore(a: Span[], b: Span[], opts?: Partial<typeof DRIFT_CONFIG>): OffsetScore {
  const cfg = { ...DRIFT_CONFIG, ...opts };
  let best: OffsetScore = { offsetMs: 0, score: -1 };
  for (let offset = -cfg.maxOffsetMs; offset <= cfg.maxOffsetMs; offset += cfg.offsetStepMs) {
    const score = scoreAtOffset(a, b, offset);
    if (score > best.score || (score === best.score && Math.abs(offset) < Math.abs(best.offsetMs))) {
      best = { offsetMs: offset, score };
    }
  }
  return best;
}

/** Buckets a candidate against the reference: place as-is, resync then re-check, or reject. */
export function assessDrift(a: Span[], b: Span[], opts?: Partial<typeof DRIFT_CONFIG>): DriftAssessment {
  const cfg = { ...DRIFT_CONFIG, ...opts };
  if (Math.min(a.length, b.length) < cfg.minScorableCues) return { state: 'unscorable', offsetMs: 0, score: 0 };
  const { offsetMs, score } = bestOffsetScore(a, b, cfg);
  if (score < cfg.qualityThreshold) return { state: 'unscorable', offsetMs, score };
  if (score >= cfg.acceptRatio && Math.abs(offsetMs) <= cfg.offsetStepMs) return { state: 'in-sync', offsetMs, score };
  return { state: 'drifted', offsetMs, score };
}
