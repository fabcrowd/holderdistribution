const DAY_MS = 86_400_000;

const isMarkedSettled = (entry) => entry.settled === true || entry.asOf?.settled === true;
const isExplicitlyUnsettled = (entry) => entry.settled === false || entry.asOf?.settled === false;

/**
 * Days in the last `windowDays` (yesterday backwards from `todayUtc`) that need a
 * settled history row, oldest first. A day is missing when it has no row, when its
 * row is explicitly unsettled (a live snapshot), or when it is unmarked and newer than
 * the newest settled row (rows written before the settled marker existed, and any day
 * the daily run could not pin). The gap fill rebuilds these with --as-of.
 * Days before the first row are not gaps: the project had no history then.
 */
export function missingHistoryDates(entries, todayUtc, windowDays) {
  const byDate = new Map(entries.map((entry) => [entry.date, entry]));
  const first = entries.map((entry) => entry.date).sort()[0];
  const newestSettled = entries.filter(isMarkedSettled).map((entry) => entry.date).sort().at(-1) ?? "";
  const today = Date.parse(`${todayUtc}T00:00:00Z`);
  const missing = [];
  for (let back = 1; back <= windowDays; back++) {
    const date = new Date(today - back * DAY_MS).toISOString().slice(0, 10);
    if (date <= first) continue;
    const row = byDate.get(date);
    if (!row || isExplicitlyUnsettled(row) || (!isMarkedSettled(row) && date > newestSettled)) missing.push(date);
  }
  return missing.sort();
}
