/** Top-level `asOf` a feed declares: its last settled UTC day and the block scanned to per chain. */
export type FeedAsOf = { date: string; blocks?: Record<string, number> };

/** An entries array as a feed hook returns it, carrying the payload's `asOf` beside the rows. */
export type WithAsOf<T> = T[] & { readonly asOf?: FeedAsOf | null };

/** Validates a payload's `asOf`; anything malformed or absent is null. */
export const parseFeedAsOf = (payload: unknown): FeedAsOf | null => {
  const raw = (payload as { asOf?: unknown } | null)?.asOf as { date?: unknown; blocks?: unknown } | undefined;
  if (!raw || typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return null;
  if (!Number.isFinite(Date.parse(raw.date))) return null;
  const blocks =
    raw.blocks && typeof raw.blocks === "object"
      ? (Object.fromEntries(Object.entries(raw.blocks as Record<string, unknown>).filter(([, n]) => Number.isFinite(n))) as Record<string, number>)
      : undefined;
  return blocks && Object.keys(blocks).length ? { date: raw.date, blocks } : { date: raw.date };
};

/**
 * Attaches the payload's asOf to `rows` as a non-enumerable field, so existing
 * callers still see a plain array (iteration, length, toEqual unchanged).
 * Queries returning this must set `structuralSharing: false`, which would
 * otherwise rebuild the array and drop the field.
 *
 * WARNING: the field is lost by any array transform (.map, .filter, .slice,
 * spread, a query `select`). Read it with feedAsOf(data) on the hook's own
 * result before transforming; a lost asOf silently falls back to today 00:00.
 */
export const withFeedAsOf = <T,>(rows: T[], payload: unknown): WithAsOf<T> =>
  Object.defineProperty(rows, "asOf", { value: parseFeedAsOf(payload), enumerable: false }) as WithAsOf<T>;

/** The asOf a feed hook's data carries; null when absent (current feeds, mocks, loading). */
export const feedAsOf = (data: unknown): FeedAsOf | null => (data as { asOf?: FeedAsOf | null } | null | undefined)?.asOf ?? null;
