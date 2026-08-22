import { NoObjectGeneratedError } from 'ai';
import { LlmError } from '../src/llm/generator.js';
/**
 * The error `AiSdkGenerator` wraps a reply that could not be parsed into the schema in —
 * what the agent loop must recognise as a bad step rather than a dead site.
 */
export function parseFailure(): Error {
  return new LlmError('Generation failed for callsite "site-search": could not parse', 'site-search', {
    cause: new NoObjectGeneratedError({
      message: 'No object generated',
      text: 'open https://acg.rip/t/1 -> OK',
      response: { id: 'r1', timestamp: new Date(0), modelId: 'stealth/ox-alpha' },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      },
      finishReason: 'stop',
    }),
  });
}
