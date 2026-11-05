const DAY_MS = 86_400_000;

/**
 * Days in the last `windowDays` (yesterday backwards from `todayUtc`) that have no
 * history row, oldest first. Days before the first row are not gaps: the project had
 * no history then, and the as-of rebuild needs a checkpoint committed at or before the
 * day, which a project's first snapshot cannot supply.
 */
export function missingHistoryDates(entries, todayUtc, windowDays) {
  const present = new Set(entries.map((entry) => entry.date));
  const first = entries.map((entry) => entry.date).sort()[0];
  const today = Date.parse(`${todayUtc}T00:00:00Z`);
  const missing = [];
  for (let back = 1; back <= windowDays; back++) {
    const date = new Date(today - back * DAY_MS).toISOString().slice(0, 10);
    if (date > first && !present.has(date)) missing.push(date);
  }
  return missing.sort();
}
