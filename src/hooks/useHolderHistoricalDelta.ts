import { useMemo } from "react";
import type { ChainView } from "@/lib/chainViews";
import { useHoldersHistoryData } from "./useHoldersHistoryData";
import { pickBaseline } from "@/lib/baseline";
import { combinedStaked, v3StakedOn } from "@/lib/staking";

export type HistoricalDistributionRow = {
  label: string;
  count: number;
  totalBalance: number;
};

export type HistoricalDelta = {
  holderCount: number | null;
  retailHolderCount: number | null;
  totalBalance: number | null;
  // View-appropriate baseline for the "Total TEL Held" tile: combined view
  // prefers entry.combined.totalHeld (retail + CEX, the authoritative field
  // — see lessons.md "Re-labelling Is Not an Inflow"), falling back to
  // totalBalance only if totalHeld is absent from an older entry; chain
  // views have no CEX in this tile so it's just that chain's totalBalance.
  // One field so every consumer reads the same baseline regardless of view,
  // instead of hand-summing totalBalance + a separately-fetched CEX figure.
  totalHeld: number | null;
  /** Legacy staking contract only. */
  stakingBalance: number | null;
  /** v3 StakingModule on the baseline date: 0 before its deploy, null when unmeasured. */
  stakingV3Balance: number | null;
  /** Legacy + v3; null when either is unknown (compare "Staked TEL" against this). */
  stakingTotal: number | null;
  concentrationTop: Record<string, number> | null;
  distribution: HistoricalDistributionRow[] | null;
  cumulativeHolders: number | null;
  latestCumulativeHolders: number | null;
  referenceDate: string | null; // actual date of the comparison entry
};

const EMPTY_DELTA: HistoricalDelta = {
  holderCount: null,
  retailHolderCount: null,
  totalBalance: null,
  totalHeld: null,
  stakingBalance: null,
  stakingV3Balance: null,
  stakingTotal: null,
  concentrationTop: null,
  distribution: null,
  cumulativeHolders: null,
  latestCumulativeHolders: null,
  referenceDate: null,
};

type QueryParams = {
  view: ChainView;
  days: number;
  enabled?: boolean;
};

/**
 * Derives the view/days-specific historical comparison from the single
 * shared holders-history.json fetch (see useHoldersHistoryData). No
 * network request happens here — pure client-side derivation, memoized
 * per (view, days).
 */
export const useHolderHistoricalDelta = ({ view, days, enabled = true }: QueryParams) => {
  const query = useHoldersHistoryData();
  const { data: payload, isError, isLoading, isFetching } = query;
  const active = enabled && days >= 1;

  const data = useMemo<HistoricalDelta | undefined>(() => {
    if (!active) return undefined;
    // Original behaviour: any non-ok response (not just 404) resolved to
    // the empty-delta shape rather than throwing.
    if (isError) return EMPTY_DELTA;
    if (!payload) return undefined;

    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    if (entries.length === 0) return EMPTY_DELTA;

    const sorted = entries
      .map((e) => ({ ...e, ts: Date.parse(e.generatedAt ?? e.date) }))
      .filter((e) => Number.isFinite(e.ts))
      .sort((a, b) => a.ts - b.ts);

    if (sorted.length === 0) return EMPTY_DELTA;

    // A gap in the daily snapshot archive can leave the closest match far
    // from the actual target — e.g. a missed week silently turns a "vs 7
    // days ago" comparison into "vs 14 days ago" while every caller still
    // labels it with the nominal range. pickBaseline rejects anything more
    // than half the requested window (min 3 days) off-target rather than
    // return a comparison that's silently mislabeled.
    const closest = pickBaseline(sorted, days, (e) => e.ts);
    if (!closest) {
      return {
        ...EMPTY_DELTA,
        latestCumulativeHolders: sorted[sorted.length - 1]?.cumulativeHolders ?? null,
      };
    }

    const referenceDate = closest.date ?? null;
    const latestCumulativeHolders = sorted[sorted.length - 1]?.cumulativeHolders ?? null;

    if (view === "combined") {
      const holderCount = Math.max(
        closest.combined?.holderCount ?? 0,
        closest.combined?.holderCountWithStakers ?? 0,
      );
      return {
        holderCount: holderCount > 0 ? holderCount : null,
        retailHolderCount: closest.combined?.retailHolderCount ?? null,
        totalBalance: closest.combined?.totalBalance ?? null,
        totalHeld: closest.combined?.totalHeld ?? closest.combined?.totalBalance ?? null,
        stakingBalance: closest.combined?.stakingBalance ?? null,
        stakingV3Balance: v3StakedOn(closest.date, closest.combined?.stakingV3Balance),
        stakingTotal: combinedStaked(
          closest.combined?.stakingBalance ?? null,
          v3StakedOn(closest.date, closest.combined?.stakingV3Balance),
        ),
        concentrationTop: closest.concentration ?? null,
        distribution: closest.distribution ?? null,
        cumulativeHolders: closest.cumulativeHolders ?? null,
        latestCumulativeHolders,
        referenceDate,
      };
    }

    const chain = closest.chains?.[view];
    return {
      holderCount: chain?.holderCount ?? null,
      retailHolderCount: chain?.retailHolderCount ?? null,
      totalBalance: chain?.totalBalance ?? null,
      totalHeld: chain?.totalBalance ?? null,
      stakingBalance: null,
      stakingV3Balance: null,
      stakingTotal: null,
      concentrationTop: chain?.concentration ?? null,
      distribution: chain?.distribution ?? null,
      cumulativeHolders: null,
      latestCumulativeHolders,
      referenceDate,
    };
  }, [payload, isError, view, days, active]);

  return {
    ...query,
    data,
    isLoading: active ? isLoading : false,
    isFetching: active ? isFetching : false,
  };
};
