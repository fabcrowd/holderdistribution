const DAY_MS = 86_400_000;

/** Below this much history an "All-time high" is a local high; say how little data backs it. */
export const ATH_THIN_HISTORY_DAYS = 90;

/** Calendar days (UTC, inclusive) between the first and last timestamp; 0 when there is none. */
export const historyDays = (timestamps: readonly number[]): number => {
  const finite = timestamps.filter(Number.isFinite);
  if (finite.length === 0) return 0;
  const first = Math.floor(Math.min(...finite) / DAY_MS);
  const last = Math.floor(Math.max(...finite) / DAY_MS);
  return last - first + 1;
};

/** "Based on N days of data" while the history is short, otherwise null. */
export const athHistoryNote = (days: number, threshold: number = ATH_THIN_HISTORY_DAYS): string | null => {
  if (!Number.isFinite(days) || days <= 0 || days >= threshold) return null;
  return `Based on ${days} ${days === 1 ? "day" : "days"} of data`;
};
