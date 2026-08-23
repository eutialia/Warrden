import { describe, expect, it } from 'vitest';
import { describeStop, stopFromError, stopIsSiteFault, type StopReason } from '../src/agent/stop.js';
import { LlmError } from '../src/llm/generator.js';
import { parseFailure } from './llmFixtures.js';

describe('describeStop', () => {
  it.each<[StopReason, string]>([
    [{ kind: 'done' }, 'downloaded'],
    [
      { kind: 'gave-up', because: 'not-found', reason: 'nothing is listed for this season yet' },
      'gave up (nothing found): nothing is listed for this season yet',
    ],
    [{ kind: 'gave-up', because: 'blocked', reason: 'every page came back empty' }, 'gave up (could not get through): every page came back empty'],
    [{ kind: 'gave-up', because: 'unsure', reason: 'the listing is unreadable' }, 'gave up (could not tell): the listing is unreadable'],
    [{ kind: 'exhausted' }, 'step budget exhausted'],
    [{ kind: 'malformed', failures: 1 }, '1 reply was not valid JSON'],
    [{ kind: 'malformed', failures: 3 }, '3 replies were not valid JSON'],
    [{ kind: 'refused', refusals: 1 }, '1 step targeted a refused address'],
    [{ kind: 'refused', refusals: 3 }, '3 steps targeted a refused address'],
    [{ kind: 'blocked', tier: 'chromium' }, 'blocked at chromium'],
    [{ kind: 'skipped', why: 'cooldown' }, 'skipped — in failure cooldown'],
    [{ kind: 'skipped', why: 'disabled' }, 'skipped — site disabled'],
    [{ kind: 'skipped', why: 'no-model' }, 'no LLM model configured'],
    [{ kind: 'error', message: 'bad llm output', permanent: false }, 'bad llm output'],
  ])('%j -> %s', (stop, text) => {
    expect(describeStop(stop)).toBe(text);
  });
});

describe('stopFromError', () => {
  it('maps a reply that would not parse to one malformed failure', () => {
    expect(stopFromError(parseFailure())).toEqual({ kind: 'malformed', failures: 1 });
  });

  it.each([
    ['a permanent LlmError', new LlmError('provider rejected the prompt', 'release-pick', { permanent: true }), true],
    ['a transient LlmError', new LlmError('provider timed out', 'release-pick'), false],
  ])('carries %s through with its permanence', (_name, err, permanent) => {
    expect(stopFromError(err)).toEqual({ kind: 'error', message: err.message, permanent });
  });

  it('treats anything else as a non-permanent error', () => {
    expect(stopFromError(new Error('disk on fire'))).toEqual({ kind: 'error', message: 'disk on fire', permanent: false });
  });
});

describe('stopIsSiteFault', () => {
  it.each<[StopReason, boolean]>([
    [{ kind: 'done' }, false],
    [{ kind: 'gave-up', because: 'not-found', reason: 'r' }, false],
    [{ kind: 'gave-up', because: 'blocked', reason: 'r' }, false],
    [{ kind: 'gave-up', because: 'unsure', reason: 'r' }, false],
    [{ kind: 'skipped', why: 'cooldown' }, false],
    [{ kind: 'skipped', why: 'disabled' }, false],
    [{ kind: 'skipped', why: 'no-model' }, false],
    [{ kind: 'exhausted' }, true],
    [{ kind: 'malformed', failures: 3 }, true],
    [{ kind: 'refused', refusals: 3 }, true],
    [{ kind: 'blocked', tier: 'curl' }, true],
    [{ kind: 'error', message: 'x', permanent: false }, true],
  ])('%j -> %s', (stop, fault) => {
    expect(stopIsSiteFault(stop)).toBe(fault);
  });
});
