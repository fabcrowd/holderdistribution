export type ClassificationEvent = {
  id: string;
  date: string; // ISO date, e.g. "2026-08-08"
  type: "cex-relabel" | "exclusion-add" | "exclusion-remove" | "threshold-change" | "dune-sync" | "other";
  summary: string;
  affects: {
    artifacts: string[];
    metrics: string[];
    chains?: string[];
  };
  backfillStatus: "complete" | "partial" | "not-planned" | "deferred";
  backfillNote?: string;
  dateConfidence?: "exact" | "approximate";
};

export type ClassificationChangelog = {
  schemaVersion: number;
  generatedAt: string;
  events: ClassificationEvent[];
};

/**
 * Events from `changelog` whose `date` falls strictly inside (fromMs, toMs]
 * and whose `affects.metrics` includes `metric` — i.e. a reclassification
 * that happened between the two dates a delta is comparing, for a metric
 * that reclassification actually touches. Events already fully backfilled
 * (`backfillStatus: "complete"`) are excluded — their history no longer
 * embeds the old classification, so there's nothing left to explain.
 *
 * `fromMs` is exclusive so an event ON the earlier snapshot's own date
 * doesn't flag every delta computed FROM that date forward; `toMs` is
 * inclusive so an event on today's date still flags today's delta.
 */
export const getEventsAffecting = (
  changelog: ClassificationChangelog | null | undefined,
  metric: string,
  fromMs: number,
  toMs: number,
): ClassificationEvent[] => {
  if (!changelog?.events?.length) return [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return [];

  return changelog.events.filter((event) => {
    if (event.backfillStatus === "complete") return false;
    if (!event.affects?.metrics?.includes(metric)) return false;
    const eventMs = Date.parse(event.date);
    if (!Number.isFinite(eventMs)) return false;
    return eventMs > fromMs && eventMs <= toMs;
  });
};
