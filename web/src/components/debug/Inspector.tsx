import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { JobDetailResponse, TraceEntry } from '@/api';
import { RunBody } from '@/components/activity/RunDetail';
import { CallTab } from '@/components/debug/CallTab';
import { PayloadView } from '@/components/debug/PayloadView';
import { StepTab } from '@/components/debug/StepTab';
import { StatusNotice } from '@/components/StatusNotice';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type InspectorTab = 'step' | 'prompt' | 'raw' | 'story' | 'job';

export function Inspector({
  entries,
  selected,
  payload,
  payloadError,
  payloadErrors,
  onRetryPayload,
  childPayloads,
  turn,
  turnPayload,
  detail,
  detailError,
  onRetryDetail,
  tab,
  onTab,
  onClose,
  now,
  jobTerminal,
}: {
  entries: TraceEntry[];
  selected: TraceEntry | null;
  payload: unknown;
  payloadError?: string;
  payloadErrors: Record<number, string>;
  onRetryPayload: (seq: number) => void;
  childPayloads: Record<number, unknown>;
  turn: TraceEntry | null;
  turnPayload: unknown;
  detail: JobDetailResponse | null;
  detailError: string | null;
  onRetryDetail: () => void;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  onClose: () => void;
  now: number;
  jobTerminal: boolean;
}) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isCall = selected?.kind === 'llm.call';
  const tabs: { id: InspectorTab; label: string; enabled: boolean }[] = [
    { id: 'step', label: isCall ? 'Call' : 'Step', enabled: selected !== null },
    { id: 'prompt', label: 'Prompt', enabled: isCall },
    { id: 'raw', label: 'Raw', enabled: selected !== null },
    { id: 'story', label: 'Story', enabled: true },
    { id: 'job', label: 'Job', enabled: true },
  ];
  // The tab the URL or a previous selection asked for may not exist for this entry (Prompt
  // on an arr call, Step on nothing selected); fall back rather than draw an empty panel.
  const active = tabs.find((t) => t.id === tab && t.enabled)?.id ?? (selected ? 'step' : 'story');
  const attempts = selected ? entries.filter((e) => e.parent_seq === selected.seq && e.kind === 'llm.attempt') : [];
  const callPayload = payload as { system?: string; prompt?: string } | undefined;
  // An entry with no payload row never resolves, so "Loading…" has to be reachable only
  // while a fetch is actually out.
  const promptFallback = selected?.hasPayload && payload === undefined ? 'Loading…' : '—';
  const retrySelected = () => {
    if (selected) onRetryPayload(selected.seq);
  };

  return (
    // One panel bound to `active` rather than five: the body already switches on the active
    // tab, and a trigger controlling no panel is a dead control to anything reading the page.
    <Tabs className="h-full min-h-0 gap-0" value={active} onValueChange={(v) => onTab(v as InspectorTab)}>
      <div className="sticky top-0 flex items-center border-b bg-background px-2">
        <TabsList variant="line" className="h-9 flex-1 justify-start p-0">
          {tabs
            .filter((t) => t.enabled)
            .map((t) => (
              <TabsTrigger key={t.id} value={t.id} className="h-full flex-none px-2 text-xs">
                {t.label}
              </TabsTrigger>
            ))}
        </TabsList>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close inspector">
          <X />
        </Button>
      </div>
      <TabsContent value={active} className="min-h-0 flex-1 overflow-y-auto">
        {active === 'step' && selected && !isCall && (
          <StepTab entry={selected} payload={payload} payloadError={payloadError} onRetryPayload={retrySelected} now={now} jobTerminal={jobTerminal} />
        )}
        {active === 'step' && selected && isCall && (
          <CallTab
            call={selected}
            attempts={attempts}
            attemptPayloads={childPayloads}
            attemptErrors={payloadErrors}
            onRetryPayload={onRetryPayload}
            turn={turn}
            turnPayload={turnPayload}
            now={now}
            jobTerminal={jobTerminal}
          />
        )}
        {active === 'prompt' && isCall && (
          <div className="space-y-3 p-3">
            {payloadError !== undefined ? (
              <PayloadView value={undefined} error={payloadError} onRetry={retrySelected} />
            ) : (
              <>
                <h4 className="text-[11px] tracking-wide text-muted-foreground uppercase">System</h4>
                <pre className="rounded-sm border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {callPayload?.system ?? promptFallback}
                </pre>
                <h4 className="text-[11px] tracking-wide text-muted-foreground uppercase">Prompt</h4>
                <pre className="rounded-sm border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {callPayload?.prompt ?? promptFallback}
                </pre>
              </>
            )}
          </div>
        )}
        {active === 'raw' && selected && (
          <div className="p-3">
            <PayloadView value={selected.hasPayload ? payload : null} error={selected.hasPayload ? payloadError : undefined} onRetry={retrySelected} />
          </div>
        )}
        {active === 'story' && (
          <div className="p-3">
            {detailError ? <StatusNotice message={detailError} onRetry={onRetryDetail} /> : detail ? <RunBody data={detail} /> : <Spinner className="text-muted-foreground" />}
          </div>
        )}
        {active === 'job' && (
          <div className="p-3">
            <PayloadView value={detail?.job ?? (detailError ? null : undefined)} />
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
