import { historyStartsAfterRange } from "./historyStart";

const dateLabel = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/**
 * Why a growth chart has too few points to draw a line. `count` is the points
 * inside the selected range; `firstMs` is the series' first point overall.
 */
export const emptyHistoryMessage = (count: number, firstMs: number | undefined, rangeDays: number, now: number = Date.now()): string => {
  const start = historyStartsAfterRange(firstMs, rangeDays, now);
  const tracked = start != null ? ` History tracked from ${dateLabel.format(start)}.` : "";
  if (count === 1) return `History is still building: 1 snapshot in this range.${tracked}`;
  if (firstMs == null || !Number.isFinite(firstMs)) return "No history recorded yet.";
  return `No snapshots in this range.${tracked || ` History tracked from ${dateLabel.format(firstMs)}.`}`;
};
