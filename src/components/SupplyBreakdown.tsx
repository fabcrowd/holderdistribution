import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { useProject } from "@/hooks/useProject";
import { PanelError } from "@/components/terminal/TerminalPanel";
import { motion } from "framer-motion";
import { TreasuryHistoryChart } from "@/components/TreasuryHistoryChart";
import { AssociationFlowAnalysis } from "@/components/AssociationFlowAnalysis";
import { TelDispositionLedger } from "@/components/TelDispositionLedger";
import { ForensicsUnlockGate, ForensicsUnlockProvider, useForensicsUnlock } from "@/components/ForensicsGate";
import { SubscriptionGate } from "@/components/SubscriptionGate";

// Own chunk: holds only UI code (no wallet data); loaded when the tab opens.
const WalletFlowsPanel = lazy(() => import("@/components/WalletFlowsPanel"));
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SubPanelTabs } from "@/components/SubPanelTabs";
import { SupplyTerminal } from "@/components/terminal/SupplyTerminal";
import { TabsContent } from "@/components/ui/tabs";
import { MethodologyInfo } from "@/components/MethodologyInfo";
import { Badge } from "@/components/ui/badge";
import LockedAnalysisTile from "@/components/LockedAnalysisTile";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Pie, PieChart as RePieChart, Cell, Sector } from "recharts";
import "@/lib/rechartsMotion";
import type { PieSectorDataItem } from "recharts/types/polar/Pie";
import {
  useSupplyReconciliation,
  type SupplyReconciliationItem,
} from "@/hooks/useSupplyReconciliation";
import { useHolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { StakingAddressList } from "@/components/StakingAddressList";
import { stakingAddressLinks, supplyRetailStakeModel } from "@/lib/stakingAddresses";
import { buildViewHash } from "@/lib/viewRoute";
import {
  associationCategoryLabel,
  groupSupplyCategories,
  isAssociationCategory,
  isHoldingsCategory,
  isOtherCategory,
  isStakingCategory,
  otherCategoryLabel,
  partitionBuckets,
  DEFAULT_RESIDUAL_BUCKET_LABEL,
  DEFAULT_STAKING_BUCKET_LABEL,
} from "@/lib/supplyBreakdown";
import { chainExplorerLink, resolveChainVm } from "@/lib/explorerLinks";
import { AlertTriangle, ArrowLeft, ChevronRight, ExternalLink, Lock, PieChart } from "lucide-react";
import { coingeckoComparison } from "@/lib/coingeckoComparison";
import { reconcileStatus } from "@/lib/supplyGuard";
import { EXPLORER_BASE } from "@/lib/telContracts";
import { useChartIntro } from "@/hooks/useMotion";
import { CHART_DRAW_MS } from "@/lib/motion";

const SUPPLY_PANELS = [
  { id: "breakdown", label: "Breakdown" },
  { id: "reconciliation", label: "Reconciliation" },
  { id: "history", label: "History" },
  { id: "wallet-flows", label: "Wallet flows" },
];

type SupplyBreakdownProps = {
  /** Page-wide range, so the history chart below matches every other widget. */
  rangeDays: number;
  panel?: string;
  onPanelChange?: (panel: string) => void;
  /** "terminal": the fixed-height desktop dashboard grid (>=1280px). */
  layout?: "stacked" | "terminal";
};

const formatCompactAmount = (value: number) => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
};

const formatFullAmount = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Blurred stand-in for an address/subcategory line while locked. */
const BlurredLine = ({ widthClass = "w-32" }: { widthClass?: string }) => (
  <div className={`h-3 ${widthClass} rounded bg-muted-foreground/30 blur-[3px] select-none`} aria-hidden="true" />
);

// Static shell — per-slice color/opacity comes from each bucket's own data, not this config.
const supplyPieChartConfig = (ticker: string) => ({ amount: { label: ticker } });

/** The selected wedge's "pop toward the viewer" — recharts' standard
 *  activeShape pattern: redraw just that one sector a few px further out
 *  than its siblings, which reads as it lifting off the ring rather than
 *  merely changing color. <Pie>'s own outerRadius leaves room for this (92%,
 *  not 100%) so the grown sector never clips against the chart box. */
const makeActivePieSector = (ticker: string) => (props: PieSectorDataItem) => {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props;
  const p = props.payload as { label?: string; amount?: number; pct?: number } | undefined;
  return (
    <Sector
      // recharts gives each sector role="img"; the redrawn active one needs
      // its own text alternative too (axe svg-img-alt).
      aria-label={p?.label ? `${p.label}: ${formatCompactAmount(p.amount ?? 0)} ${ticker} (${(p.pct ?? 0).toFixed(1)}%), selected` : "Selected category"}
      cx={cx}
      cy={cy}
      innerRadius={innerRadius}
      outerRadius={(outerRadius ?? 0) + 14}
      startAngle={startAngle}
      endAngle={endAngle}
      fill={fill}
      stroke="hsl(var(--background))"
      strokeWidth={3}
    />
  );
};

const explorerUrl = (item: SupplyReconciliationItem): string => {
  const a = item.address;
  if (item.category === "staking-contract") {
    return `${EXPLORER_BASE.polygon}/address/${a}`;
  }
  // The address page lists every token the wallet holds, so it shows both the
  // legacy (2-decimal) and the TEL v3 (18-decimal) balance that make up the
  // figure on this page — a single token's holder filter would show only half.
  return `${EXPLORER_BASE.ethereum}/address/${a}`;
};

/** Selects the drill-down panel content for a bucket key. Shared by the
 *  chart's wedges and the list rows beside it — one switch, not eight
 *  separate ternaries repeated inline. */
const renderBucketDetail = (
  key: string,
  ctx: {
    data: ReturnType<typeof useSupplyReconciliation>["data"];
    residualItems: SupplyReconciliationItem[];
    otherItems: SupplyReconciliationItem[];
    associationItems: SupplyReconciliationItem[];
    holdingsItems: SupplyReconciliationItem[];
    dexItems: SupplyReconciliationItem[];
    cexItems: SupplyReconciliationItem[];
    escrowItems: SupplyReconciliationItem[];
    stakingItems: SupplyReconciliationItem[];
    retailAmount: number;
  },
): ReactNode => {
  switch (key) {
    case "residual":
      return <ResidualPanel data={ctx.data} bridges={ctx.residualItems} />;
    case "other":
      return <OtherAddressPanel items={ctx.otherItems} />;
    case "association":
      return <AssociationPanel items={ctx.associationItems} />;
    case "holdings":
      return <HoldingsPanel items={ctx.holdingsItems} />;
    case "dex":
      return <DexLiquidityPanel items={ctx.dexItems} />;
    case "cex":
      return <CexCustodyPanel items={ctx.cexItems} />;
    case "staking":
      return <StakingPanel items={ctx.stakingItems} />;
    case "escrow":
      return <EscrowPanel items={ctx.escrowItems} committed={ctx.data?.circulatingExclusions?.total ?? null} />;
    case "retail":
      return <RetailPanel amount={ctx.retailAmount} />;
    default:
      return null;
  }
};


const SupplyBreakdown = ({ rangeDays, panel: panelProp, onPanelChange, layout = "stacked" }: SupplyBreakdownProps) => {
  const pieIntro = useChartIntro();
  const { ticker, entities, text } = useProjectCopy();
  const { project } = useProject();
  const { data: holderLite } = useHolderLiteSnapshot();
  const retailStake = supplyRetailStakeModel(
    project,
    holderLite?.views.combined?.stakingStats?.stakedTotal ?? 0,
    formatCompactAmount,
  );
  // Fallback denominator before reconciliation loads: the project's supply target (TEL: 100B).
  const supplyTarget = project.supply?.target ?? 100_000_000_000;
  const pieChartConfig = useMemo(() => supplyPieChartConfig(ticker), [ticker]);
  const activePieSector = useMemo(() => makeActivePieSector(ticker), [ticker]);
  // Controlled when the page owns the panel (so #supply/<panel> deep links
  // work), uncontrolled otherwise.
  const [panelState, setPanelState] = useState("breakdown");
  const panel = panelProp ?? panelState;
  const setPanel = (next: string) => {
    setPanelState(next);
    onPanelChange?.(next);
  };
  const { data, isLoading, error } = useSupplyReconciliation();
  // Bucket titles: project entity names + project-copy residual/staking labels
  // (TEL keeps "In transit (bridges)"; ZBCN relabels its single-chain residual).
  const bucketLabels = useMemo(
    () => ({
      ...entities,
      residual: text("supply.residual.bucketLabel", DEFAULT_RESIDUAL_BUCKET_LABEL),
      staking: text("supply.staking.bucketLabel", DEFAULT_STAKING_BUCKET_LABEL),
    }),
    [entities, text],
  );
  // Hovered slice — highlights the wedge and its list row together, in
  // either direction.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Which bucket's drill-down popover is open. Lives here rather than inside
  // a row so a click on the WEDGE and a click on that bucket's LIST ROW open
  // the exact same popover instead of two competing ones.
  // `undefined` = the reader hasn't picked anything yet. The terminal layout
  // then shows the largest category rather than an empty "select a category"
  // panel; ✕ sets an explicit null, which sticks.
  const [pickedBucketKey, setOpenBucketKey] = useState<string | null | undefined>(undefined);

  // Terminal layout: picking a category always shows its detail, even if
  // another analysis tab was open on the right. Only a real pick — the
  // default selection must not override a #supply/reconciliation deep link.
  useEffect(() => {
    if (layout === "terminal" && pickedBucketKey) {
      setPanelState("breakdown");
      onPanelChange?.("breakdown");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedBucketKey, layout]);

  const { buckets, totalSupply, circulating, residualItems, otherItems, associationItems, holdingsItems, dexItems, cexItems, escrowItems, stakingItems } =
    useMemo(() => {
      const total = data?.totalSupply ?? supplyTarget;
      const residual = data?.residual ?? Math.max(0, total - (data?.counted ?? 0));
      // No reconciliation (loading / failed) → no buckets. Grouping an empty
      // payload used to put the whole 100B into "In transit".
      const all = data ? groupSupplyCategories(data.categories, residual, bucketLabels) : [];
      const parts = partitionBuckets(all);
      const items = data?.items ?? [];
      return {
        buckets: parts,
        totalSupply: total,
        circulating: data?.circulating ?? null,
        residualItems: items.filter((i) => i.category === "bridge-lock"),
        otherItems: items
          .filter((i) => isOtherCategory(i.category))
          .slice()
          .sort((a, b) => b.balance - a.balance),
        associationItems: items
          .filter((i) => isAssociationCategory(i.category))
          .slice()
          .sort((a, b) => b.balance - a.balance),
        holdingsItems: items
          .filter((i) => isHoldingsCategory(i.category))
          .slice()
          .sort((a, b) => b.balance - a.balance),
        dexItems: items
          .filter((i) => i.category === "dex")
          .slice()
          .sort((a, b) => b.balance - a.balance),
        cexItems: items
          .filter((i) => i.category === "cex")
          .slice()
          .sort((a, b) => b.balance - a.balance),
        escrowItems: items
          .filter((i) => i.category === "escrow")
          .slice()
          .sort((a, b) => b.balance - a.balance),
        stakingItems: items
          .filter((i) => isStakingCategory(i.category))
          .slice()
          .sort((a, b) => b.balance - a.balance),
      };
    }, [data, bucketLabels, supplyTarget]);

  // Largest category that has something to drill into. Retail is usually
  // bigger, but its "detail" is one sentence (there is no address list),
  // which left the dashboard's biggest panel nearly empty on arrival.
  const largestBucketKey = useMemo(() => {
    const pool = buckets.filter((b) => b.key !== "retail" && b.amount > 0);
    const from = pool.length ? pool : buckets;
    return from.reduce<(typeof buckets)[number] | null>((m, b) => (m && m.amount >= b.amount ? m : b), null)?.key ?? null;
  }, [buckets]);
  const openBucketKey: string | null =
    pickedBucketKey === undefined ? (layout === "terminal" ? largestBucketKey : null) : pickedBucketKey;

  // Stable list order: rows keep their place (and their wedge's order) when
  // one is selected, so the reader's eye and pointer don't lose the row.
  const orderedBuckets = buckets;

  const partitionSum = buckets.reduce((s, b) => s + b.amount, 0);
  const reconcile = reconcileStatus(partitionSum, totalSupply);
  // Zero-amount buckets are dropped for the pie itself (a 0% wedge draws
  // nothing anyway), computed once so the Pie's data, its Cells, and the
  // active-slice label all index the same array — recharts' `index` in
  // onMouseEnter/label refers to a position in THIS array, not `buckets`.
  const pieSlices = useMemo(
    () =>
      buckets
        .filter((b) => b.amount > 0)
        .map((b) => ({
          key: b.key,
          label: b.label,
          amount: b.amount,
          pct: totalSupply > 0 ? (b.amount / totalSupply) * 100 : 0,
          color: b.color,
          alignment: b.alignment,
        })),
    [buckets, totalSupply],
  );
  // Shared by both designs: the desktop chart's on-label popovers and the
  // mobile list's rows both open the same drill-down content for a key.
  const getDetail = (key: string) =>
    renderBucketDetail(key, {
      data,
      residualItems,
      otherItems,
      associationItems,
      holdingsItems,
      dexItems,
      cexItems,
      escrowItems,
      stakingItems,
      retailAmount: pieSlices.find((s) => s.key === "retail")?.amount ?? 0,
    });
  const cg = coingeckoComparison(circulating, data?.coingeckoCirculating);



  const renderDonut = (className: string) => (
                  <ChartContainer
                    config={pieChartConfig}
                    // Explicit height rather than aspect-square + max-h: that
                    // combination let the box's reported size disagree with
                    // its rendered circle at some widths (w-full computes
                    // width first, then max-h clamps height independently —
                    // aspect-ratio doesn't reconcile the two backwards), which
                    // showed up as the list's first row rendering underneath
                    // the donut instead of below it.
                    className={className}
                    role="img"
                    aria-label={`${ticker} total supply by category`}
                  >
                    <RePieChart>
                      <ChartTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const entry = payload[0]?.payload as
                            | { key?: string; label: string; amount: number; pct: number }
                            | undefined;
                          if (!entry) return null;
                          return (
                            <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-md">
                              <p className="font-medium text-foreground">{entry.label}</p>
                              <p className="text-muted-foreground tabular-nums">
                                {formatCompactAmount(entry.amount)} {ticker} ({entry.pct.toFixed(1)}%)
                              </p>
                              {entry.key === "retail" && retailStake.note ? (
                                <p className="text-foreground">{retailStake.note}</p>
                              ) : null}
                            </div>
                          );
                        }}
                      />
                      <Pie
                        data={pieSlices}
                        dataKey="amount"
                        nameKey="label"
                        // No gap between wedges — paddingAngle removed.
                        // outerRadius pulled in from 100% to 92%: the
                        // selected wedge grows past its own edge on click
                        // (see makeActivePieSector), and needs that 8%
                        // margin to do it without clipping against the box.
                        innerRadius="55%"
                        outerRadius="92%"
                        paddingAngle={0}
                        animationBegin={0}
                        // Draws in on first load only — not on every range change.
                        isAnimationActive={pieIntro}
                        animationDuration={CHART_DRAW_MS}
                        animationEasing="ease-out"
                        // Pop the selected wedge out toward the viewer on
                        // click (or hover-preview), same trigger as the
                        // dim/isolate effect below — one shared notion of
                        // "this is the active bucket," several visual
                        // consequences.
                        activeIndex={(() => {
                          if (openBucketKey === null) return activeIndex ?? undefined;
                          const i = pieSlices.findIndex((s) => s.key === openBucketKey);
                          return i === -1 ? undefined : i;
                        })()}
                        activeShape={activePieSector}
                        onMouseEnter={(_, index) => setActiveIndex(index)}
                        onMouseLeave={() => setActiveIndex(null)}
                        onClick={(entry) => {
                          const key = (entry as unknown as { key?: string }).key;
                          if (key) setOpenBucketKey(key);
                        }}
                      >
                        {pieSlices.map((b, index) => {
                          // Same click-to-isolate treatment as TierFlowDiagram's
                          // tiles: once anything is selected, everything else
                          // drops to a flat low opacity rather than keeping its
                          // own alignment-based shade — the point is contrast
                          // against the one selected wedge, not category color.
                          const isRowActive = openBucketKey === b.key || activeIndex === index;
                          const anySelected = openBucketKey !== null || activeIndex !== null;
                          const baseOpacity = b.alignment === "retail" ? 1 : b.alignment === "residual" ? 0.7 : 0.85;
                          return (
                            <Cell
                              key={b.key}
                              fill={b.color}
                              // Recharts hard-codes role="img" on each wedge;
                              // give it a text alternative (WCAG 1.1.1).
                              aria-label={`${b.label}: ${formatCompactAmount(b.amount)} ${ticker} (${b.pct.toFixed(1)}%)`}
                              fillOpacity={anySelected ? (isRowActive ? 1 : 0.25) : baseOpacity}
                              stroke="hsl(var(--background))"
                              strokeWidth={isRowActive ? 3 : 0}
                              className="cursor-pointer transition-[fill-opacity,stroke-width] duration-150"
                            />
                          );
                        })}
                      </Pie>
                    </RePieChart>
                  </ChartContainer>
  );
  const renderList = (compact: boolean) => (
                  <div className={compact ? "w-full min-w-0 space-y-px" : "w-full min-w-0 space-y-0.5 md:max-w-[30rem]"}>
                    {orderedBuckets.map((b) => {
                      const pct = totalSupply > 0 ? (b.amount / totalSupply) * 100 : 0;
                      const isOpen = openBucketKey === b.key;
                      // Hovering a row thickens its wedge and vice versa —
                      // the pairing the connector lines used to make, without
                      // the lines.
                      const pieIndex = pieSlices.findIndex((s) => s.key === b.key);
                      const isActive = pieIndex !== -1 && pieIndex === activeIndex;
                      const isRowActive = isOpen || isActive;
                      const retailNote = b.key === "retail" ? retailStake.note : null;
                      // Compact (terminal) list: a category is always selected,
                      // so fading every other row to 40% would leave most of
                      // the list unreadable (and failing contrast). There the
                      // selection is carried by the row highlight alone, and
                      // only a hover preview fades the rest.
                      const anySelected = compact ? activeIndex !== null : openBucketKey !== null || activeIndex !== null;
                      return (
                        <motion.button
                          key={b.key}
                          layout
                          transition={{ layout: { duration: 0.3, ease: "easeOut" } }}
                          animate={{ scale: isRowActive && !compact ? 1.035 : 1 }}
                          type="button"
                          onMouseEnter={() => pieIndex !== -1 && setActiveIndex(pieIndex)}
                          onMouseLeave={() => setActiveIndex(null)}
                          // Toggle, not open-only: clicking the already-open
                          // row closes it; clicking any other row switches
                          // straight to it (no floating popover to close
                          // first — see the shared panel below the list,
                          // which is what actually renders getDetail now).
                          // Terminal: a category is always shown, so clicking
                          // the active row keeps it selected rather than
                          // emptying the detail panel. Stacked: toggle.
                          onClick={() => setOpenBucketKey(isOpen && !compact ? null : b.key)}
                          aria-pressed={isOpen}
                          // Origin left, not center, so the scale (applied via
                          // `animate` above, not a CSS class — see below)
                          // grows toward the reader instead of also
                          // expanding left past the color dot.
                          className={`flex w-full origin-left items-center justify-between gap-3 rounded-lg px-2.5 ${compact ? "py-1 min-h-[30px]" : "py-2.5 min-h-[44px]"} text-left transition-[background-color,opacity,box-shadow] duration-150 ${
                            isRowActive
                              ? "relative z-10 bg-primary/10 shadow-lg ring-1 ring-primary/30"
                              : "hover:bg-muted/40"
                          } ${anySelected && !isRowActive ? "opacity-40" : "opacity-100"}`}
                        >
                          <span className={`flex min-w-0 gap-2.5 ${retailNote ? "items-start" : "items-center"}`}>
                            <span
                              className={`inline-block h-3 w-3 shrink-0 rounded-sm ${retailNote ? "mt-1" : ""}`}
                              style={{ backgroundColor: b.color }}
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-foreground">{b.label}</span>
                              {retailNote ? (
                                <span
                                  data-testid="supply-retail-staked"
                                  className="block whitespace-normal text-[11px] font-medium leading-snug text-foreground"
                                >
                                  {retailNote}
                                </span>
                              ) : null}
                            </span>
                          </span>
                          <span className="tabular-nums text-sm font-semibold shrink-0">
                            {formatCompactAmount(b.amount)}
                            <span className="text-muted-foreground font-normal ml-1.5 text-xs">
                              {pct.toFixed(1)}%
                            </span>
                          </span>
                        </motion.button>
                      );
                    })}
                  </div>
  );
  const detailBlock = (
    <>
                  {openBucketKey && (
                    <div className="relative mt-3 rounded-lg border border-border/50 bg-muted/20 p-3 pr-9 text-xs leading-relaxed max-h-[60vh] overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => setOpenBucketKey(null)}
                        aria-label="Close detail"
                        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        ×
                      </button>
                      {getDetail(openBucketKey)}
                    </div>
                  )}
    </>
  );
  const footnote = (
    <>
      {reconcile.kind === "reconciling" && (
        <div
          role="status"
          data-testid="supply-reconciling"
          className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-2.5 py-1.5 text-left text-xs leading-snug text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <AlertTriangle aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-semibold">Reconciling.</span> This snapshot's categories don't yet add up to the{" "}
            {formatCompactAmount(totalSupply)} total supply, so individual amounts may shift slightly at the next
            refresh.
          </span>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground text-center">
        Solid = retail wallets / DEX LP; muted = exchanges &amp; project; grey = in transit.
      </p>
    </>
  );
  const reconciliationBody = (
    <>
                {circulating != null && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground space-y-1">
                    <div>
                      <span className="font-semibold text-foreground">Circulating: </span>
                      {formatCompactAmount(circulating)} {ticker}
                      <span className="text-muted-foreground">
                        {" "}
                        (counted − treasury − council − {entities.associationShort}-committed escrow;
                        {" "}{entities.holdingsShort}-sourced escrow included)
                      </span>
                    </div>
                    {cg && (
                      <div data-testid="coingecko-circulating">
                        CoinGecko reports {formatCompactAmount(cg.reported)}
                        {" "}
                        (Δ {cg.delta >= 0 ? "+" : "−"}
                        {formatCompactAmount(Math.abs(cg.delta))}).{" "}
                        {text(
                          "supply.coingecko.note",
                          "CoinGecko's figure is the aggregator's own reported number, not reconstructed from on-chain balances.",
                        ).replace(
                          "{treasuryNow}",
                          data?.categories?.treasury != null
                            ? `, down to today's ${formatCompactAmount(data.categories.treasury)} balance,`
                            : "",
                        )}
                      </div>
                    )}
                  </div>
                )}
                <TelDispositionLedger />
    </>
  );
  const historyBody = (
                <SubscriptionGate
                  minHeightClass="min-h-[18rem]"
                  compact={layout === "terminal"}
                  primary={layout === "terminal"}
                  description={`${entities.associationShort} Safes, ${entities.holdings} and Escrow balance history. One password unlocks every protected panel.`}
                >
                  <TreasuryHistoryChart rangeDays={rangeDays} compact={layout === "terminal"} />
                  <AssociationFlowAnalysis />
                </SubscriptionGate>
  );
  const walletFlowsBody = (
                <Suspense fallback={<p className="text-xs text-muted-foreground">Loading…</p>}>
                  <WalletFlowsPanel />
                </Suspense>
  );

  if (layout === "terminal") {
    return (
      <ForensicsUnlockProvider singleGate>
      <SupplyTerminal
        state={isLoading ? "loading" : error ? "error" : buckets.length === 0 ? "empty" : "ready"}
        panel={panel}
        onPanelChange={setPanel}
        totalSupplyLabel={`${formatCompactAmount(totalSupply)} ${ticker}`}
        donut={renderDonut("mx-auto h-[170px] w-[170px] shrink-0 2xl:h-[240px] 2xl:w-[240px]")}
        list={renderList(true)}
        footnote={footnote}
        openBucketLabel={openBucketKey ? buckets.find((b) => b.key === openBucketKey)?.label ?? null : null}
        detail={openBucketKey ? getDetail(openBucketKey) : null}
        onCloseDetail={() => setOpenBucketKey(null)}
        reconciliation={reconciliationBody}
        history={historyBody}
        walletFlows={walletFlowsBody}
      />
      </ForensicsUnlockProvider>
    );
  }

  // Mini donut swatch for the collapsed row — same colors/order as the full
  // chart below, just a static conic-gradient instead of a recharts Pie
  // (recharts' ResponsiveContainer has no proven pattern in this codebase at
  // this size, so a plain CSS gradient avoids that risk entirely).
  return (
    <ForensicsUnlockProvider>
    <Card className="premium-surface-card overflow-hidden">
      {/* No Collapsible: sole content of the "Supply" tab. */}
      <CardHeader className="holders-header-supply">
          <CardTitle className="text-lg sm:text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2 flex-wrap">
            <span className="p-1.5 rounded-xl bg-sky-500/12 border border-sky-500/20 shrink-0">
              <PieChart className="h-4 w-4 sm:h-5 sm:w-5 text-sky-600 dark:text-sky-400" />
            </span>
            Supply Breakdown
            <MethodologyInfo section="supplyBreakdown" />
          </CardTitle>
          <CardDescription className="text-sm sm:text-base text-muted-foreground mt-2">
            Where every {ticker} sits — click any segment for more detail
          </CardDescription>
      </CardHeader>
          <CardContent className="space-y-5 pt-2">
            {isLoading && (
              <p className="text-sm text-muted-foreground">Loading supply reconciliation…</p>
            )}
            {error && (
              <div className="min-h-[8rem]"><PanelError>Couldn&apos;t load the supply breakdown.</PanelError></div>
            )}
            {!isLoading && !error && buckets.length === 0 && (
              <p className="text-sm text-muted-foreground">No supply data available.</p>
            )}
            {buckets.length > 0 && (
              <SubPanelTabs panels={SUPPLY_PANELS} value={panel} onValueChange={setPanel}>
              <TabsContent value="breakdown" className="mt-4 space-y-5 focus-visible:outline-none">
                <div>
                  <div className="flex items-baseline justify-between mb-3 gap-2">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
                      Total supply
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatCompactAmount(totalSupply)} {ticker}
                    </span>
                  </div>
                  {/* Donut beside its list on desktop, stacked on mobile —
                      the same two pieces, only the axis changes.
                      On-chart connector labels were tried here and removed:
                      five of the eight buckets are <=1.8% and adjacent, so
                      they share a ~19deg arc while their labels need ~150px
                      of vertical space. Every connector then has to fan out
                      of effectively one point, which no routing or
                      column-balancing scheme makes legible. A list beside
                      the chart carries the same names, values and shares
                      with none of that, and uses the width desktop already
                      had spare. */}
                  {/* max-w on the list, not just flex-1: on a wide card the
                      value column would otherwise be flung ~1000px from its
                      label, which breaks the row's readability far worse
                      than any whitespace saved. */}
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-center md:gap-10">
                  {renderDonut("mx-auto w-full h-[240px] md:mx-0 md:h-[300px] md:w-[300px] md:shrink-0")}

                  {/* The reading surface, at both sizes: every bucket's name,
                      value and share at full text size with a real 44px
                      target, hover-synced with its wedge. */}
                  {renderList(false)}
                  </div>

                  {/* Shared inline panel, not a floating popover: it used to
                      cover the donut and the rows above the clicked one,
                      making it impossible to reach a different section
                      without closing it first. Always in normal document
                      flow beneath the donut+list, so both stay reachable —
                      clicking a different wedge or row swaps this panel's
                      content directly, no close step needed. Internal
                      scroll (not the whole page) keeps a long list (e.g.
                      CEX Custody's ~57 wallets) from pushing Reconciliation/
                      History far down the page. */}
                  {detailBlock}
                  {footnote}
                </div>
              </TabsContent>

              <TabsContent value="reconciliation" className="mt-4 space-y-5 focus-visible:outline-none">
                {reconciliationBody}
              </TabsContent>

              {/* Behind a panel rather than always-on: the gate reserves
                  =18rem even when locked, so for a logged-out visitor it was
                  ~288px of blurred placeholder on every load. */}
              <TabsContent value="history" className="mt-4 focus-visible:outline-none">
                {historyBody}
              </TabsContent>

              {/* Password-gated: the report is fetched from the forensics gate
                  function only after unlock; nothing is in the public bundle. */}
              <TabsContent value="wallet-flows" className="mt-4 focus-visible:outline-none">
                {walletFlowsBody}
              </TabsContent>
              </SubPanelTabs>
            )}
          </CardContent>
    </Card>
    </ForensicsUnlockProvider>
  );
};

const ResidualPanel = ({
  data,
  bridges,
}: {
  data: ReturnType<typeof useSupplyReconciliation>["data"];
  bridges: SupplyReconciliationItem[];
}) => {
  const { ticker, name, text, hasText } = useProjectCopy();
  const parts = data?.residualParts;
  const residual = data?.residual ?? 0;
  const gap = formatCompactAmount(residual);
  const total = formatCompactAmount(data?.totalSupply ?? 1e11);
  const fill = (s: string) => s.replace(/\{gap\}/g, gap).replace(/\{total\}/g, total);
  // A project with its own residual body (ZBCN: single-chain, no bridges)
  // drops the bridge rows unless its data actually has bridge amounts.
  const projectBody = hasText("supply.residual.body");
  const hasBridgeLegs =
    (data?.bridgeLocked ?? 0) !== 0 || (data?.mirrored ?? 0) !== 0 || (parts?.bridgeInFlight ?? 0) !== 0 || bridges.length > 0;
  const showBridgeRows = !projectBody || hasBridgeLegs;
  const upgrade = data?.upgrade;
  const hasUpgrade =
    !!upgrade && (upgrade.v3Supply !== 0 || upgrade.retiredLegacy !== 0 || upgrade.strandedInUpgrade !== 0);
  const originDrift = parts?.originDrift ?? 0;
  return (
    <div className="space-y-3">
      <p className="font-semibold text-foreground text-sm">
        {text("supply.residual.title", DEFAULT_RESIDUAL_BUCKET_LABEL)}
      </p>
      {projectBody ? (
        <p className="text-muted-foreground">{fill(text("supply.residual.body", ""))}</p>
      ) : (
        <p className="text-muted-foreground">
          Deeper look at the ~{gap} gap between wallets we can count and the
          official {total} total. Most of this is {ticker} that is{" "}
          <span className="text-foreground font-medium">
            locked on Ethereum while it moves to Polygon or Base
          </span>
          — not a mysterious missing wallet.
        </p>
      )}
      <dl className="space-y-1.5 tabular-nums">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{text("supply.residual.amountLabel", "In transit")}</dt>
          <dd className="font-medium text-foreground">{formatFullAmount(residual)} {ticker}</dd>
        </div>
        {showBridgeRows && (
          <>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Locked on Ethereum (bridges)</dt>
              <dd>{formatFullAmount(data?.bridgeLocked ?? 0)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Already showing on Polygon + Base</dt>
              <dd>{formatFullAmount(data?.mirrored ?? 0)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Still crossing bridges</dt>
              <dd>{formatFullAmount(parts?.bridgeInFlight ?? 0)}</dd>
            </div>
          </>
        )}
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{text("supply.residual.originDriftLabel", "Tiny scan difference")}</dt>
          {/* Project copy (ZBCN) labels the drift as a positive gap below the max; TEL keeps the signed figure. */}
          <dd>{formatFullAmount(hasText("supply.residual.originDriftLabel") ? Math.abs(originDrift) : originDrift)}</dd>
        </div>
      </dl>
      <p className="text-muted-foreground">
        {fill(
          text(
            "supply.residual.note",
            "Still crossing ≈ locked on Ethereum − already showing on Polygon/Base. A tiny scan difference can nudge the final number slightly.",
          ),
        )}
      </p>
      {upgrade && hasUpgrade && (
        <div className="border-t border-border/50 pt-2 space-y-1.5">
          <p className="font-semibold text-foreground">{ticker} v3 upgrade (legacy → v3, 1:1)</p>
          <p className="text-muted-foreground">
            Every wallet balance is legacy {ticker} plus {ticker} v3. When a holder upgrades, the legacy {ticker} is
            locked in {name}&apos;s upgrade contract and the same amount of v3 is minted to them — so
            the locked legacy {ticker} is left out and the v3 is counted instead, never both.
          </p>
          <dl className="space-y-1.5 tabular-nums">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{ticker} v3 in existence (all chains)</dt>
              <dd>{formatFullAmount(upgrade.v3Supply)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Legacy {ticker} locked for it (not double-counted)</dt>
              <dd>{formatFullAmount(upgrade.retiredLegacy)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Sent to the upgrade contract without upgrading</dt>
              <dd>{formatFullAmount(upgrade.strandedInUpgrade)}</dd>
            </div>
          </dl>
        </div>
      )}
      {bridges.length > 0 && (
        <div className="border-t border-border/50 pt-2">
          <AddressListPanel
            title="Locked on Ethereum"
            description="Individual bridge-lock addresses making up the total above."
            items={bridges}
            subcategoryFor={() => "Bridge lock"}
            emptyLabel="No bridge-lock addresses itemised."
          />
        </div>
      )}
    </div>
  );
};

const AddressRow = ({
  item,
  subcategory,
  password,
}: {
  item: SupplyReconciliationItem;
  subcategory: string;
  password: string | null;
}) => {
  const { project } = useProject();
  // Single-chain Solana projects (ZBCN) link base58 addresses to their own
  // explorer as-is; everything else keeps the historical EVM links.
  const chains = project.chains ?? [];
  const href =
    chains.length === 1 && resolveChainVm(chains[0]) === "solana"
      ? chainExplorerLink(chains[0], "address", item.address)
      : explorerUrl(item);
  return (
  <li className="space-y-2 border-b border-border/40 pb-2 last:border-0">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 space-y-1">
        <div className="font-medium text-foreground truncate flex items-center gap-1.5 flex-wrap">
          <span className="truncate">{item.name ?? subcategory}</span>
          {password !== null && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
              Analysis
            </Badge>
          )}
        </div>
        {password !== null ? (
          <>
            <div className="text-muted-foreground">{subcategory}</div>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              {shortAddr(item.address)}
              <ExternalLink className="h-3 w-3" />
            </a>
          </>
        ) : (
          <>
            <BlurredLine widthClass="w-24" />
            <BlurredLine widthClass="w-32" />
          </>
        )}
      </div>
      <span className="tabular-nums shrink-0 font-medium">{formatCompactAmount(item.balance)}</span>
    </div>
    {password !== null ? (
      <LockedAnalysisTile address={item.address} password={password} />
    ) : (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Lock className="h-3 w-3 shrink-0" />
        Detailed forensic analysis — unlocks with the password
      </div>
    )}
  </li>
  );
};

/**
 * Two-level address drill-down, shared by every bucket panel that lists
 * addresses (Association, Holdings, Other, DEX, CEX, Escrow, and the
 * bridges portion of Residual). Was one flat list where every row already
 * showed its own password gate and "enter password to unlock" hint,
 * repeated per address — for CEX Custody's ~57 wallets that meant the panel
 * opened already showing dozens of lock prompts at once, which is what
 * "floods the screen" meant.
 *
 * Level 1 (default): a tight, one-line-per-address list — name, balance,
 * share of THIS bucket, nothing else. No password gate, no lock icons.
 * Level 2 (after tapping a row): that one address's full detail — the
 * existing `AddressRow` (address, explorer link, password gate, forensic
 * analysis) — with a "Back" affordance to return to the list. Percentage is
 * of the bucket's own total, not of total supply — the outer list already
 * shows this bucket's share of supply, so a second copy of the same number
 * here would be redundant; the useful figure inside a bucket is how the
 * addresses split it between them.
 */
const AddressListPanel = ({
  title,
  description,
  items,
  subcategoryFor,
  emptyLabel,
}: {
  title: string;
  description: ReactNode;
  items: SupplyReconciliationItem[];
  subcategoryFor: (item: SupplyReconciliationItem) => string;
  emptyLabel: string;
}) => {
  const { password, status, unlock } = useForensicsUnlock();
  const { t } = useProjectCopy();
  // String descriptions are copy templates ({ticker}, {name}, …).
  const desc = typeof description === "string" ? t(description) : description;
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const bucketTotal = items.reduce((s, i) => s + i.balance, 0);
  const selected = selectedAddress ? items.find((i) => i.address === selectedAddress) ?? null : null;

  if (selected) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setSelectedAddress(null)}
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline min-h-[28px]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {title}
        </button>
        {password === null && <ForensicsUnlockGate status={status} onUnlock={unlock} />}
        <ul>
          <AddressRow item={selected} subcategory={subcategoryFor(selected)} password={password} />
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="font-semibold text-foreground text-sm">{title}</p>
      <p className="text-muted-foreground">{desc}</p>
      {items.length === 0 ? (
        <p className="text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="divide-y divide-border/40 -mx-1">
          {items.map((item) => {
            const pct = bucketTotal > 0 ? (item.balance / bucketTotal) * 100 : 0;
            return (
              <li key={`${item.category}-${item.address}`}>
                <button
                  type="button"
                  onClick={() => setSelectedAddress(item.address)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-2 min-h-[40px] text-left hover:bg-muted/40"
                >
                  <span className="truncate text-foreground">{item.name ?? subcategoryFor(item)}</span>
                  <span className="flex shrink-0 items-center gap-1.5 tabular-nums font-medium">
                    {formatCompactAmount(item.balance)}
                    <span className="text-muted-foreground font-normal text-[11px]">{pct.toFixed(1)}%</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const AssociationPanel = ({ items }: { items: SupplyReconciliationItem[] }) => {
  const { entities, text } = useProjectCopy();
  return (
    <AddressListPanel
      title={entities.association}
      description={text(
        "supply.association.description",
        "Treasury and council / ops Safes controlled by the {name} foundation, listed together in the hero bucket. Balances checked on-chain.",
      )}
      items={items}
      subcategoryFor={(item) => associationCategoryLabel(item.category)}
      emptyLabel={`No ${entities.associationShort} addresses itemised.`}
    />
  );
};

const sumBalances = (items: SupplyReconciliationItem[]) => items.reduce((s, i) => s + (Number.isFinite(i.balance) ? i.balance : 0), 0);

const HoldingsPanel = ({ items }: { items: SupplyReconciliationItem[] }) => {
  const { entities, text } = useProjectCopy();
  return (
    <AddressListPanel
      title={entities.holdings}
      description={text(
        "supply.holdings.description",
        "Confirmed {name} team / company wallets ({amount} {ticker}), a separate entity from the foundation Safes.",
      ).replace("{amount}", formatCompactAmount(sumBalances(items)))}
      items={items}
      subcategoryFor={() => entities.holdings}
      emptyLabel={`No ${entities.holdingsShort} addresses itemised.`}
    />
  );
};

const OtherAddressPanel = ({ items }: { items: SupplyReconciliationItem[] }) => (
  <AddressListPanel
    title="Other addresses"
    description="Independent large wallets, temporary retail labels, burned {ticker}, and small special cases. Confirmed personal wallets move into Retail after a full holders re-scrape."
    items={items}
    subcategoryFor={(item) => otherCategoryLabel(item.category)}
    emptyLabel="No itemised Other addresses."
  />
);

const DexLiquidityPanel = ({ items }: { items: SupplyReconciliationItem[] }) => (
  <AddressListPanel
    title="DEX Liquidity"
    description="{ticker} sitting in DEX pools and LP contracts — retail-owned (LP receipts) but protocol-custodied, not held directly by a wallet."
    items={items}
    subcategoryFor={(item) => item.name ?? "DEX pool"}
    emptyLabel="No DEX pool addresses itemised."
  />
);

const CexCustodyPanel = ({ items }: { items: SupplyReconciliationItem[] }) => {
  const { text } = useProjectCopy();
  return (
    <AddressListPanel
      title="CEX Custody"
      description={text(
        "supply.cex.description",
        "{ticker} held in known exchange deposit/custody wallets — user balances on that exchange, not project-controlled.",
      )}
      items={items}
      subcategoryFor={(item) => item.name ?? "Exchange wallet"}
      emptyLabel="No CEX addresses itemised."
    />
  );
};

const StakingPanel = ({ items }: { items: SupplyReconciliationItem[] }) => {
  const { text, hasText } = useProjectCopy();
  const { project } = useProject();
  const rewardLinks = hasText("supply.staking.addresses")
    ? stakingAddressLinks(project).filter((link) => link.kind === "reward-vault")
    : [];
  return (
    <div className="space-y-3">
      <AddressListPanel
        title={text("supply.staking.bucketLabel", DEFAULT_STAKING_BUCKET_LABEL)}
        description={text(
          "supply.staking.description",
          "Undistributed {ticker} still held by staking-program accounts after staked balances are credited to each staker. These balances are not staker principal. Staked {ticker} is inside Retail, not this slice.",
        )}
        items={items}
        subcategoryFor={(item) => item.name ?? text("supply.staking.addressFallback", "Staking program")}
        emptyLabel={text("supply.staking.empty", "No staking-program addresses itemised.")}
      />
      {rewardLinks.length > 0 ? (
        <div className="space-y-2 border-t border-border/50 pt-2">
          <p className="text-muted-foreground">{text("supply.staking.addresses", "")}</p>
          <StakingAddressList links={rewardLinks} />
        </div>
      ) : null}
    </div>
  );
};

const EscrowPanel = ({ items, committed }: { items: SupplyReconciliationItem[]; committed: number | null }) => {
  const { entities, text, hasText } = useProjectCopy();
  const total = sumBalances(items);
  const rest = committed != null ? Math.max(0, total - committed) : null;
  return (
  <AddressListPanel
    title="Escrow"
    description={
      <>
        {text("supply.escrow.description", "{ticker} held by third-party custodians")}
        {committed != null && rest != null ? (
          <>
            {" "}— {formatCompactAmount(committed)} is contractually committed back to {entities.associationShort} treasury and
            excluded from circulating; the remaining {formatCompactAmount(rest)} stays circulating
          </>
        ) : null}
        {hasText("supply.escrow.description") ? (
          <>
            {" "}(traced on-chain in <code className="text-[11px]">data/escrow-safe-provenance.md</code>).
          </>
        ) : (
          "."
        )}
      </>
    }
    items={items}
    subcategoryFor={(item) => item.name ?? "Escrow custodian"}
    emptyLabel="No escrow addresses itemised."
  />
  );
};

const RetailPanel = ({ amount }: { amount: number }) => {
  const { ticker } = useProjectCopy();
  const { project } = useProject();
  const { data: holderLite } = useHolderLiteSnapshot();
  const retailStake = supplyRetailStakeModel(
    project,
    holderLite?.views.combined?.stakingStats?.stakedTotal ?? 0,
    formatCompactAmount,
  );
  return (
  <div className="space-y-3">
    <p className="font-semibold text-foreground text-sm">Retail (wallets)</p>
    <p className="text-muted-foreground">
      {formatCompactAmount(amount)} {ticker} spread across every wallet holding {ticker} directly, outside
      exchanges, DEX pools, and the addresses itemised elsewhere on this card — from the scheduled
      holders snapshot, not a fixed address list. There's no single "retail" address to link to;
      the Holders and Distribution tabs break it down by wallet size and tier.
    </p>
    {retailStake.note ? (
      <p className="font-medium text-foreground" data-testid="supply-retail-staked-detail">
        {retailStake.note}
      </p>
    ) : null}
    {retailStake.body ? <p className="text-muted-foreground">{retailStake.body}</p> : null}
    {retailStake.principalLinks.length > 0 ? (
      <>
        <StakingAddressList links={retailStake.principalLinks} />
        <a
          href={buildViewHash({ view: "holders", panel: "staking" })}
          className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
        >
          Open Staking Overview
        </a>
      </>
    ) : null}
  </div>
  );
};

export default SupplyBreakdown;
