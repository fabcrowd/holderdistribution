import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { TabsContent } from "@/components/ui/tabs";
import { MethodologyInfo } from "@/components/MethodologyInfo";
import { Badge } from "@/components/ui/badge";
import LockedAnalysisTile from "@/components/LockedAnalysisTile";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Pie, PieChart as RePieChart, Cell, Sector } from "recharts";
import type { PieSectorDataItem } from "recharts/types/polar/Pie";
import {
  useSupplyReconciliation,
  type SupplyReconciliationItem,
} from "@/hooks/useSupplyReconciliation";
import {
  associationCategoryLabel,
  groupSupplyCategories,
  isAssociationCategory,
  isHoldingsCategory,
  isOtherCategory,
  otherCategoryLabel,
  partitionBuckets,
} from "@/lib/supplyBreakdown";
import { ArrowLeft, ChevronRight, ExternalLink, Lock, PieChart } from "lucide-react";
import { EXPLORER_BASE } from "@/lib/telContracts";

/**
 * CoinGecko circulating (comparison only), fallback for when the served
 * supply-reconciliation.json predates its coingeckoCirculating field —
 * scripts/lib/reconcileSupply.js is the source of truth. Traced 2026-08:
 * their implied non-circulating amount (100B - this) is treasury
 * 0x2580…'s exact balance right after its 2025-10-01 transfer to
 * Anchorage (4,922,764,633, within 1,000 TEL of this figure's complement)
 * — a frozen snapshot, not a live read.
 */
const COINGECKO_CIRCULATING = 95_077_236_367;

const SUPPLY_PANELS = [
  { id: "breakdown", label: "Breakdown" },
  { id: "reconciliation", label: "Reconciliation" },
  { id: "history", label: "History" },
  { id: "wallet-flows", label: "Wallet flows" },
];

type SupplyBreakdownProps = {
  /** Page-wide range, so the history chart below matches every other widget. */
  rangeDays: number;
};

const formatCompactTEL = (value: number) => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
};

const formatFullTEL = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Blurred stand-in for an address/subcategory line while locked. */
const BlurredLine = ({ widthClass = "w-32" }: { widthClass?: string }) => (
  <div className={`h-3 ${widthClass} rounded bg-muted-foreground/30 blur-[3px] select-none`} aria-hidden="true" />
);

// Static shell — per-slice color/opacity comes from each bucket's own data, not this config.
const supplyPieChartConfig = { amount: { label: "TEL" } };

/** The selected wedge's "pop toward the viewer" — recharts' standard
 *  activeShape pattern: redraw just that one sector a few px further out
 *  than its siblings, which reads as it lifting off the ring rather than
 *  merely changing color. <Pie>'s own outerRadius leaves room for this (92%,
 *  not 100%) so the grown sector never clips against the chart box. */
const renderActivePieSector = (props: PieSectorDataItem) => {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props;
  return (
    <Sector
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
    case "escrow":
      return <EscrowPanel items={ctx.escrowItems} />;
    case "retail":
      return <RetailPanel amount={ctx.retailAmount} />;
    default:
      return null;
  }
};


const SupplyBreakdown = ({ rangeDays }: SupplyBreakdownProps) => {
  const [panel, setPanel] = useState("breakdown");
  const { data, isLoading, error } = useSupplyReconciliation();
  // Hovered slice — highlights the wedge and its list row together, in
  // either direction.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Which bucket's drill-down popover is open. Lives here rather than inside
  // a row so a click on the WEDGE and a click on that bucket's LIST ROW open
  // the exact same popover instead of two competing ones.
  const [openBucketKey, setOpenBucketKey] = useState<string | null>(null);

  const { buckets, totalSupply, circulating, residualItems, otherItems, associationItems, holdingsItems, dexItems, cexItems, escrowItems } =
    useMemo(() => {
      const total = data?.totalSupply ?? 100_000_000_000;
      const residual = data?.residual ?? Math.max(0, total - (data?.counted ?? 0));
      const all = groupSupplyCategories(data?.categories, residual);
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
      };
    }, [data]);

  // List-only order: the active bucket floats to the top so it's never
  // scrolled off-screen after selection (mobile motivation). The donut's
  // own `pieSlices` is untouched — its array order fixes each wedge's
  // angular position, and reordering it would rotate/reassign colors.
  const orderedBuckets = useMemo(() => {
    if (!openBucketKey) return buckets;
    const idx = buckets.findIndex((b) => b.key === openBucketKey);
    if (idx <= 0) return buckets;
    return [buckets[idx], ...buckets.slice(0, idx), ...buckets.slice(idx + 1)];
  }, [buckets, openBucketKey]);

  const partitionSum = buckets.reduce((s, b) => s + b.amount, 0);
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
      retailAmount: pieSlices.find((s) => s.key === "retail")?.amount ?? 0,
    });
  const coingeckoCirculating = data?.coingeckoCirculating ?? COINGECKO_CIRCULATING;
  const cgDelta = circulating != null ? circulating - coingeckoCirculating : null;


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
            Where every TEL sits — click any segment for more detail
          </CardDescription>
      </CardHeader>
          <CardContent className="space-y-5 pt-2">
            {isLoading && (
              <p className="text-sm text-muted-foreground">Loading supply reconciliation…</p>
            )}
            {error && (
              <p className="text-sm text-destructive">Could not load supply reconciliation.</p>
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
                      {formatCompactTEL(totalSupply)} TEL
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
                  <ChartContainer
                    config={supplyPieChartConfig}
                    // Explicit height rather than aspect-square + max-h: that
                    // combination let the box's reported size disagree with
                    // its rendered circle at some widths (w-full computes
                    // width first, then max-h clamps height independently —
                    // aspect-ratio doesn't reconcile the two backwards), which
                    // showed up as the list's first row rendering underneath
                    // the donut instead of below it.
                    className="mx-auto w-full h-[240px] md:mx-0 md:h-[300px] md:w-[300px] md:shrink-0"
                    role="img"
                    aria-label="TEL total supply by category"
                  >
                    <RePieChart>
                      <ChartTooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const entry = payload[0]?.payload as
                            | { label: string; amount: number; pct: number }
                            | undefined;
                          if (!entry) return null;
                          return (
                            <div className="rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-md">
                              <p className="font-medium text-foreground">{entry.label}</p>
                              <p className="text-muted-foreground tabular-nums">
                                {formatCompactTEL(entry.amount)} TEL ({entry.pct.toFixed(1)}%)
                              </p>
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
                        // (see renderActivePieSector), and needs that 8%
                        // margin to do it without clipping against the box.
                        innerRadius="55%"
                        outerRadius="92%"
                        paddingAngle={0}
                        animationBegin={0}
                        animationDuration={700}
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
                        activeShape={renderActivePieSector}
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

                  {/* The reading surface, at both sizes: every bucket's name,
                      value and share at full text size with a real 44px
                      target, hover-synced with its wedge. */}
                  <div className="w-full min-w-0 space-y-0.5 md:max-w-[30rem]">
                    {orderedBuckets.map((b) => {
                      const pct = totalSupply > 0 ? (b.amount / totalSupply) * 100 : 0;
                      const isOpen = openBucketKey === b.key;
                      // Hovering a row thickens its wedge and vice versa —
                      // the pairing the connector lines used to make, without
                      // the lines.
                      const pieIndex = pieSlices.findIndex((s) => s.key === b.key);
                      const isActive = pieIndex !== -1 && pieIndex === activeIndex;
                      const isRowActive = isOpen || isActive;
                      const anySelected = openBucketKey !== null || activeIndex !== null;
                      return (
                        <motion.button
                          key={b.key}
                          layout
                          transition={{ layout: { duration: 0.3, ease: "easeOut" } }}
                          animate={{ scale: isRowActive ? 1.035 : 1 }}
                          type="button"
                          onMouseEnter={() => pieIndex !== -1 && setActiveIndex(pieIndex)}
                          onMouseLeave={() => setActiveIndex(null)}
                          // Toggle, not open-only: clicking the already-open
                          // row closes it; clicking any other row switches
                          // straight to it (no floating popover to close
                          // first — see the shared panel below the list,
                          // which is what actually renders getDetail now).
                          // A click also reorders `orderedBuckets`, which is
                          // what actually drives the slide-to-top motion —
                          // framer-motion's `layout` prop animates the
                          // resulting DOM-order change.
                          onClick={() => setOpenBucketKey(isOpen ? null : b.key)}
                          // Origin left, not center, so the scale (applied via
                          // `animate` above, not a CSS class — see below)
                          // grows toward the reader instead of also
                          // expanding left past the color dot.
                          className={`flex w-full origin-left items-center justify-between gap-3 rounded-lg px-2.5 py-2.5 min-h-[44px] text-left transition-[background-color,opacity,box-shadow] duration-150 ${
                            isRowActive
                              ? "relative z-10 bg-primary/10 shadow-lg ring-1 ring-primary/30"
                              : "hover:bg-muted/40"
                          } ${anySelected && !isRowActive ? "opacity-40" : "opacity-100"}`}
                        >
                          <span className="flex items-center gap-2.5 min-w-0">
                            <span
                              className="inline-block h-3 w-3 rounded-sm shrink-0"
                              style={{ backgroundColor: b.color }}
                            />
                            <span className="truncate text-sm font-medium text-foreground">{b.label}</span>
                          </span>
                          <span className="tabular-nums text-sm font-semibold shrink-0">
                            {formatCompactTEL(b.amount)}
                            <span className="text-muted-foreground font-normal ml-1.5 text-xs">
                              {pct.toFixed(1)}%
                            </span>
                          </span>
                        </motion.button>
                      );
                    })}
                  </div>
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
                  <p className="mt-3 text-[11px] text-muted-foreground text-center">
                    Segments sum to {formatCompactTEL(partitionSum)} (
                    {Math.abs(partitionSum - totalSupply) < 1
                      ? "exact 100B identity"
                      : `vs ${formatCompactTEL(totalSupply)} total`}
                    ). Solid = retail wallets / DEX LP; muted = exchanges & project; grey = in
                    transit.
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="reconciliation" className="mt-4 space-y-5 focus-visible:outline-none">
                {circulating != null && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground space-y-1">
                    <div>
                      <span className="font-semibold text-foreground">Circulating: </span>
                      {formatCompactTEL(circulating)} TEL
                      <span className="text-muted-foreground">
                        {" "}
                        (counted − treasury − council − Association-committed escrow;
                        Holdings-sourced escrow included)
                      </span>
                    </div>
                    <div>
                      CoinGecko reports {formatCompactTEL(coingeckoCirculating)}
                      {cgDelta != null && (
                        <>
                          {" "}
                          (Δ {cgDelta >= 0 ? "+" : "−"}
                          {formatCompactTEL(Math.abs(cgDelta))}). CoinGecko's figure isn't a
                          different methodology — it's treasury 0x2580…'s exact on-chain balance
                          right after its 2025-10-01 transfer to Anchorage, never refreshed since.
                          Every treasury move after that date, down to today's ~1.43B balance, is
                          invisible to their number.
                        </>
                      )}
                    </div>
                  </div>
                )}
                <TelDispositionLedger />
              </TabsContent>

              {/* Behind a panel rather than always-on: the gate reserves
                  =18rem even when locked, so for a logged-out visitor it was
                  ~288px of blurred placeholder on every load. */}
              <TabsContent value="history" className="mt-4 focus-visible:outline-none">
                <SubscriptionGate
                  minHeightClass="min-h-[18rem]"
                  description="Association Safes, Telcoin Holdings and Escrow balance history. Same password as Reconciliation."
                >
                  <TreasuryHistoryChart rangeDays={rangeDays} />
                  <AssociationFlowAnalysis />
                </SubscriptionGate>
              </TabsContent>

              {/* Password-gated: the report is fetched from the forensics gate
                  function only after unlock; nothing is in the public bundle. */}
              <TabsContent value="wallet-flows" className="mt-4 focus-visible:outline-none">
                <Suspense fallback={<p className="text-xs text-muted-foreground">Loading…</p>}>
                  <WalletFlowsPanel />
                </Suspense>
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
  const parts = data?.residualParts;
  const residual = data?.residual ?? 0;
  return (
    <div className="space-y-3">
      <p className="font-semibold text-foreground text-sm">In transit (bridges)</p>
      <p className="text-muted-foreground">
        Deeper look at the ~{formatCompactTEL(residual)} gap between wallets we can count and the
        official {formatCompactTEL(data?.totalSupply ?? 1e11)} total. Most of this is TEL that is{" "}
        <span className="text-foreground font-medium">
          locked on Ethereum while it moves to Polygon or Base
        </span>
        — not a mysterious missing wallet.
      </p>
      <dl className="space-y-1.5 tabular-nums">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">In transit</dt>
          <dd className="font-medium text-foreground">{formatFullTEL(residual)} TEL</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Locked on Ethereum (bridges)</dt>
          <dd>{formatFullTEL(data?.bridgeLocked ?? 0)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Already showing on Polygon + Base</dt>
          <dd>{formatFullTEL(data?.mirrored ?? 0)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Still crossing bridges</dt>
          <dd>{formatFullTEL(parts?.bridgeInFlight ?? 0)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Tiny scan difference</dt>
          <dd>{formatFullTEL(parts?.originDrift ?? 0)}</dd>
        </div>
      </dl>
      <p className="text-muted-foreground">
        Still crossing ≈ locked on Ethereum − already showing on Polygon/Base. A tiny scan
        difference can nudge the final number slightly.
      </p>
      {data?.upgrade && (
        <div className="border-t border-border/50 pt-2 space-y-1.5">
          <p className="font-semibold text-foreground">TEL v3 upgrade (legacy → v3, 1:1)</p>
          <p className="text-muted-foreground">
            Every wallet balance is legacy TEL plus TEL v3. When a holder upgrades, the legacy TEL is
            locked in Telcoin&apos;s upgrade contract and the same amount of v3 is minted to them — so
            the locked legacy TEL is left out and the v3 is counted instead, never both.
          </p>
          <dl className="space-y-1.5 tabular-nums">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">TEL v3 in existence (all chains)</dt>
              <dd>{formatFullTEL(data.upgrade.v3Supply)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Legacy TEL locked for it (not double-counted)</dt>
              <dd>{formatFullTEL(data.upgrade.retiredLegacy)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Sent to the upgrade contract without upgrading</dt>
              <dd>{formatFullTEL(data.upgrade.strandedInUpgrade)}</dd>
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
}) => (
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
              href={explorerUrl(item)}
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
      <span className="tabular-nums shrink-0 font-medium">{formatCompactTEL(item.balance)}</span>
    </div>
    {password !== null ? (
      <LockedAnalysisTile address={item.address} password={password} />
    ) : (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Lock className="h-3 w-3 shrink-0" />
        Detailed forensic analysis — enter password above to unlock
      </div>
    )}
  </li>
);

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
      <p className="text-muted-foreground">{description}</p>
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
                    {formatCompactTEL(item.balance)}
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

const AssociationPanel = ({ items }: { items: SupplyReconciliationItem[] }) => (
  <AddressListPanel
    title="Telcoin Association-Controlled Safes"
    description="Treasury, council / ops Safes, and the Polygon staking contract — Association-controlled custody, listed together in the hero bucket. Balances checked on-chain."
    items={items}
    subcategoryFor={(item) => associationCategoryLabel(item.category)}
    emptyLabel="No Association addresses itemised."
  />
);

const HoldingsPanel = ({ items }: { items: SupplyReconciliationItem[] }) => (
  <AddressListPanel
    title="Telcoin Holdings"
    description="Confirmed Holdings wallets (~1.65B): reserves, shared Safes, bridge-hub, and Base ops/cold custody."
    items={items}
    subcategoryFor={() => "Telcoin Holdings"}
    emptyLabel="No Holdings addresses itemised."
  />
);

const OtherAddressPanel = ({ items }: { items: SupplyReconciliationItem[] }) => (
  <AddressListPanel
    title="Other addresses"
    description="Independent large wallets, temporary retail labels, burned TEL, and small special cases. Confirmed personal wallets move into Retail after a full holders re-scrape."
    items={items}
    subcategoryFor={(item) => otherCategoryLabel(item.category)}
    emptyLabel="No itemised Other addresses."
  />
);

const DexLiquidityPanel = ({ items }: { items: SupplyReconciliationItem[] }) => (
  <AddressListPanel
    title="DEX Liquidity"
    description="TEL sitting in DEX pools and LP contracts — retail-owned (LP receipts) but protocol-custodied, not held directly by a wallet."
    items={items}
    subcategoryFor={(item) => item.name ?? "DEX pool"}
    emptyLabel="No DEX pool addresses itemised."
  />
);

const CexCustodyPanel = ({ items }: { items: SupplyReconciliationItem[] }) => (
  <AddressListPanel
    title="CEX Custody"
    description="TEL held in known exchange deposit/custody wallets — user balances on that exchange, not project-controlled."
    items={items}
    subcategoryFor={(item) => item.name ?? "Exchange wallet"}
    emptyLabel="No CEX addresses itemised."
  />
);

const EscrowPanel = ({ items }: { items: SupplyReconciliationItem[] }) => (
  <AddressListPanel
    title="Escrow"
    description={
      <>
        TEL held by third-party custodians under a SAFE — ~5.00B is contractually committed back
        to Association treasury and excluded from circulating; the remaining ~1.33B, sourced from
        Telcoin Holdings, stays circulating (traced on-chain in{" "}
        <code className="text-[11px]">data/escrow-safe-provenance.md</code>).
      </>
    }
    items={items}
    subcategoryFor={(item) => item.name ?? "Escrow custodian"}
    emptyLabel="No escrow addresses itemised."
  />
);

const RetailPanel = ({ amount }: { amount: number }) => (
  <div className="space-y-3">
    <p className="font-semibold text-foreground text-sm">Retail (wallets)</p>
    <p className="text-muted-foreground">
      {formatCompactTEL(amount)} TEL spread across every wallet holding TEL directly, outside
      exchanges, DEX pools, and the addresses itemised elsewhere on this card — from the scheduled
      holders snapshot, not a fixed address list. There's no single "retail" address to link to;
      see the Holder Snapshot section above for the full per-chain, per-wallet breakdown and
      individual explorer links.
    </p>
  </div>
);

export default SupplyBreakdown;
