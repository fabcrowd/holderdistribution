import type { HolderHistoryEntry } from "@/hooks/useHoldersHistoryData";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";

export const TREND_DAYS = 30;
const DAY_MS = 86_400_000;

export type TrendPoint = { t: number; v: number };
/** `sinceBreak`: ms of the latest methodology break inside the window; the trend starts there. */
export type CardTrend = { points: TrendPoint[]; first: TrendPoint; last: TrendPoint; spanDays: number; sinceBreak?: number };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Latest break strictly after the window start and not after the newest entry; breaks outside are ignored. */
const latestBreakInWindow = (breaksMs: readonly number[], cutoff: number, newest: number): number | undefined => {
  let latest: number | undefined;
  for (const b of breaksMs) {
    if (finite(b) && b > cutoff && b <= newest && (latest === undefined || b > latest)) latest = b;
  }
  return latest;
};

/**
 * Why a card has no trend: `no-history` (too few usable rows in the window) or
 * `after-break` (rows exist, but the latest methodology break leaves fewer than
 * two). `ok` when `trend` is set.
 */
export type CardTrendReason = "ok" | "no-history" | "after-break";
/** `sinceBreak` is the latest break in the window, also set when it cut the history down to nothing. */
export type CardTrendState = { trend: CardTrend | null; reason: CardTrendReason; sinceBreak?: number };

/**
 * Retail-wallet series for a landing-card sparkline: holders-history
 * `combined.holderCount` (same series as the terminal's "Retail wallets" chart)
 * for the last `days` days ending at the newest entry. When `breaksMs` (series
 * break timestamps, e.g. from `getSeriesBreaks`) fall inside that window, the
 * series restarts at the latest one so a methodology step never reads as growth.
 * Reports why there is no trend so the card can say whether history was cut by a
 * methodology change.
 */
export const cardTrendState = (
  entries: readonly Pick<HolderHistoryEntry, "date" | "combined">[] | null | undefined,
  days = TREND_DAYS,
  breaksMs: readonly number[] = [],
): CardTrendState => {
  const all: TrendPoint[] = [];
  for (const e of entries ?? []) {
    const t = Date.parse(`${e?.date}T00:00:00Z`);
    const v = e?.combined?.holderCount;
    if (Number.isFinite(t) && finite(v)) all.push({ t, v });
  }
  all.sort((a, b) => a.t - b.t);
  if (all.length === 0) return { trend: null, reason: "no-history" };
  const newest = all[all.length - 1].t;
  const cutoff = newest - days * DAY_MS;
  const inWindow = all.filter((p) => p.t >= cutoff);
  const sinceBreak = latestBreakInWindow(breaksMs, cutoff, newest);
  const points = inWindow.filter((p) => sinceBreak === undefined || p.t >= sinceBreak);
  const breakSpan = sinceBreak === undefined ? {} : { sinceBreak };
  if (points.length < 2) {
    // A break only counts as the cause when the window had enough rows before it.
    const cutByBreak = sinceBreak !== undefined && inWindow.length >= 2;
    return { trend: null, reason: cutByBreak ? "after-break" : "no-history", ...breakSpan };
  }
  const first = points[0];
  const last = points[points.length - 1];
  const spanDays = Math.round((last.t - first.t) / DAY_MS);
  return { trend: { points, first, last, spanDays, ...breakSpan }, reason: "ok", ...breakSpan };
};

/** The sparkline trend, or null; see `cardTrendState` for the reason. */
export const cardTrend = (
  entries: readonly Pick<HolderHistoryEntry, "date" | "combined">[] | null | undefined,
  days = TREND_DAYS,
  breaksMs: readonly number[] = [],
): CardTrend | null => cardTrendState(entries, days, breaksMs).trend;

const countFmt = new Intl.NumberFormat("en-US");
const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Whole-number count as the cards show it (en-US grouping). */
export const formatCount = (n: number): string => countFmt.format(n);
/** UTC calendar day as the cards label it, e.g. "Oct 3". */
export const formatTrendDate = (ms: number): string => dateFmt.format(ms);

/** Accessible summary read by screen readers (the SVG itself is a single image). */
export const trendLabel = (name: string, t: CardTrend): string =>
  `${name} retail wallets, ${formatTrendDate(t.first.t)} to ${formatTrendDate(t.last.t)}: ${formatCount(t.first.v)} to ${formatCount(t.last.v)}.`;

/** Placeholder text when a methodology break cut the history below two points. */
export const afterBreakNote = (sinceBreak: number | undefined): string =>
  sinceBreak === undefined
    ? "Not enough data since the latest methodology change."
    : `Not enough data since the ${formatTrendDate(sinceBreak)} methodology change.`;

export type CardConcentration = { top10: string; top100: string };

const DASH = "—";

/**
 * Share of retail-held supply in the top 10 / top 100 holders, from
 * holders-lite views.combined.concentration.top over metrics.retail.balance,
 * the same ratio the terminal's concentration widget shows.
 */
export const cardConcentration = (snap: HolderLiteSnapshot | null | undefined): CardConcentration => {
  const view = snap?.views?.combined;
  const base = view?.metrics?.retail?.balance;
  const share = (n: number): string => {
    const top = view?.concentration?.top?.[String(n)];
    return finite(top) && finite(base) && base > 0 ? `${((top / base) * 100).toFixed(1)}%` : DASH;
  };
  return { top10: share(10), top100: share(100) };
};
