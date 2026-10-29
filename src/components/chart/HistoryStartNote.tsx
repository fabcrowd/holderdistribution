import { historyStartsAfterRange } from "@/lib/historyStart";

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

/**
 * Note for ZoomFrame's header row when a project's history begins inside the
 * selected range, so a short line reads as "tracked since", not as missing data.
 */
export const HistoryStartNote = ({ firstTimestamp, rangeDays }: { firstTimestamp: number | undefined; rangeDays: number }) => {
  const start = historyStartsAfterRange(firstTimestamp, rangeDays);
  if (start == null) return null;
  return (
    <p className="text-[11px] leading-4 text-muted-foreground" data-testid="history-start-note">
      History tracked from {fmt.format(start)}
    </p>
  );
};
