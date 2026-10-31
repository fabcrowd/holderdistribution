/**
 * Dated annotations on a time chart (methodology breaks, reclassifications).
 * They draw as a small marker on the line; the wording lives in the tooltip,
 * so neighbouring annotations collapse into one marker instead of overprinting.
 */

/** Share of the visible span under which two annotations collapse into one marker. */
export const MARKER_COLLAPSE_SHARE = 0.12;

export type MarkerItem = { t: number };
export type MarkerGroup<M extends MarkerItem> = { t: number; items: M[] };
export type MarkerTone = "warning" | "accent" | "muted";
/** An annotation on a time chart: a marker on the line, its wording in the tooltip. */
export type ChartNote = MarkerItem & {
  text: string;
  tone: MarkerTone;
  /** Short one-line wording for the marker's own tooltip; falls back to `text`. */
  tooltip?: string;
};

/** Longest marker tooltip line before it is cut with an ellipsis. */
export const MARKER_TOOLTIP_MAX = 80;

/** One short line for a marker: its first note, plus a count of any others folded into it. */
export const markerTooltip = (group: MarkerGroup<ChartNote>): string => {
  const [first, ...rest] = group.items;
  const base = first.tooltip ?? first.text;
  const line = base.length > MARKER_TOOLTIP_MAX ? `${base.slice(0, MARKER_TOOLTIP_MAX - 1).trimEnd()}…` : base;
  return rest.length > 0 ? `${line} (+${rest.length} more)` : line;
};

/** Gap (ms) under which neighbouring markers share one marker, from the visible X values. */
export const markerCollapseGap = (xs: readonly number[]): number => {
  const finite = xs.filter(Number.isFinite);
  if (finite.length < 2) return 0;
  return (Math.max(...finite) - Math.min(...finite)) * MARKER_COLLAPSE_SHARE;
};

/** Sort by time and merge items closer than `gap`; a group sits on its first item. */
export const groupMarkers = <M extends MarkerItem>(items: readonly M[], gap: number): MarkerGroup<M>[] => {
  const groups: MarkerGroup<M>[] = [];
  for (const item of [...items].sort((a, b) => a.t - b.t)) {
    const last = groups[groups.length - 1];
    if (last && item.t - last.items[last.items.length - 1].t < gap) last.items.push(item);
    else groups.push({ t: item.t, items: [item] });
  }
  return groups;
};

/**
 * Tooltip text per row: each group's texts attach to the first row at/after the
 * group's time, so hovering or tapping that row reveals the annotation.
 */
export const markerNotesByRow = (
  rowTimes: readonly number[],
  groups: readonly MarkerGroup<MarkerItem & { text: string }>[],
): Map<number, string[]> => {
  const notes = new Map<number, string[]>();
  for (const g of groups) {
    const first = rowTimes.find((t) => t >= g.t);
    if (first == null) continue;
    notes.set(first, [...(notes.get(first) ?? []), ...g.items.map((i) => i.text)]);
  }
  return notes;
};

/** Date-keyed notes (suffix "YYYY-MM-DD") as warning chart notes; unparseable dates are skipped. */
export const datedNotes = (entries: readonly { suffix: string; text: string }[]): ChartNote[] =>
  entries.flatMap((e) => {
    const t = Date.parse(e.suffix);
    return Number.isFinite(t) && e.text ? [{ t, text: e.text, tone: "warning" as const }] : [];
  });

/** Reclassification events as chart notes (muted; the summary is the note). */
export const reclassMarkers = (events: readonly { date: string; summary: string }[]): ChartNote[] =>
  events.flatMap((e) => {
    const t = Date.parse(e.date);
    return Number.isFinite(t) ? [{ t, text: `Reclassified: ${e.summary}`, tone: "muted" as const }] : [];
  });
