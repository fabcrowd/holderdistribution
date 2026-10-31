import { FRESH_WINDOW_HOURS } from "@/lib/format";

const HOUR_MS = 60 * 60 * 1000;

/**
 * True when a chart's own feed is older than the page-level snapshot by more
 * than one daily window. Charts load from a separate feed, so they can trail
 * the header stamp; within one window they are the same daily run and the
 * page-level notice is enough.
 */
export const chartLagsPage = (chartIso: string | null | undefined, pageIso: string | null | undefined): boolean => {
  const chartMs = chartIso ? Date.parse(chartIso) : NaN;
  const pageMs = pageIso ? Date.parse(pageIso) : NaN;
  if (Number.isNaN(chartMs) || Number.isNaN(pageMs)) return false;
  return pageMs - chartMs > FRESH_WINDOW_HOURS * HOUR_MS;
};
