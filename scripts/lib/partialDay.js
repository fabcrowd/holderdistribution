/**
 * Partial-day marking for the daily flow feeds.
 *
 * Both flow generators bucket by UTC calendar day and run mid-day, so the final
 * row covers only the hours elapsed so far. Published as-is it looks like a
 * collapse (TEL 2026-10-28: 2M in / 4M out against 23-57M a normal day). The
 * generators mark that row instead of dropping it, so consumers can label it
 * "so far today" and keep it out of totals and rankings. Feeds without the
 * field read as fully settled.
 */

/** UTC calendar date (YYYY-MM-DD) of `now`. */
export const utcDate = (now = new Date()) => now.toISOString().slice(0, 10);

/** The date if it is still in progress at `now` (today UTC or later), else null. */
export const partialDateFor = (latestDate, now = new Date()) =>
  latestDate && latestDate >= utcDate(now) ? latestDate : null;

/**
 * Entries (sorted ascending by date) with `partial: true` on the final row when
 * that day has not finished. Earlier rows are returned untouched, and any stale
 * flag from a previous run is cleared so a completed day settles.
 */
export const markPartialDay = (entries, now = new Date()) => {
  const last = entries.length - 1;
  return entries.map((entry, i) => {
    const { partial: _stale, ...rest } = entry;
    return i === last && partialDateFor(entry.date, now) ? { ...rest, partial: true } : rest;
  });
};
