import { isTruncationEnvelope, type TraceEntry } from '@/api';
import { formatTook } from '@/components/debug/laneModel';
import { PayloadView } from '@/components/debug/PayloadView';
import { Facts } from '@/components/debug/StepTab';
import { StatusDot } from '@/components/ToneBadge';
import { tierLabel } from '@/lib/labels';
import type { Tone } from '@/lib/tone';
import { cn } from '@/lib/utils';

/** The `llm.call` payload the generator writes. `system` and `prompt` arrive as strings
 * or, past the per-member cap, as a `TruncationEnvelope`. */
export interface CallPayload {
  callsite?: string;
  system?: unknown;
  prompt?: unknown;
}

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  outputTokenDetails?: { reasoningTokens?: number };
}

interface AttemptPayload {
  provider?: string;
  model?: string;
  output?: unknown;
  usage?: Usage;
  responseId?: string;
  responseModelId?: string;
  finishReason?: string;
  warnings?: unknown[];
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function CallTab({
  call,
  attempts,
  attemptPayloads,
  attemptErrors,
  onRetryPayload,
  turn,
  turnPayload,
  callPayload,
  jobTerminal,
}: {
  call: TraceEntry;
  attempts: TraceEntry[];
  attemptPayloads: Record<number, unknown>;
  attemptErrors: Record<number, string>;
  onRetryPayload: (seq: number) => void;
  turn: TraceEntry | null;
  turnPayload: unknown;
  callPayload: CallPayload | undefined;
  jobTerminal: boolean;
}) {
  const last = attempts[attempts.length - 1];
  const raw = last ? attemptPayloads[last.seq] : undefined;
  // An attempt too big to store whole is the envelope itself, with no facts to read off it;
  // its head is the only output there is, and it beats claiming there is no payload.
  const whole = isTruncationEnvelope(raw) ? raw : null;
  const attempt = whole ? {} : (asRecord(raw) as AttemptPayload);
  const usage = attempt.usage ?? {};
  // A failed attempt carries an error and no output, and a job that died mid-attempt left
  // a row with no payload at all; both must read as "there is none" rather than as a fetch
  // still in flight.
  const pending = last !== undefined && last.hasPayload && raw === undefined;
  const output = pending ? undefined : (whole ?? attempt.output ?? null);
  const outputError = last ? attemptErrors[last.seq] : undefined;
  const retryOutput = () => {
    if (last) onRetryPayload(last.seq);
  };
  const callsite = callPayload?.callsite ?? '—';
  const model = attempt.provider && attempt.model ? `${attempt.provider}/${attempt.model}` : '—';
  const decided = asRecord(attempt.output);
  const ran = asRecord(turnPayload) as { tier?: string; action?: string; detail?: string };

  return (
    <div className="divide-y">
      <div className="p-3">
        <Facts
          rows={[
            ['kind', `llm.call · seq ${call.seq}`],
            ['callsite', callsite],
            ['model', model],
            ['status', `${call.status} · ${formatTook(call, jobTerminal)} · ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`],
            ...(attempt.error ? ([['error', attempt.error]] as [string, string][]) : []),
          ]}
        />
      </div>
      <div className="grid grid-cols-4 gap-2 p-3">
        <Tile label="input tokens" value={usage.inputTokens} />
        <Tile label="cache read" value={usage.cachedInputTokens} tone="info" />
        <Tile label="output" value={usage.outputTokens} />
        <Tile label="reasoning" value={usage.outputTokenDetails?.reasoningTokens} />
      </div>
      {turn && (
        <div className="space-y-2 p-3">
          <h4 className="text-[11px] tracking-wide text-muted-foreground uppercase">Turn</h4>
          <Turn dot="info" head="decided" title={typeof decided.action === 'string' ? decided.action : '—'}>
            <PayloadView value={output} error={outputError} onRetry={retryOutput} />
          </Turn>
          <Turn
            dot={turn.status === 'error' ? 'danger' : 'success'}
            head="ran"
            title={`${turn.kind.slice('agent.'.length)} · ${ran.tier ? tierLabel(ran.tier as never) : ''}`}
            trailing={formatTook(turn, jobTerminal)}
          >
            <p className="font-mono text-[11px] break-all">{turn.summary}</p>
          </Turn>
          <Turn dot="neutral" head="observed" title="fed back to the next call">
            <p className="text-[11px] leading-relaxed whitespace-pre-wrap">{ran.detail ?? turn.summary}</p>
          </Turn>
        </div>
      )}
      {!turn && (
        <div className="space-y-2 p-3">
          <h4 className="text-[11px] tracking-wide text-muted-foreground uppercase">Output</h4>
          <PayloadView value={output} error={outputError} onRetry={retryOutput} />
        </div>
      )}
      <div className="p-3">
        <Facts
          rows={[
            ['provider', attempt.provider ?? '—'],
            ['response', attempt.responseId ?? '—'],
            ['model id', attempt.responseModelId ?? attempt.model ?? '—'],
            ['finish', attempt.finishReason ?? '—'],
            ['warnings', attempt.warnings && attempt.warnings.length > 0 ? JSON.stringify(attempt.warnings) : 'none'],
          ]}
        />
      </div>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number | undefined; tone?: 'info' }) {
  return (
    <div>
      <div className={cn('font-serif text-lg leading-none', tone === 'info' && 'text-info-foreground')}>{value === undefined ? '—' : value.toLocaleString()}</div>
      <div className="mt-1 text-[10.5px] text-muted-foreground">{label}</div>
    </div>
  );
}

function Turn({
  dot,
  head,
  title,
  trailing,
  children,
}: {
  dot: Tone;
  head: string;
  title: string;
  trailing?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-sm border text-xs">
      <div className="flex items-center gap-2 border-b px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <StatusDot tone={dot} size="sm" />
        <b className="font-medium text-foreground">{head}</b>
        <span>{title}</span>
        {trailing && <span className="ml-auto font-mono">{trailing}</span>}
      </div>
      <div className="p-2.5">{children}</div>
    </div>
  );
}
