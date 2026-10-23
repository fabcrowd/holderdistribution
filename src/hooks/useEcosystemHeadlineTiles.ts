import { useMemo } from "react";
import { Users, Database, Layers, Building2, type LucideIcon } from "lucide-react";
import { useHolderLiteSnapshot, type HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { useHolderGrowth } from "@/hooks/useHolderGrowth";
import { useHeadlineTiles } from "@/hooks/useHeadlineTiles";
import type { ClassificationEvent } from "@/hooks/useClassificationChangelog";
import { v3StakingGapEvents } from "@/lib/staking";

const formatInteger = (v: number) => new Intl.NumberFormat().format(v);
const formatTokenAmount = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);
};
const pctOfSupply = (v: number, supply: number) => (supply > 0 ? `${((v / supply) * 100).toFixed(2)}% of supply` : "");

export type EcosystemHeadlineTileId = "holders" | "retailHeld" | "staked" | "cex";

export type EcosystemHeadlineTile = {
  /** Stable identity for routing: each tile is a link to the charts behind it
   *  (see TILE_DESTINATIONS in Holders.tsx). Not derived from `label`, which
   *  is copy and has been reworded twice. */
  id: EcosystemHeadlineTileId;
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  ath: boolean;
  current: number | null;
  previous: number | null;
  fmt: ((v: number) => string) | undefined;
  changelogEvents?: ClassificationEvent[];
  infoTooltip?: string | null;
  tone?: "neutral" | "auto";
  /** "all" = the value isn't splittable by chain (exchange custody is
   *  tracked per exchange, not per chain), so it stays the all-chains figure
   *  whichever chain is selected and is labelled that way. */
  scope: "chain" | "all";
};

export type HeadlineView = "combined" | "ethereum" | "polygon" | "base";

/**
 * The four Ecosystem Headline numbers, extracted from HolderKpiHero so a
 * second, compact presentation (the sticky-bar strip shown once the full
 * tiles scroll out of view) can render the exact same values without a
 * second derivation to drift out of sync with the first — see lessons.md,
 * "Two Counts of the Same Thing on One Page Must Reconcile By Construction".
 * react-query's cache means calling this from two components costs no extra
 * network request.
 */
export const useEcosystemHeadlineTiles = (rangeDays: number, chain: HeadlineView = "combined") => {
  const { data } = useHolderLiteSnapshot();
  const snap = data as HolderLiteSnapshot | undefined;
  // Separate, effectively-unbounded fetch for the ATH check — a 365-day
  // series would only cover "was today higher than any day in the last
  // year", which happens to equal true all-time today only because history
  // began under a year ago. Once the archive exceeds 365 days this would
  // start awarding a false "ATH" badge for a merely-recent local high.
  const { data: fullHistory } = useHolderGrowth({ view: chain, days: 36500 });
  // Shared with WalletHoldingsWidget's Holder Snapshot section, so these
  // four tiles can never show a different delta depending on which
  // component renders them — see useHeadlineTiles' doc comment.
  const { historicalDelta, cexPrevious, events } = useHeadlineTiles({ view: chain, rangeDays });

  const isAth = useMemo(() => {
    const series = fullHistory?.series;
    if (!snap || !series?.length) return false;
    const holders = series.map((p) => p.holders);
    const latest = snap.views[chain]?.metrics.holderCount ?? 0;
    return latest > 0 && latest >= Math.max(...holders);
  }, [fullHistory, snap, chain]);

  return useMemo<{ tiles: EcosystemHeadlineTile[]; isAth: boolean } | null>(() => {
    if (!snap) return null;
    // Per-chain view when a chain is picked; holders-lite carries the same
    // metrics block for every chain. Falls back to combined if a chain view
    // is missing from an older snapshot.
    const view = snap.views[chain] ?? snap.views.combined;
    if (!view) return null;
    const perChain = chain !== "combined" && !!snap.views[chain];

    const cexHeld = snap.cex?.overall?.currentBalance ?? 0;
    const holders = view.metrics.holderCount;
    // Retail only. This tile used to show retail + cexHeld, which double-counted
    // the CEX tile beside it (so the four tiles didn't add up) and was invariant
    // to retail<->CEX rotation — 1B moving off exchanges into self-custody left
    // it unchanged, hiding the most price-relevant event the page can show.
    const retailHeld = view.metrics.totalBalance;
    const staked = view.stakingStats?.stakedTotal ?? 0;
    const supply = snap.totals.totalSupply;

    // Retail baseline, not the retail+CEX totalHeld — diffing this value against
    // that baseline would report the entire ~20B CEX book as a change.
    const prevHeld = historicalDelta?.totalBalance ?? null;
    // Staked = legacy + v3 StakingModule, so the baseline must be too. Before
    // the module's deploy v3 was 0 (a valid comparison: the migration out of
    // the legacy contract nets out); after it, v3 wasn't recorded, so the
    // delta is replaced by the "†" explainer rather than reading the
    // migration as a 3B outflow.
    const v3Stats = view.stakingStats?.v3;
    const prevStaked = v3Stats ? historicalDelta?.stakingTotal ?? null : historicalDelta?.stakingBalance ?? null;
    const stakedEvents =
      v3Stats && !perChain && historicalDelta?.referenceDate
        ? v3StakingGapEvents(historicalDelta.referenceDate, historicalDelta.stakingV3Balance, v3Stats.deployDate ?? undefined)
        : [];
    const prevCex = cexPrevious;

    // The "Retail Holders" delta badge shows NET change — same metric every
    // other tile on this page uses (holderCount/totalHeld/stakingBalance vs.
    // their own historicalDelta field), and the same net-of-churn figure
    // TierFlowDiagram's "Retail Wallets, net change" panel shows off the same
    // baseline (DistributionAnalysisWidget's `rows`, same useHolderHistoricalDelta
    // call). Net change can look small — or even negative — during a window
    // with heavy reclassification (wallets gained cancelled out by wallets
    // that left or got excluded), which is real and correct, not a bug; the
    // cumulativeHoldersDelta tooltip below explains why when that happens,
    // instead of silently swapping to a different, larger, unrelated metric
    // (that was tried and reverted — see lessons.md).
    const prevHolders = historicalDelta?.holderCount ?? null;

    // Secondary, clearly-labeled context only — never the primary badge value.
    // cumulativeHolders ("wallets that have ever held TEL", monotonic,
    // reclassification-corrected — scripts/recompute-history-from-git.js)
    // counts gross new-ever-retail wallets, ignoring churn. Useful to explain
    // *why* net change is small/negative even during real adoption, but
    // showing it as the headline number contradicts every other net-change
    // figure on this page.
    const latestCumulative = historicalDelta?.latestCumulativeHolders ?? null;
    const prevCumulative = historicalDelta?.cumulativeHolders ?? null;
    const cumulativeHoldersDelta =
      latestCumulative !== null && prevCumulative !== null ? latestCumulative - prevCumulative : null;
    const cumulativeHoldersTooltip =
      cumulativeHoldersDelta !== null && historicalDelta?.referenceDate
        ? `${cumulativeHoldersDelta >= 0 ? "+" : ""}${formatInteger(cumulativeHoldersDelta)} wallets have newly appeared since ${historicalDelta.referenceDate}, before accounting for wallets that left or were reclassified (e.g. later identified as an exchange). The net change above reflects the current total's actual movement.`
        : null;

    const tiles: EcosystemHeadlineTile[] = [
      {
        id: "holders",
        icon: Users, label: "Retail Holders", value: formatInteger(holders),
        sub: isAth ? "All-time high" : "Wallets >0 TEL, excl. exchanges",
        ath: isAth, current: holders, previous: prevHolders, fmt: undefined, scope: perChain ? "chain" : "all",
        changelogEvents: events.holders,
        infoTooltip: cumulativeHoldersTooltip,
      },
      {
        id: "retailHeld",
        icon: Database, label: "Retail Held", value: formatTokenAmount(retailHeld),
        sub: "Excl. exchanges, treasury & DEX", ath: false,
        current: retailHeld, previous: prevHeld, fmt: formatTokenAmount, scope: perChain ? "chain" : "all",
        // Now relabel-SENSITIVE: moving a wallet between retail and CEX changes
        // this number without any TEL moving, whereas the old retail+CEX blend
        // was invariant to it. So it needs the same changelog suppression the
        // holders tile has — retail.balance events, already computed upstream.
        changelogEvents: events.retailBalance,
        // Staked TEL is a subset of this, not an addition: v3 StakingModule
        // positions are credited to each staker's wallet at the source.
        infoTooltip: v3Stats && !perChain
          ? `Includes ${formatTokenAmount(staked)} staked TEL, of which ${formatTokenAmount(v3Stats.stakedTotal)} is Staked (v3) in the StakingModule. Staked TEL is counted once, inside this figure.`
          : null,
      },
      {
        id: "staked",
        icon: Layers, label: "Staked TEL", value: formatTokenAmount(staked),
        sub: perChain && chain !== "polygon" ? "Staking runs on Polygon" : pctOfSupply(staked, supply),
        // ChangeIndicator only renders (and so only shows the "†") with a
        // baseline; with no v3 baseline, hand it the current value as one.
        ath: false, current: staked, previous: stakedEvents.length ? staked : prevStaked, fmt: formatTokenAmount, scope: perChain ? "chain" : "all",
        changelogEvents: stakedEvents,
      },
      {
        id: "cex",
        icon: Building2, label: "CEX Balance", value: formatTokenAmount(cexHeld),
        sub: perChain ? `All chains · ${pctOfSupply(cexHeld, supply)}` : pctOfSupply(cexHeld, supply),
        ath: false, current: cexHeld, previous: prevCex, fmt: formatTokenAmount,
        // Exchange custody is tracked per exchange wallet list, not per chain.
        scope: "all",
        // Neither direction is inherently good or bad — custody isn't a sale —
        // so this stays neutral rather than implying growth is bad news.
        tone: "neutral",
        changelogEvents: events.cex,
      },
    ];

    return { tiles, isAth };
  }, [snap, historicalDelta, cexPrevious, events, isAth, chain]);
};
