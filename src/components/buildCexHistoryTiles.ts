import type { CexHistoryEntry } from "@/hooks/useCexBalanceHistory";
import { pickBaseline } from "@/lib/baseline";

/** Hide dust-only exchanges from sparklines (e.g. OKX ~1.71 TEL). Table still lists them. */
export const MIN_CEX_TILE_BALANCE = 1000;

export type CexHistoryTile = {
  name: string;
  series: Array<{ timestamp: number; balance: number }>;
  current: number;
  change: number | null;
};

export function buildCexHistoryTiles(
  entries: CexHistoryEntry[] | null | undefined,
  rangeDays: number,
  minBalance: number = MIN_CEX_TILE_BALANCE,
): CexHistoryTile[] {
  if (!entries || entries.length === 0) return [];
  const latestTs = Date.parse(entries[entries.length - 1].date);
  const cutoff = latestTs - rangeDays * 86400000;
  const inRange = entries.filter((e) => Date.parse(e.date) >= cutoff);
  if (inRange.length === 0) return [];

  const latest = inRange[inRange.length - 1];
  const names = new Set<string>();
  for (const e of inRange) {
    for (const [name, v] of Object.entries(e.exchanges)) {
      if (v > 0) names.add(name);
    }
  }

  return Array.from(names)
    .map((name) => {
      const series = inRange.map((e) => ({
        timestamp: Date.parse(e.date),
        balance: e.exchanges[name] ?? 0,
      }));
      const current = latest.exchanges[name] ?? 0;
      // Resolve the baseline against the FULL archive (not the cutoff-filtered
      // `inRange` window) with pickBaseline's drift tolerance, so a range the
      // archive doesn't go back far enough for (e.g. "1Y" against a ~7-month
      // archive) reports no change instead of silently using the earliest
      // available point and mislabeling a shorter window as the full range.
      const fullSeries = entries.map((e) => ({
        timestamp: Date.parse(e.date),
        balance: e.exchanges[name] ?? 0,
      }));
      const baseline = pickBaseline(fullSeries, rangeDays, (p) => p.timestamp);
      const change = baseline != null ? current - baseline.balance : null;
      return { name, series, current, change };
    })
    .filter((t) => t.current > minBalance)
    .sort((a, b) => b.current - a.current);
}
