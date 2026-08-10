import { Button } from '@/components/ui/button';

interface StatusNoticeProps {
  message: string;
  onRetry: () => void;
}

/**
 * The message-plus-Retry-button row every page shows when a fetch fails — one component
 * instead of the same two elements written out on each list page. `onRetry` always means
 * "run that request again".
 */
export function StatusNotice({ message, onRetry }: StatusNoticeProps) {
  return (
    <div className="flex items-center gap-2">
      <p className="text-sm text-destructive">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
