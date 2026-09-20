/**
 * Time-series tooltip helpers.
 *
 * shadcn's ChartTooltipContent resolves a numeric x-axis `label` (unix ms)
 * to the series name via itemConfig — so a formatter that does
 * `new Date(Number(value))` receives "Association — Treasury", produces an
 * Invalid Date, and `Intl.DateTimeFormat.format` throws RangeError. That
 * error is a render-time exception, so ErrorBoundary blanks the whole page
 * the moment the reader hovers a point.
 */

/** Prefer the raw numeric axis label; fall back to the resolved series name. */
export const tooltipFormatterLabel = (label: unknown, fallback: unknown): unknown =>
  typeof label === "number" ? label : fallback;

/** Format a tooltip/axis timestamp without throwing on non-date input. */
export const formatChartTimestamp = (value: unknown, formatter: Intl.DateTimeFormat): string => {
  let ts = NaN;
  if (typeof value === "number") ts = value;
  else if (typeof value === "string") ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return formatter.format(date);
};
