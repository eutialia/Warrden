import type { ArrApi } from './types.js';
import type { Tracer } from '../trace/tracer.js';
import { errorMessage } from '../util/errors.js';

// Every ArrApi method that changes arr state. Read-only calls are noise in the debug
// view; these are the rows an operator scans for when asking "what did Warrden actually
// do to my library?", so a new mutator added to ArrApi belongs here too.
const SIDE_EFFECT_METHODS = new Set([
  'grabRelease',
  'executeManualImport',
  'updateSeries',
  'createTag',
  'deleteTag',
  'createReleaseProfile',
  'updateReleaseProfile',
  'deleteReleaseProfile',
  'createNotification',
  'deleteNotification',
]);

// Proxy over explicit method wrappers: ArrApi grows methods over time and every one
// of them is an HTTP call worth the same treatment.
export function traceArrClient(api: ArrApi, trace: Tracer, jobId: number): ArrApi {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        const step = trace.begin({
          jobId,
          kind: 'arr.request',
          summary: prop,
          sideEffect: SIDE_EFFECT_METHODS.has(prop),
          payload: () => ({ args }),
        });
        let out: unknown;
        try {
          out = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (err) {
          step.end('error', () => ({ args, error: errorMessage(err) }));
          throw err;
        }
        if (!(out instanceof Promise)) {
          step.end('ok', () => ({ args }));
          return out;
        }
        return out.then(
          (result) => {
            step.end('ok', () => ({ args, result }));
            return result;
          },
          (err: unknown) => {
            step.end('error', () => ({ args, error: errorMessage(err) }));
            throw err;
          },
        );
      };
    },
  });
}
