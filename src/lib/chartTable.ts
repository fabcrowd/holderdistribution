/** Rows the "View data as table" disclosure lists before it cuts to the newest ones. */
export const DEFAULT_TABLE_MAX_ROWS = 60;

/**
 * The newest `maxRows` rows of a chronological series, still in ascending order,
 * with the full count so the caller can say how many were cut.
 */
export const limitTableRows = <T,>(rows: readonly T[], maxRows = DEFAULT_TABLE_MAX_ROWS): { rows: T[]; total: number } => {
  const keep = Math.max(0, Math.floor(maxRows));
  return { rows: rows.slice(Math.max(0, rows.length - keep)), total: rows.length };
};

/** Note under a truncated table; null when every row is listed. */
export const tableNote = (shown: number, total: number): string | null =>
  shown < total ? `Showing the latest ${shown} of ${total} rows.` : null;

/** Drops rows with no measured value, such as the spacer and masked rows a broken line draws through. */
export const rowsWithValues = <T extends Record<string, unknown>>(rows: readonly T[], valueKeys: readonly string[]): T[] =>
  rows.filter((row) => valueKeys.some((key) => row[key] != null));

/** Cell text: a dash for a missing value, otherwise the column's formatter (or the raw value). */
export const formatCell = (value: unknown, format?: (v: unknown) => string): string => {
  if (value == null) return "—";
  return format ? format(value) : String(value);
};

/** Sheet title: the explicit short title, else the caption (the chart's full summary). */
export const tableTitleFor = (caption: string, title?: string): string => (title && title.trim() ? title : caption);

/** Short default title for a plot's data sheet, e.g. "Wallets by date". */
export const defaultTableTitle = (seriesLabels: readonly string[], noun = ""): string =>
  `${seriesLabels.join(" and ")}${noun ? ` ${noun}` : ""} by date`;
