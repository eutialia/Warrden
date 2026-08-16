import type { ArrApi } from './types.js';
import type { Tracer } from '../trace/tracer.js';
import { errorMessage } from '../util/errors.js';

const SIDE_EFFECT_METHODS = new Set(['grabRelease']);

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
