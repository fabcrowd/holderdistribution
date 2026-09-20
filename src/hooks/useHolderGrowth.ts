import { useMemo } from "react";
import { useHoldersHistoryData } from "./useHoldersHistoryData";

export type HolderGrowthPoint = {
  timestamp: string;
  holders: number;
  // Cumulative distinct wallets that have ever held TEL, reclassified
  // against the CURRENT non-retail set (see scripts/recompute-history-from-
  // git.js). Combined view only — the "ever held" set is chain-agnostic.
  cumulativeHolders: number | null;
  // Whole days since the previous sample; null on the first point. Normally 1.
  // A value >1 means the pipeline produced no snapshot for the intervening
  // dates, so the segment leading into this point spans unmeasured time — see
  // the 2026-08-11-pipeline-outage event in config/classification-changelog.json,
  // a four-day gap with no tel-holders.json blob to recover the dates from.
  // Consumers should break the line rather than interpolate across it: drawing
  // a straight segment there presents four unmeasured days as observed data,
  // and it also lands the whole backlog of first-time addresses in the
  // resuming day's newHolders (552 on 2026-08-15, against a ~40/day norm).
  gapDays: number | null;
};

export type BalanceGrowthPoint = {
  timestamp: string;
  // Retail-only on-chain balance (already excludes CEX/DEX/other non-retail
  // addresses at the source — see scripts/lib/stakingAttribution.js).
  retail: number;
  // CEX custody balance for this date, or null if not yet populated for an
  // older entry (see combined.cexBalance in scripts/generate-holders-history.js
  // / recompute-history-from-git.js / rebuild-history-from-logs.js).
  cex: number | null;
  // DEX liquidity balance for this date, or null — sparse until
  // scripts/backfill-dex-liquidity-history.js has been run (see tasks/todo.md).
  // Suppressed entirely below unless the archive holds at least two populated
  // points, because a single measured date is not a trend: summing it into
  // anything makes the day measurement STARTED look like a ~932M inflow.
  dex: number | null;
  // NOTE: there is deliberately no `total` here. A blended retail+cex+dex line
  // was removed on 2026-08-22 — it is invariant to exactly the movement this
  // page exists to show (1B rotating from exchanges into self-custody leaves
  // it flat), and it inherited every component's measurement gaps. Plot the
  // components; let the reader see the rotation. See tasks/todo.md.
};

export type StakingGrowthPoint = {
  timestamp: string;
  staking: number;
};

export type DexLiquidityGrowthPoint = {
  timestamp: string;
  dexLiquidity: number;
};

export type HolderGrowthData = {
  view: "combined" | "ethereum" | "polygon" | "base";
  days: number;
  updatedAt: string | null;
  feedError: boolean;
  series: HolderGrowthPoint[];
  balanceSeries: BalanceGrowthPoint[];
  stakingSeries: StakingGrowthPoint[];
  dexLiquiditySeries: DexLiquidityGrowthPoint[];
};

type HolderGrowthQuery = {
  view: HolderGrowthData["view"];
  days: number;
  enabled?: boolean;
};

/**
 * Derives view/days-specific growth series from the single shared
 * holders-history.json fetch (see useHoldersHistoryData). No network
 * request happens here — this hook is pure client-side derivation over
 * the shared raw payload, memoized per (view, days).
 */
export const useHolderGrowth = ({ view, days, enabled = true }: HolderGrowthQuery) => {
  const query = useHoldersHistoryData();
  const { data: payload, isError, isLoading, isFetching } = query;

  const data = useMemo<HolderGrowthData | undefined>(() => {
    if (!enabled || !view) return undefined;
    if (isError) return undefined;
    if (!payload) return undefined;

    const entries = Array.isArray(payload.entries) ? payload.entries : [];

    if (entries.length === 0) {
      // Mirrors the old per-request 404 handling: no entries at all.
      return {
        view,
        days,
        updatedAt: null,
        feedError: true,
        series: [],
        balanceSeries: [],
        stakingSeries: [],
        dexLiquiditySeries: [],
      };
    }

    const normalizedEntries = entries
      .map((entry) => {
        const timestamp = Date.parse(entry.generatedAt ?? entry.date);
        if (!Number.isFinite(timestamp)) return null;
        const holderCount =
          view === "combined"
            ? entry?.combined?.holderCount ?? 0
            : entry?.chains?.[view]?.holderCount;
        if (!Number.isFinite(holderCount) || holderCount <= 0) return null;
        const cumulativeHolders =
          view === "combined" && Number.isFinite(entry?.cumulativeHolders)
            ? (entry.cumulativeHolders as number)
            : null;
        // Retail-only balance — already excludes CEX/DEX at the source, no
        // subtraction needed (see scripts/lib/stakingAttribution.js).
        const retailRaw = entry?.combined?.totalBalance;
        const retail =
          view === "combined" && Number.isFinite(retailRaw) && (retailRaw ?? 0) > 0
            ? (retailRaw as number)
            : null;
        const cexRaw = entry?.combined?.cexBalance;
        const cex =
          view === "combined" && Number.isFinite(cexRaw) ? (cexRaw as number) : null;
        const staking =
          view === "combined" && Number.isFinite(entry?.combined?.stakingBalance) && (entry.combined.stakingBalance ?? 0) > 0
            ? (entry.combined.stakingBalance as number)
            : null;
        const dexLiqRaw = entry?.combined?.dexLiquidity;
        const dexLiquidity =
          view === "combined" && Number.isFinite(dexLiqRaw) && (dexLiqRaw ?? 0) > 0
            ? (dexLiqRaw as number)
            : null;
        return { timestamp, holders: holderCount, cumulativeHolders, retail, cex, staking, dexLiquidity };
      })
      .filter((entry): entry is {
        timestamp: number;
        holders: number;
        cumulativeHolders: number | null;
        retail: number | null;
        cex: number | null;
        staking: number | null;
        dexLiquidity: number | null;
      } => !!entry)
      .sort((a, b) => a.timestamp - b.timestamp);

    const latestTimestamp = normalizedEntries.length
      ? normalizedEntries[normalizedEntries.length - 1].timestamp
      : null;
    const cutoff =
      latestTimestamp !== null
        ? latestTimestamp - days * 24 * 60 * 60 * 1000
        : null;
    const filteredEntries = cutoff === null
      ? []
      : normalizedEntries.filter((entry) => entry.timestamp >= cutoff);

    // gapDays is measured against the previous entry in the FULL series, not
    // the filtered one — otherwise the first point of every range would report
    // a spurious gap back to whatever the cutoff happened to exclude.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const indexInAll = new Map(normalizedEntries.map((entry, i) => [entry.timestamp, i]));
    const series = filteredEntries.map((entry) => {
      const i = indexInAll.get(entry.timestamp) ?? 0;
      const previous = i > 0 ? normalizedEntries[i - 1] : null;
      return {
        timestamp: new Date(entry.timestamp).toISOString(),
        holders: entry.holders,
        cumulativeHolders: entry.cumulativeHolders,
        gapDays: previous ? Math.round((entry.timestamp - previous.timestamp) / DAY_MS) : null,
      };
    });

    // One measured DEX point is not a series. dexLiquidity is currently
    // populated on 1 of 233 archive entries, and any consumer that sums or
    // diffs it renders the day measurement STARTED as a ~932M inflow. Suppress
    // the component here — at the source — rather than in each chart, so a
    // future consumer can't reintroduce the artifact. Resolved for real by
    // running .github/workflows/backfill-dex-liquidity-history.yml (see
    // tasks/todo.md); once ≥2 dates are populated this passes through normally.
    const dexPointCount = filteredEntries.filter((entry) => entry.dexLiquidity !== null).length;
    const dexIsPlottable = dexPointCount >= 2;

    const balanceSeries = filteredEntries
      .filter((entry): entry is typeof entry & { retail: number } => entry.retail !== null)
      .map((entry) => ({
        timestamp: new Date(entry.timestamp).toISOString(),
        retail: entry.retail,
        cex: entry.cex,
        dex: dexIsPlottable ? entry.dexLiquidity : null,
      }));

    const stakingSeries = filteredEntries
      .filter((entry): entry is typeof entry & { staking: number } => entry.staking !== null)
      .map((entry) => ({
        timestamp: new Date(entry.timestamp).toISOString(),
        staking: entry.staking,
      }));

    const dexLiquiditySeries = filteredEntries
      .filter((entry): entry is typeof entry & { dexLiquidity: number } => entry.dexLiquidity !== null)
      .map((entry) => ({
        timestamp: new Date(entry.timestamp).toISOString(),
        dexLiquidity: entry.dexLiquidity,
      }));

    // Feed error: if the most recent entry is more than 2 days old the
    // pipeline is offline or has been failing silently.
    const latestEntryDate = normalizedEntries.length
      ? normalizedEntries[normalizedEntries.length - 1].timestamp
      : null;
    const feedError =
      latestEntryDate === null ||
      Date.now() - latestEntryDate > 2 * 24 * 60 * 60 * 1000;

    return {
      view,
      days,
      updatedAt: payload.generatedAt ?? null,
      feedError,
      series,
      balanceSeries,
      stakingSeries,
      dexLiquiditySeries,
    };
  }, [payload, isError, view, days, enabled]);

  return {
    ...query,
    data,
    isLoading: enabled ? isLoading : false,
    isFetching: enabled ? isFetching : false,
  };
};
