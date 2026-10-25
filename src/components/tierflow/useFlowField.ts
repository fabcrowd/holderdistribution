import { useMemo } from "react";
import { useHolderTransitions, transitionsKeyFor } from "@/hooks/useHolderTransitions";
import { useTierOutflows, outflowsKeyFor, type TierOutflowCell } from "@/hooks/useTierOutflows";
import { ytdDays } from "@/lib/timeRange";
import { tileW } from "./geometry";
import { useTierGeometry } from "./useTierGeometry";

export type TierRow = {
  label: string;
  count: number;
  totalBalance: number;
  previousCount?: number | null;
  previousTotalBalance?: number | null;
};

/** "all" (every chain) or one of the active project's chain keys (src/lib/chainViews.ts). */
export type ChainKey = "all" | (string & {});

export type Cause = {
  dex: number; dexSwap: number; dexLp: number;
  cex: number; moved: number; splitTel: number; splitDestinationSlots: number; splitEvents: number; soloMoved: number;
  total: number; sold: number; soldPct: number; hasData: boolean;
  boughtDex: number; boughtDexSwap: number; boughtDexLp: number;
  boughtCex: number; receivedWallet: number; inTotal: number; hasInData: boolean;
  /** Counterparty-tier attribution for receivedWallet/moved (schema v11+).
   *  Empty when a chain filter is active (byChain doesn't carry these), or
   *  when no attribution exists yet — see `attributedDays` to tell those apart. */
  inflowsBySourceTier: Record<string, number>;
  movedByDestTier: Record<string, number>;
};
const EMPTY_CAUSE: Cause = {
  dex: 0, dexSwap: 0, dexLp: 0,
  cex: 0, moved: 0, splitTel: 0, splitDestinationSlots: 0, splitEvents: 0, soloMoved: 0, total: 0, sold: 0, soldPct: 0, hasData: false,
  boughtDex: 0, boughtDexSwap: 0, boughtDexLp: 0,
  boughtCex: 0, receivedWallet: 0, inTotal: 0, hasInData: false,
  inflowsBySourceTier: {}, movedByDestTier: {},
};

/** Split dex into swap vs LP; when sub-fields are absent, treat all as swaps. */
const splitDex = (total: number, swap?: number, lp?: number) => {
  if (swap != null || lp != null) {
    return { swap: swap ?? 0, lp: lp ?? 0 };
  }
  return { swap: total, lp: 0 };
};

export type Migration = { counterpart: string; count: number; up: boolean; gained: boolean };

export type TierField = {
  label: string;
  index: number;
  row: TierRow | null;
  pct: number; // log-scaled width, 0-100, by holder count
  cause: Cause;
  /** Outflow-cause color key: unknown (no TEL outflow data), relocated (mostly
   *  wallet-to-wallet), sold (mostly DEX/exchange). Growth uses snapshot
   *  deltas / migration `up` flags separately — not this field. */
  verdict: "unknown" | "relocated" | "sold";
  addedCount: number; // wallets ADDED to this tier this period (arrived from any counterpart)
  removedCount: number; // wallets REMOVED from this tier this period (left to any counterpart)
  migrations: Migration[]; // per-counterpart-tier detail, for the click state
};

// `breakdownSource` is the UNFILTERED cell (chain === "all") to pull the
// per-counterparty-tier maps from — byChain legs don't carry them, so a
// chain filter must never mix chain-filtered totals with all-chain
// breakdown figures. Pass undefined when a chain filter is active.
const causeOfCell = (c: TierOutflowCell | undefined, breakdownSource: TierOutflowCell | undefined): Cause => {
  const dex = c?.dex ?? 0;
  const { swap: dexSwap, lp: dexLp } = splitDex(dex, c?.dexSwap, c?.dexLp);
  const cex = c?.cex ?? 0;
  const moved = c?.moved ?? 0;
  // splitTel is guaranteed <= moved at the source since the v10 pipeline fix
  // (scripts/generate-tier-outflows.js) — no client-side clamp needed anymore.
  const splitTel = c?.splitTel ?? 0;
  const splitDestinationSlots = c?.splitDestinationSlots ?? c?.splitWallets ?? 0;
  const splitEvents = c?.splitEvents ?? 0;
  const soloMoved = moved - splitTel;
  const total = dex + cex + moved;
  const sold = dexSwap + cex; // LP adds are not sales
  const inf = c?.inflows ?? { dex: 0, cex: 0, wallet: 0 };
  const { swap: boughtDexSwap, lp: boughtDexLp } = splitDex(inf.dex, inf.dexSwap, inf.dexLp);
  const inTotal = inf.dex + inf.cex + inf.wallet;
  return {
    dex, dexSwap, dexLp, cex, moved, splitTel, splitDestinationSlots, splitEvents, soloMoved, total, sold,
    soldPct: total > 0 ? (sold / total) * 100 : 0, hasData: total > 0,
    boughtDex: inf.dex, boughtDexSwap, boughtDexLp,
    boughtCex: inf.cex, receivedWallet: inf.wallet, inTotal, hasInData: inTotal > 0,
    inflowsBySourceTier: breakdownSource?.inflowsBySourceTier ?? {},
    movedByDestTier: breakdownSource?.movedByDestTier ?? {},
  };
};

// A chain-filtered cell built from the sparse byChain breakdown. Since the
// backfill is complete (complete:true), an absent chain key means genuinely
// zero activity for that chain, not "not scanned yet" — so this never needs
// a separate "absent" state, only value-vs-zero.
const chainCell = (c: TierOutflowCell | undefined, chain: ChainKey): TierOutflowCell | undefined => {
  if (chain === "all" || !c) return c;
  const leg = c.byChain?.[chain];
  if (!leg) {
    return {
      dex: 0, dexSwap: 0, dexLp: 0, cex: 0, moved: 0,
      inflows: { dex: 0, dexSwap: 0, dexLp: 0, cex: 0, wallet: 0 },
    };
  }
  return {
    dex: leg.dex, dexSwap: leg.dexSwap, dexLp: leg.dexLp,
    cex: leg.cex, moved: leg.moved, inflows: leg.inflows,
  };
};

export const useFlowField = (rows: TierRow[], chain: ChainKey, metric: "wallets" | "tel" = "wallets", rangeDays: number = ytdDays()) => {
  const { data: transitions, isLoading: transitionsLoading, isError: transitionsErrored } = useHolderTransitions();
  const { data: outflows, isLoading: outflowsLoading, isError: outflowsErrored } = useTierOutflows();
  // The active project's distribution tiers (TEL: geometry.TIERS, unchanged).
  const { tiers: TIERS, tierIndex } = useTierGeometry();

  // Resolve the SAME window key convention both generators use — matching
  // outflowsKeyFor/transitionsKeyFor exactly is what keeps a "7D" selection
  // from silently pairing a 7-day cause breakdown with a 30-day migration
  // matrix (a real bug this app has shipped before).
  const ytd = ytdDays();
  const outflowsKey = outflowsKeyFor(rangeDays, ytd);
  const transitionsKeyValue = transitionsKeyFor(rangeDays, ytd);
  const rangeData = transitions?.ranges?.[transitionsKeyValue] ?? null;
  const outflowTiers = outflows?.ranges?.[outflowsKey]?.tiers;

  const rowOf = useMemo(() => new Map(rows.map((r) => [r.label, r])), [rows]);

  // Tile WIDTH follows the metric toggle (wallet count vs TEL) — but this is
  // the only thing the toggle affects. Migration-line and came/went-line
  // weights are always their natural unit (wallet count / TEL respectively)
  // regardless of this toggle, since tier-outflows.json has no per-wallet TEL
  // breakdown to fake a "TEL-weighted migration line" from.
  const pctByTier = useMemo(() => {
    const valOf = (t: string) => {
      const r = rowOf.get(t);
      return (metric === "wallets" ? r?.count : r?.totalBalance) ?? 0;
    };
    const maxLog = Math.max(...TIERS.map((t) => Math.log10(valOf(t) + 1)), 1);
    const map = new Map<string, number>();
    for (const t of TIERS) map.set(t, (Math.log10(valOf(t) + 1) / maxLog) * 100);
    return map;
  }, [rowOf, metric, TIERS]);

  const fields: TierField[] = useMemo(() => {
    return TIERS.map((label, index) => {
      const row = rowOf.get(label) ?? null;
      const rawCell = outflowTiers?.[label];
      const cause = causeOfCell(chainCell(rawCell, chain), chain === "all" ? rawCell : undefined);
      const verdict: TierField["verdict"] = !cause.hasData ? "unknown" : cause.moved >= cause.sold ? "relocated" : "sold";

      const migrations: Migration[] = [];
      if (rangeData) {
        // Outgoing: wallets that LEFT this tier for a counterpart (rendered
        // on the right / "lost" side). Grew if the counterpart is a BIGGER
        // tier (lower index); shrank otherwise.
        // `?? {}` on the matrix itself, not just the row: holder-transitions.json
        // is cast unvalidated in useHolderTransitions, and the `errored` guard
        // below only checks `!rangeData`. A range object published without a
        // matrix (generator erroring mid-window, or a schema bump) would throw
        // during render and drop the entire Holders page to the ErrorBoundary.
        const matrix = rangeData.matrix ?? {};
        const outs = matrix[label] ?? {};
        for (const [dest, cell] of Object.entries(outs)) {
          if (cell.count > 0) migrations.push({ counterpart: dest, count: cell.count, up: tierIndex(dest) < index, gained: false });
        }
        // Incoming: wallets that ARRIVED into this tier from a counterpart
        // (left / "gained" side). Grew if the counterpart was a SMALLER tier
        // (higher index — the wallet moved up into this one).
        for (const [src, dests] of Object.entries(matrix)) {
          if (src === label) continue;
          const cell = dests[label];
          if (cell && cell.count > 0) migrations.push({ counterpart: src, count: cell.count, up: tierIndex(src) > index, gained: true });
        }
      }
      // Left/right tile ticks are ADDS vs REMOVALS (did this tier gain or
      // lose the wallet), not "grew into a bigger tier" vs "shrank into a
      // smaller one" — up/down conflates two different questions (direction
      // of size crossing vs direction of membership change) into one number,
      // so a tier could show "+12" that's actually 8 arrivals and 4
      // departures-to-a-bigger-tier netted together. gained already carries
      // the add/remove distinction the tile ticks need.
      const addedCount = migrations.filter((m) => m.gained).reduce((s, m) => s + m.count, 0);
      const removedCount = migrations.filter((m) => !m.gained).reduce((s, m) => s + m.count, 0);

      return { label, index, row, pct: pctByTier.get(label) ?? 0, cause, verdict, addedCount, removedCount, migrations };
    });
  }, [rowOf, pctByTier, outflowTiers, chain, rangeData, TIERS, tierIndex]);

  // Aggregate net TEL and net wallets, from snapshot truth only — never
  // derived by summing the gross flow figures (see the plan's data-contract
  // audit: gross flows cannot reconcile to a real net, sometimes not even in
  // sign). Both units are computed so the UI can show whichever one matches
  // the active Wallets/TEL toggle without mixing units on screen.
  const netInfo = useMemo(() => {
    let telCur = 0, telPrev = 0, telHaveAny = false, telHaveAll = true;
    let walletsCur = 0, walletsPrev = 0, walletsHaveAny = false, walletsHaveAll = true;
    for (const r of rows) {
      telCur += r.totalBalance;
      walletsCur += r.count;
      if (r.previousTotalBalance != null) { telPrev += r.previousTotalBalance; telHaveAny = true; }
      else telHaveAll = false;
      if (r.previousCount != null) { walletsPrev += r.previousCount; walletsHaveAny = true; }
      else walletsHaveAll = false;
    }
    return {
      netTel: telHaveAny ? telCur - telPrev : null,
      partialTel: telHaveAny && !telHaveAll,
      netWallets: walletsHaveAny ? walletsCur - walletsPrev : null,
      partialWallets: walletsHaveAny && !walletsHaveAll,
    };
  }, [rows]);

  // Aggregate gross "why" explainer, across all tiers (chain-filtered),
  // clearly a SEPARATE quantity from netInfo.net above.
  const grossExplainer = useMemo(() => {
    let dex = 0, cex = 0, moved = 0;
    for (const f of fields) { dex += f.cause.dex; cex += f.cause.cex; moved += f.cause.moved; }
    return { dex, cex, moved, total: dex + cex + moved };
  }, [fields]);

  const maxMigrationCount = useMemo(
    () => Math.max(1, ...fields.flatMap((f) => f.migrations.map((m) => m.count))),
    [fields],
  );
  const loading = outflowsLoading || transitionsLoading;
  // A query that resolved successfully with a null payload (fetch !ok, or
  // the file genuinely missing) is functionally the same failure as a thrown
  // network error from the caller's perspective — both mean "no usable data".
  const errored = !loading && (outflowsErrored || transitionsErrored || outflowTiers == null || !rangeData);
  const ready = !loading && !errored && !!rangeData && !!outflowTiers;

  return {
    fields, tileW, netInfo, grossExplainer, maxMigrationCount,
    loading, errored, ready,
    complete: outflows?.complete ?? null,
    // Window-level counterparty-tier attribution coverage — same for every
    // tier/chain in this window, so it's surfaced once here rather than per
    // field. sourceTierSince is a single value for the whole dataset.
    attributedDays: outflows?.ranges?.[outflowsKey]?.attributedDays ?? 0,
    totalDays: outflows?.ranges?.[outflowsKey]?.totalDays ?? 0,
    sourceTierSince: outflows?.sourceTierSince ?? null,
    // When the tier-outflows feed was built: it refreshes on its own job, so
    // it can lag the snapshot the rest of the diagram reads.
    // The transitions window actually used for the tier crossings. It can
    // differ from the page range when the archive has gaps (a "1D" window
    // spanning three weeks), so panels print the real dates.
    crossingsWindow: rangeData?.from && rangeData?.to ? { from: rangeData.from, to: rangeData.to } : null,
    outflowsAsOf: outflows?.generatedAt ?? (outflows?.latestDate ? `${outflows.latestDate}T00:00:00Z` : null),
  };
};

export { EMPTY_CAUSE };
