import type { HolderHistoryEntry } from "@/hooks/useHoldersHistoryData";
import type { HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";

export const TREND_DAYS = 30;
const DAY_MS = 86_400_000;

export type TrendPoint = { t: number; v: number };
export type CardTrend = { points: TrendPoint[]; first: TrendPoint; last: TrendPoint; spanDays: number };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Retail-wallet series for a landing-card sparkline: holders-history
 * `combined.holderCount` (same series as the terminal's "Retail wallets" chart)
 * for the last `days` days ending at the newest entry. Null with fewer than two
 * usable points, so callers show a placeholder instead of a dot or flat line.
 */
export const cardTrend = (
  entries: readonly Pick<HolderHistoryEntry, "date" | "combined">[] | null | undefined,
  days = TREND_DAYS,
): CardTrend | null => {
  const all: TrendPoint[] = [];
  for (const e of entries ?? []) {
    const t = Date.parse(`${e?.date}T00:00:00Z`);
    const v = e?.combined?.holderCount;
    if (Number.isFinite(t) && finite(v)) all.push({ t, v });
  }
  all.sort((a, b) => a.t - b.t);
  if (all.length === 0) return null;
  const cutoff = all[all.length - 1].t - days * DAY_MS;
  const points = all.filter((p) => p.t >= cutoff);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  return { points, first, last, spanDays: Math.round((last.t - first.t) / DAY_MS) };
};

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
