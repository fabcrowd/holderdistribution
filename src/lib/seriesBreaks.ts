/**
 * Series discontinuities: dates where a history series changed methodology
 * (wallets reclassified, new token version tracked, scan start moved) so the
 * numbers on either side are not comparable. Drawing one line through such a
 * date presents a bookkeeping change as a market move.
 *
 * Declared in the classification changelog (the feed every project already
 * ships) by adding `breaksSeries` to the event — see `ClassificationEvent`.
 * Charts then split the line at the date, label it, and keep the jump out of
 * the y-domain. No per-project code: a project opts a series in by declaring
 * the metric names it affects.
 */
import type { ClassificationChangelog } from "@/lib/classificationChangelog";

export const SERIES_BREAK_LABEL = "Methodology change";
export const SERIES_BREAK_NOTE = "Methodology change — not a market move";

export type SeriesBreak = {
  /** ms timestamp of the first snapshot measured under the new methodology. */
  t: number;
  label: string;
  /** Tooltip / screen-reader text. */
  description: string;
  /** The changelog event's one-line summary, for the marker tooltip. */
  summary?: string;
};

/** Longest event summary shown on a marker tooltip before it is cut with an ellipsis. */
export const BREAK_SUMMARY_MAX = 36;

const shortDate = (t: number) =>
  new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** One short line for a break's marker: "Method change · Oct 3, 2026 · {event summary}". */
export const breakTooltip = (b: SeriesBreak): string => {
  const head = `Method change · ${shortDate(b.t)}`;
  const summary = b.summary?.trim();
  if (!summary) return head;
  const cut = summary.length > BREAK_SUMMARY_MAX ? `${summary.slice(0, BREAK_SUMMARY_MAX - 1).trimEnd()}…` : summary;
  return `${head} · ${cut}`;
};

/**
 * Breaks that fall strictly inside (fromMs, toMs] for any of `metrics`.
 * `breaksSeries.at` (ISO date) overrides the event date when the data's break
 * is not the day the change was documented. Fully backfilled events are
 * skipped: their history no longer contains the old basis.
 */
export const getSeriesBreaks = (
  changelog: ClassificationChangelog | null | undefined,
  metrics: readonly string[],
  fromMs: number | undefined,
  toMs: number = Date.now(),
): SeriesBreak[] => {
  if (fromMs == null || !Number.isFinite(fromMs) || !changelog?.events?.length) return [];
  const seen = new Set<number>();
  const breaks: SeriesBreak[] = [];
  for (const event of changelog.events) {
    const spec = event.breaksSeries;
    if (!spec || event.backfillStatus === "complete") continue;
    if (!spec.metrics?.some((m) => metrics.includes(m))) continue;
    const t = Date.parse(spec.at ?? event.date);
    if (!Number.isFinite(t) || t <= fromMs || t > toMs || seen.has(t)) continue;
    seen.add(t);
    breaks.push({ t, label: SERIES_BREAK_LABEL, description: spec.note ?? SERIES_BREAK_NOTE, summary: event.summary });
  }
  return breaks.sort((a, b) => a.t - b.t);
};

/**
 * Inserts a null-valued spacer row before the first row at/after each break so
 * a line (with connectNulls off) stops at the break instead of crossing it.
 * Same trick as `insertGapBreaks`; the spacer carries no value so it cannot
 * affect a domain or tooltip reading. `rows` must be sorted ascending.
 */
export const insertBreakSpacers = <T extends Record<string, unknown>>(
  rows: T[],
  breakTs: readonly number[],
  timeKey: keyof T,
  nullFields: readonly (keyof T)[],
): Partial<T>[] => {
  if (!breakTs.length) return rows;
  const pending = [...breakTs].sort((a, b) => a - b);
  const out: Partial<T>[] = [];
  rows.forEach((row, i) => {
    const t = row[timeKey] as number;
    while (pending.length && t >= pending[0]) {
      const breakAt = pending.shift() as number;
      const prev = i > 0 ? (rows[i - 1][timeKey] as number) : null;
      if (prev != null && prev < breakAt) {
        const spacer: Partial<T> = { [timeKey]: Math.round((prev + Math.min(breakAt, t)) / 2) } as Partial<T>;
        for (const f of nullFields) (spacer as Record<keyof T, unknown>)[f] = null;
        out.push(spacer);
      }
    }
    out.push(row);
  });
  return out;
};

/** Row time -> description for the first row at/after each break (tooltip text). */
export const breakNotesByRow = (
  rowTimes: readonly number[],
  breaks: readonly SeriesBreak[],
): Map<number, string> => {
  const notes = new Map<number, string>();
  for (const b of breaks) {
    const first = rowTimes.find((t) => t >= b.t);
    if (first != null) notes.set(first, b.description);
  }
  return notes;
};

/** Fewer measured points than this and a smoothed curve invents drama. */
export const MIN_SMOOTH_POINTS = 5;

/**
 * Number of rows that carry a value for any of `keys` when that is below
 * MIN_SMOOTH_POINTS (and at least 1), else null. Charts then draw straight
 * segments with visible points and a "Limited history" note.
 */
export const limitedHistoryCount = <T extends Record<string, unknown>>(
  rows: readonly T[],
  keys: readonly string[],
): number | null => {
  const n = rows.filter((r) => keys.some((k) => r[k] != null)).length;
  return n >= 1 && n < MIN_SMOOTH_POINTS ? n : null;
};
