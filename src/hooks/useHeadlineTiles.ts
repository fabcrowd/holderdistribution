import { useHolderHistoricalDelta } from "./useHolderHistoricalDelta";
import type { ChainView } from "@/lib/chainViews";
import { useCexBalanceHistory } from "./useCexBalanceHistory";
import { useClassificationChangelog, getEventsAffecting, type ClassificationEvent } from "./useClassificationChangelog";
import { pickBaseline } from "@/lib/baseline";

type Params = {
  view: ChainView;
  rangeDays: number;
};

/**
 * Single source of baseline/previous-value data for the headline KPI tiles
 * (Retail Holders, Total TEL Held, Staked TEL, CEX Balance) shared by
 * HolderKpiHero and WalletHoldingsWidget's Holder Snapshot section. Both
 * components used to compute these independently — one always resolved a
 * dated baseline via pickBaseline, the other disabled that at 1D and fell
 * back to three different undated sources (holders-lite previousMetrics for
 * holders/balance, a hardcoded null for staking, the live CEX flow
 * snapshot's own previousBalance for CEX) — so the same tile could show two
 * different deltas depending on which component rendered it. This hook
 * makes that impossible by construction: every caller reads the same
 * pickBaseline-derived value, unconditionally (no rangeDays > 1 gate).
 */
export const useHeadlineTiles = ({ view, rangeDays }: Params) => {
  const days = Math.max(1, rangeDays);
  const { data: historicalDelta } = useHolderHistoricalDelta({ view, days, enabled: true });
  const { data: cexHistory } = useCexBalanceHistory();
  const { data: changelog } = useClassificationChangelog();

  const cexBaseline = (() => {
    if (!cexHistory || cexHistory.length === 0) return null;
    // Same drift guard as the holders baseline above — a gap in the CEX
    // balance history archive shouldn't silently relabel "vs 30 days ago"
    // onto a point that's actually much further back.
    return pickBaseline(cexHistory, days, (e) => Date.parse(e.date));
  })();

  const nowMs = Date.now();
  const holdersBaselineTs = historicalDelta?.referenceDate ? Date.parse(historicalDelta.referenceDate) : NaN;
  const cexBaselineTs = cexBaseline ? Date.parse(cexBaseline.date) : NaN;

  // Reclassification events between each tile's baseline date and now, for
  // the metric that tile shows — see ChangeIndicator's changelogEvents doc.
  //
  // The headline balance tile USED to be "Total TEL Held" (retail + CEX) and
  // was deliberately excluded here, because relabelling a wallet between
  // retail and CEX leaves their sum unchanged. That tile now shows Retail
  // only (2026-08-22 — the blend double-counted the CEX tile and hid
  // retail<->CEX rotation), so that reasoning no longer applies: it moves on a
  // relabel with no TEL moving, and needs suppression like the holders tile.
  // `retailBalance` is the same retail.balance event set `concentration` uses.
  //
  // "Staked TEL" is still excluded: the staking contract is untouched by these
  // reclassifications.
  const retailBalanceEvents = Number.isFinite(holdersBaselineTs)
    ? getEventsAffecting(changelog, "retail.balance", holdersBaselineTs, nowMs)
    : [];
  const events: {
    holders: ClassificationEvent[];
    concentration: ClassificationEvent[];
    retailBalance: ClassificationEvent[];
    cex: ClassificationEvent[];
  } = {
    holders: Number.isFinite(holdersBaselineTs)
      ? getEventsAffecting(changelog, "retail.count", holdersBaselineTs, nowMs)
      : [],
    concentration: retailBalanceEvents,
    retailBalance: retailBalanceEvents,
    cex: Number.isFinite(cexBaselineTs)
      ? getEventsAffecting(changelog, "cexBalance", cexBaselineTs, nowMs)
      : [],
  };

  return {
    historicalDelta,
    cexPrevious: cexBaseline?.total ?? null,
    cexReferenceDate: cexBaseline?.date ?? null,
    events,
  };
};
