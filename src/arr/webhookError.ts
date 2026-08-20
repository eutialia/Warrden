import { ArrApiError } from './client.js';
import { errorMessage } from '../util/errors.js';

const MAX_BODY_SNIPPET = 180;

const CALLBACK_FAILURE = /connection refused|actively refused|name or service not known|no route to host|cannot assign requested address/i;

/** Operator-facing reason a webhook create/PUT failed, never the arr's stack trace. */
export function webhookFailureDetail(err: unknown, url: string): string {
  const reason = arrReason(err);
  if (isWebhookCallbackFailure(err)) {
    return `${reason} The arr tried to reach ${url} and could not.`;
  }
  return reason;
}

function isWebhookCallbackFailure(err: unknown): boolean {
  if (!(err instanceof ArrApiError) || err.status !== 500) return false;
  const msg = jsonMessage(err.body) ?? err.body;
  return CALLBACK_FAILURE.test(msg);
}

function arrReason(err: unknown): string {
  if (err instanceof ArrApiError) {
    const fromJson = jsonMessage(err.body);
    if (fromJson) return fromJson.endsWith('.') ? fromJson : `${fromJson}.`;
    const snippet = err.body.trim().replace(/\s+/g, ' ').slice(0, MAX_BODY_SNIPPET);
    if (snippet) return `Arr API error ${err.status}: ${snippet}.`;
    return `Arr API error ${err.status}.`;
  }
  const message = errorMessage(err);
  return message.endsWith('.') ? message : `${message}.`;
}

function jsonMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Not JSON — caller uses a truncated raw body instead.
  }
  return undefined;
}
