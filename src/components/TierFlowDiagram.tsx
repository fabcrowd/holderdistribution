import { useMemo, useRef, useState, useEffect, useLayoutEffect, useCallback, type ReactNode } from "react";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { useProject } from "@/hooks/useProject";
import { PARTIAL_DAY_LABEL } from "@/lib/flowFeeds";
import { flowEmptyMessage } from "@/lib/flowEmptyState";
import { AsOfBadge } from "@/components/AsOfBadge";
import { useChartIntro } from "@/hooks/useMotion";
import { ChevronLeft, ChevronRight, RotateCw, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { InfoTooltip } from "@/components/InfoTooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Callout } from "@/components/ui/callout";
import { useExchangeFlow } from "@/hooks/useExchangeFlow";
import { useMediaQuery, PHONE_QUERY } from "@/hooks/useMediaQuery";
import { describeFreshness } from "@/lib/format";
import { StatStrip, INFO_HIT_44, type Stat } from "@/components/tierflow/StatStrip";
import { buySellTip, dexTip, netTelTip, tierPrompt } from "@/components/tierflow/statCopy";
import { ExplainNumber } from "@/components/tierflow/ExplainNumber";
import { WalletColumnHeaders, PhoneListHeader, type ColumnAnchors } from "@/components/tierflow/WalletColumnHeaders";
import { scrollEdges, scrollStepPx, type ScrollEdges } from "@/lib/tabScroll";
import { prefersReducedMotion } from "@/lib/motion";
import { netChangeTip, periodPhrase, walletColumns } from "@/components/tierflow/columnCopy";
import { netTelOf, netOf, netDisplay, netSlotText, type FlowAvailability } from "@/components/tierflow/net";
import { focusTierTile } from "@/components/tierflow/focusTier";
import { TierRail } from "@/components/tierflow/TierRail";
import { TierFlowTableSheet } from "@/components/tierflow/TierFlowTableSheet";
import { signed, fmtTel, fmtInt } from "@/components/tierflow/format";
import {
  POSITIVE, NEGATIVE, NEUTRAL, POSITIVE_TEXT, NEGATIVE_TEXT, MUTED, REDISTRIBUTION_DASH, type Tone,
} from "@/components/tierflow/palette";
import {
  CANVAS_W, rowTop, rowCenterY, tierLeftX, TIER_COL_CENTER_X, tileEdgeX, TIER_TILE_W, tierBarFraction,
  SIDE_H, PITCH, bezierPath, laneArcPath, fanY, strokeWidth, rankedStrokeWidths, TIER_H,
  tierDisplayLabel, CANVAS_H as DEFAULT_CANVAS_H, canvasWidthFor, canvasOriginX, laneArcMid,
} from "@/components/tierflow/geometry";
import { tierCanvasScale } from "@/lib/tierFlowScale";
import { useTierGeometry } from "@/components/tierflow/useTierGeometry";
import { useFlowField, type ChainKey, type TierRow, type Cause, type TierField } from "@/components/tierflow/useFlowField";
import {
  netMigrationsFor, netCausesFor, valueForSideTile, sideTileContributions, sideTileRowIndex, SIDE_TILE_LABELS,
  retailDemandFor, tierDexActivity,
  type FlowTone, type SideTileSelection, type SideTileKey,
} from "@/components/tierflow/netFlow";
import { RANGE_OPTIONS, ytdDays, ytdStartMs } from "@/lib/timeRange";
import { baselineLabel } from "@/lib/baseline";
import { useClassificationChangelog, getEventsAffecting, type ClassificationEvent } from "@/hooks/useClassificationChangelog";
import {
  EMPTY_SELECTION, reduceSelection, shouldClearOnEscape, type DistAction, type DistSelection,
} from "@/lib/distributionSelection";

export type { TierRow };
export type TierMetric = "wallets" | "tel";
type Props = {
  rangeDays: number;
  rows: TierRow[];
  metric: TierMetric;
  onMetricChange: (m: TierMetric) => void;
  /** Real date of the snapshot the snapshot-based deltas (Tiers table) are
   *  compared against. Net figures are joined - left / in - out over the
   *  crossings window, not this date. */
  baselineDate?: string | null;
  /** Caption that used to sit above the diagram (scope + dust note); shown in
   *  the (i) beside the title instead. */
  infoPrefix?: string;
  /** Chain filter from the page-level selector; defaults to all chains. */
  chain?: ChainKey;
  /** Controlled selection, shared with sibling panels (Tiers table, bars). */
  selection?: DistSelection;
  onSelectionChange?: (next: DistSelection) => void;
  /** "terminal": fits the canvas to its container in both dimensions and
   *  drops the card chrome the surrounding panel already provides. */
  layout?: "stacked" | "terminal";
};

// Palette (strict green / red / yellow classification) lives in tierflow/palette.
const BUY_DEX = POSITIVE, BUY_CEX = POSITIVE, BUY_WALLET = NEUTRAL;
const colorForVerdict = (verdict: "unknown" | "relocated" | "sold") =>
  (verdict === "relocated" ? NEUTRAL : verdict === "sold" ? NEGATIVE : MUTED);
// netFlow.ts stays palette-free and returns a semantic tone; the view owns
// the mapping to actual hues.
const colorForTone = (tone: FlowTone) => (tone === "positive" ? POSITIVE : tone === "negative" ? NEGATIVE : NEUTRAL);
/** Light tinted fill so selected/idle pressure tiles keep core chroma visible. */
const tintFill = (color: string, alpha = 0.15) =>
  color.startsWith("hsl(") ? color.replace(/\)$/, ` / ${alpha})`) : color;

// Tier tiles are one neutral surface in both modes and themes; colour is
// reserved for the selection (brand teal) and for the flow lines/ticks.
const TILE_SURFACE = "hsl(var(--ha-brand-tint))";
const TILE_ACCENT = "hsl(var(--primary))";

// Floors for the canvas scale. TEL is wider than a tablet, so below the floor
// it scrolls sideways rather than shrink its 13px type further.
const TEL_STACKED_MIN_SCALE = 0.86;
const TEL_TERMINAL_MIN_SCALE = 0.8;
const TOP_AMOUNT_LABELS = 3;
const topKeys = (lines: readonly { key: string; w: number }[]) =>
  new Set([...lines].sort((a, b) => b.w - a.w).slice(0, TOP_AMOUNT_LABELS).map((l) => l.key));

// Two entirely separate explainer texts, one per mode — each describes ONLY
// what that mode actually shows, instead of one paragraph covering both
// wallet migration and TEL cause-breakdown regardless of which is on screen.
const INFO_RESET = "Press Esc or Clear to reset the selection.";
const INFO_WALLETS =
  "Each tile is a retail balance tier, sized by holder count. The two small ticks flanking a tile are gross migration counts over the selected period: on the left, in green, how many wallets ARRIVED into that tier; on the right, in red, how many LEFT it. While a tier is selected, the figure inside each tile is its net: Net = joined - left.\n\nClick a tier to see exactly which tiers its wallets came from (arriving on the left) and went to (leaving on the right) — the lines are the whole story: this mode answers \"why did the wallet COUNT change,\" using only real, tracked wallet movement between tiers.";
const INFO_TEL =
  "Each tile is a retail balance tier, sized by total {ticker} held. The lens is buy pressure vs sell pressure over the selected period: green on the left is {ticker} entering retail from the market or custody (Bought on DEX, From exchange); red on the right is {ticker} leaving toward a sale (Sold on DEX, To exchange). Yellow is redistribution — LP or wallet↔wallet — not market pressure.\n\nClick a tier to scope the top tiles and side columns to that tier; click off to restore period totals. Yellow To wallet / From wallet is a two-step drill: select a tier first, then that side tile to trace transfers tier-to-tier.\n\nOr click a side tile alone (Bought on DEX, From exchange, …) with no tier selected to see every tier’s share of that pressure.\n\nNet = {ticker} in - {ticker} out, over the selected period.";

const SIDE_LABELS_IN = [
  { key: "dex" as const, label: "Bought on DEX", color: BUY_DEX },
  { key: "lp" as const, label: "Unstaked from LP", color: NEUTRAL },
  { key: "cex" as const, label: "From exchange", color: BUY_CEX },
  { key: "wallet" as const, label: "From wallet", color: BUY_WALLET },
];
const SIDE_LABELS_OUT = [
  { key: "dex" as const, label: "Sold on DEX", color: NEGATIVE },
  { key: "lp" as const, label: "Added to LP", color: NEUTRAL },
  { key: "cex" as const, label: "To exchange", color: NEGATIVE },
  { key: "wallet" as const, label: "To wallet", color: NEUTRAL },
];

const NO_EDGES: ScrollEdges = { overflowing: false, left: false, right: false };
const SCROLL_BUTTON_CLASS =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const TAP_TARGET_PX = 44;
// Canvas px of invisible hit-area padding needed so a control renders at
// >= 44 screen px once the canvas is scaled down; capped so neighbours (tier
// rows are PITCH apart) never overlap.
const hitPad = (scale: number, ownSize: number, cap: number) =>
  Math.min(cap, Math.max(0, (TAP_TARGET_PX / scale - ownSize) / 2));
// Gap between a tier bar and its gross in/out tick. The selected tile's outline
// (ring-2 + ring-offset-1 + scale-[1.015]) extends about 5px past the bar, so 8px
// keeps the tick text clear of it.
const TICK_GAP_PX = 8;
const WALLETS_COL_INSET_PX = 48;
// Fixed-width net slot inside each tile while something is selected, so every
// count keeps one right edge. Shift = slot width + gap before it.
const NET_SLOT_W_PX = 64; // fits 8-char nets such as "+123,456" at 13px
const NET_TONE_CLASS = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-muted-foreground",
} as const;
const NET_SLOT_SHIFT_PX = NET_SLOT_W_PX + 6;
const TICK_FADE = "transition-[opacity,visibility] duration-150 ease-out motion-reduce:transition-none";
// Halo in the card colour so migration lines passing behind a tick never strike
// through its figure (HTML text has no paint-order stroke).
const TICK_HALO = "0 0 2px hsl(var(--card)), 0 0 2px hsl(var(--card)), 0 0 1px hsl(var(--card))";

const LEGEND: { color: string; label: string; short: string; explanation: string; dashed?: boolean }[] = [
  { color: POSITIVE, label: "Buy pressure", short: "Buy", explanation: "{ticker} entering retail from the market or custody — bought on a DEX, or withdrawn from an exchange into self-custody. In Wallets mode, also wallets ARRIVING into a tier (left-hand tick and inbound migration lines)." },
  { color: NEGATIVE, label: "Sell pressure", short: "Sell", explanation: "{ticker} leaving retail toward a sale — sold on a DEX, or deposited to an exchange (a common precursor to a sale). In Wallets mode, a tier's right-hand tick or outbound migration line uses this when that tier's outflow was dominated by real sales rather than wallet-to-wallet moves." },
  { color: NEUTRAL, dashed: true, label: "Redistribution", short: "Redistribution", explanation: "{ticker} moved to another wallet or added to / withdrawn from an LP pool — not market buy or sell pressure. In Wallets mode, used when a tier's outflow was mostly relocation, not a sale." },
];

export const TierFlowDiagram = ({
  rangeDays,
  rows,
  metric,
  onMetricChange,
  baselineDate,
  infoPrefix,
  chain: chainProp,
  selection: selectionProp,
  onSelectionChange,
  layout = "stacked",
}: Props) => {
  // One-shot: fades with the first load, not when a chain change reloads it.
  const canvasIntro = useChartIntro();
  const { ticker, t } = useProjectCopy();
  // Active project's tier rows + the canvas height / side-tile positions they
  // imply (TEL: the historical 10 tiers, 682px — unchanged).
  const { tiers: TIERS, canvasH: CANVAS_H, sideTop, sideCenterY } = useTierGeometry();
  // Chain is driven by the page-level chain selector (the in-diagram chain
  // buttons were a second, conflicting control). Uncontrolled = all chains.
  const chain: ChainKey = chainProp ?? "all";
  // Selection is shared with the Tiers table / net-change bars on desktop
  // (DistributionTerminal owns it); standalone it is internal.
  const [innerSelection, setInnerSelection] = useState<DistSelection>(EMPTY_SELECTION);
  const selection = selectionProp ?? innerSelection;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const dispatch = useCallback(
    (action: DistAction) => {
      const next = reduceSelection(selectionRef.current, action);
      if (next === selectionRef.current) return;
      selectionRef.current = next;
      if (onSelectionChange) onSelectionChange(next);
      if (!selectionProp) setInnerSelection(next);
    },
    [onSelectionChange, selectionProp],
  );
  const selected = selection.tier;
  // Second level of disclosure, on top of `selected`: which single flow has
  // been broken open from its net figure into its underlying gross flows.
  // Holds a counterpart tier label in Wallets mode or a cause key in TEL mode
  // — the two modes are mutually exclusive, so one variable serves both.
  const expandedFlow = selection.expandedFlow;
  // Lighter-weight PREVIEW layer on top of the click-driven expansion above:
  // hovering a canvas line (or focusing its matching panel row) sets this,
  // driving a bubble + dim-the-rest effect without pinning anything open.
  // Same key space as expandedFlow (counterpart label / cause key).
  const [hoveredFlow, setHoveredFlow] = useState<string | null>(null);
  // Third level, TEL mode only: once the "Other wallets" category is broken
  // open, its per-counterparty-tier attribution draws its OWN lines (side
  // tile <-> tier tiles). This tracks which one of THOSE is hovered, keyed by
  // tier label — kept separate from hoveredFlow (a cause-key/counterpart-
  // label space) so a tier label here can never collide with a Wallets-mode
  // counterpart label or a TEL cause key.
  const [hoveredAttrTier, setHoveredAttrTier] = useState<string | null>(null);
  // TEL mode: pivot the canvas around a SIDE TILE (cause category) instead of
  // a tier — draws lines from that tile to every tier that contributed, with
  // a contribution panel. Mutually exclusive with `selected` (except the
  // wallet 2-step drill — see lib/distributionSelection).
  const selectedSideTile = selection.sideTile;
  const isTerminal = layout === "terminal";
  // Callback ref, not useRef: the canvas only mounts once data is ready (a
  // skeleton renders while loading), so an effect keyed on a ref object ran
  // against null and never attached its ResizeObserver — the diagram stayed
  // at scale 1 and overflowed. A state-backed ref re-runs the effect when the
  // node actually appears.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // 1 until measured, so the first paint is the unshrunken desktop layout.
  const [scale, setScale] = useState(1);
  const { fields, netInfo, avail, grossExplainer, maxMigrationCount, loading, errored, empty, ready, complete, attributedDays, totalDays, sourceTierSince, outflowsAsOf, crossingsWindow, partialToday } = useFlowField(rows, chain, metric, rangeDays);
  const { data: exchangeFlow } = useExchangeFlow();
  const { project } = useProject();
  const flowsEmptyText = flowEmptyMessage(project, "tier");
  const rangeLabel = `${RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? `${rangeDays}D`}${partialToday ? ` ${PARTIAL_DAY_LABEL}` : ""}`;
  const isWallets = metric === "wallets";
  // Wallets mode crops the empty side gutters out of the same coordinate space.
  const canvasW = canvasWidthFor(metric);
  const originX = canvasOriginX(metric);
  // Under 640px the scaled-down canvas renders tier labels at ~6px; phones
  // get a stacked, full-size list driving the same selection + detail panel.
  const isPhone = useMediaQuery(PHONE_QUERY);
  // Phone copy is trimmed to headline numbers; the explanations open on tap.
  const compact = isPhone && !isTerminal;
  // Touch (phones and coarse-pointer tablets) taps; mouse clicks.
  const coarse = useMediaQuery("(pointer: coarse)");
  const verb = isPhone || coarse ? "Tap" : "Click";
  const asOf = describeFreshness(outflowsAsOf);

  const { data: changelog } = useClassificationChangelog();

  // No time-axis chart exists on this diagram to attach a boundary marker to
  // (it's a snapshot for one selected rangeDays window, not a timeline) — so
  // reclassification events get a banner instead, gated on whether one falls
  // inside the currently-visible window. Checks both metrics the KuCoin vault
  // relabel affects (cexBalance, vault-unattributed); extend here if a future
  // event touches a different tier-outflow-relevant metric name.
  const flowChangelogEvents = useMemo(() => {
    const end = Date.now();
    const start = rangeDays === ytdDays()
      ? ytdStartMs(new Date(end))
      : end - rangeDays * 86400000;
    const merged = new Map<string, ClassificationEvent>();
    for (const metricName of ["cexBalance", "vault-unattributed"]) {
      for (const event of getEventsAffecting(changelog, metricName, start, end)) {
        merged.set(event.id, event);
      }
    }
    return Array.from(merged.values());
  }, [changelog, rangeDays]);

  // Land the initial horizontal scroll on the tier COLUMN'S CENTER — bars now
  // grow left/right from a shared center line, so centering the viewport on
  // that line (using the container's own clientWidth, not anything about the
  // bars themselves) keeps every bar's middle in view regardless of its
  // width, on any screen. Still measurement-free in the sense that matters:
  // no layout POSITION is derived from a measurement, only this one-time
  // scroll offset is.
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);
  useLayoutEffect(() => {
    const el = scrollEl;
    if (el && !isTerminal) el.scrollLeft = Math.max(0, (TIER_COL_CENTER_X - originX) * scale - el.clientWidth / 2);
    // edges.overflowing: the scroll buttons narrow the viewport when they appear, so centre again.
  }, [scrollEl, ready, scale, isTerminal, originX, edges.overflowing]);

  // Sideways-scroll cue (stacked layout only): which edges still hide diagram.
  useLayoutEffect(() => {
    const el = scrollEl;
    if (!el) return;
    const sync = () => {
      const next = scrollEdges({ scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      setEdges((prev) => (prev.overflowing === next.overflowing && prev.left === next.left && prev.right === next.right ? prev : next));
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => el.removeEventListener("scroll", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => { el.removeEventListener("scroll", sync); observer.disconnect(); };
  }, [scrollEl, scale, canvasW]);
  const scrollCue = !isTerminal && edges.overflowing;
  const nudgeCanvas = (direction: 1 | -1) => {
    scrollEl?.scrollBy({ left: direction * scrollStepPx(scrollEl.clientWidth), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  // Scale-to-fit. The canvas is a fixed 936×682 grid — every tile position is
  // computed in those coordinates, so it cannot reflow. The wrapper carries
  // the scaled size because a transform does not affect layout.
  //
  // Stacked layout: fit the WIDTH (the page scrolls vertically anyway).
  // Terminal layout: fit the WIDTH only, and never below the readable floor
  // (lib/tierFlowScale). Fitting the height as well is what crushed 13px
  // labels to ~8px in a short cell. Extra height scrolls with the page.
  useLayoutEffect(() => {
    const el = scrollEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = tierCanvasScale({
        terminal: isTerminal,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        canvasW,
        canvasH: CANVAS_H,
        minScale: isWallets ? undefined : isTerminal ? TEL_TERMINAL_MIN_SCALE : TEL_STACKED_MIN_SCALE,
      });
      setScale((prev) => (Math.abs(prev - next) < 0.002 ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollEl, isTerminal, CANVAS_H, canvasW, isWallets]);

  // An expansion key is only meaningful within one mode (a counterpart tier
  // label in Wallets, a cause key in TEL), so switching modes must clear it
  // rather than leave a key that can never match. Metric is a prop, so this
  // is handled here rather than in the toggle's own onClick — it stays
  // correct even if the parent changes the metric some other way.
  useEffect(() => {
    dispatch({ type: "reset-mode" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mode change
  }, [metric, rangeDays]);
  // Hover previews belong to the selection they were drawn for.
  useEffect(() => {
    setHoveredFlow(null);
    setHoveredAttrTier(null);
  }, [selected, selectedSideTile, expandedFlow]);

  // Phones/tablets: the detail renders below a long list or canvas, so a tap
  // that opens it must bring it into view (it used to open off-screen).
  const inlineDetailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isTerminal || (!selected && !selectedSideTile)) return;
    const id = window.requestAnimationFrame(() => {
      const el = inlineDetailRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top > window.innerHeight * 0.6 || r.top < 0) {
        el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [selected, selectedSideTile, isTerminal]);

  // Escape clears the selection (after any open popover/dialog has had the
  // chance to close itself — see shouldClearOnEscape).
  useEffect(() => {
    if (!selected && !selectedSideTile) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldClearOnEscape(e, document)) dispatch({ type: "clear" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, selectedSideTile, dispatch]);

  // Selecting/deselecting a tier collapses any open flow with it: the
  // expansion belongs to the tier that was selected when it was opened.
  // Also clears a side-tile pivot — the two selection modes are exclusive.
  const selectTier = (label: string) => dispatch({ type: "tier", label });
  // Side-tile click has two modes:
  // 1) No tier selected → market-wide pivot (fan from that cause to every tier).
  // 2) Tier already selected + wallet tile → keep the tier and drill into
  //    that tier's wallet↔wallet destinations/sources as tier-to-tier traces.
  // DEX/CEX side tiles clear the tier (no per-counterpart attribution).
  const selectSideTile = (next: SideTileSelection) => dispatch({ type: "side", tile: next });
  const toggleFlow = (key: string) => dispatch({ type: "flow", key });
  // Clear / the rail's close button unmount while focused, which would drop
  // focus on <body>. In the stacked layout (the terminal does this itself) send
  // it back to the tile that was selected once the panel has gone.
  const clearSelection = () => {
    const previous = selected;
    dispatch({ type: "clear" });
    if (!isTerminal && previous) requestAnimationFrame(() => focusTierTile(previous));
  };

  const fieldOf = (label: string) => fields.find((f) => f.label === label) ?? null;
  const selectedField = selected ? fieldOf(selected) : null;

  // Whole-market DEX buy/sell — sourced directly from useExchangeFlow (ALL
  // wallets, not just retail), never derived from summing the retail tiers
  // below. tier-outflows.json is retail-only, so a sum-of-tiers figure would
  // be a structurally smaller, differently-scoped number — presenting one as
  // the other would recreate the exact "two numbers that don't reconcile"
  // class of bug this redesign exists to fix. Kept visually and textually
  // distinct via its own labeled block, not blended into the tier data. TEL
  // mode only — a DEX trade doesn't have a "wallet count" reading.
  const wholeMarket = useMemo(() => {
    if (!exchangeFlow || exchangeFlow.length === 0) return null;
    const latestTs = Date.parse(exchangeFlow[exchangeFlow.length - 1].date);
    // Matches the selected range, not always calendar-YTD — the same window
    // convention DexSwaps.tsx uses for the non-unified fallback view. Only
    // the literal YTD option gets the Jan-1 calendar boundary; "1Y" (also
    // 365 days, but NOT the same option) stays a rolling window like every
    // other range.
    const windowStart = rangeDays === ytdDays()
      ? new Date(new Date(latestTs).getUTCFullYear(), 0, 1).getTime()
      : latestTs - rangeDays * 86400000;
    const inRange = exchangeFlow.filter((e) => Date.parse(e.date) >= windowStart);
    if (inRange.length === 0) return null;
    const sold = inRange.reduce((s, e) => s + (e.dexIn ?? 0), 0);
    const bought = inRange.reduce((s, e) => s + (e.dexOut ?? 0), 0);
    const hasDex = inRange.some((e) => e.dexIn != null || e.dexOut != null);
    return hasDex ? { sold, bought, net: bought - sold } : null;
  }, [exchangeFlow, rangeDays]);

  // Net DEMAND = buy pressure − sell pressure (DEX + exchange only).
  // Scoped to the selected tier when one is open; otherwise period-wide.
  const retailDemand = useMemo(
    () => retailDemandFor(fields, selectedField?.cause ?? null),
    [fields, selectedField],
  );

  // Net TEL = TEL in minus TEL out: the selected tier's, or the sum across tiers.
  // The net figures cover the crossings / outflows window, not the snapshot baseline.
  const walletsPeriod = periodPhrase(crossingsWindow, fmtDay);
  const telPeriod = periodPhrase(null);
  const periodByMetric = { wallets: walletsPeriod, tel: telPeriod };
  const scopedNetTel = !avail.hasOutflows ? null : selectedField ? netTelOf(selectedField) : netInfo.netTel;

  // DEX bought/sold: whole-market when no tier selected; that tier's swaps when selected.
  const scopedDex = useMemo(() => {
    if (selectedField) return tierDexActivity(selectedField.cause);
    return wholeMarket;
  }, [selectedField, wholeMarket]);
  const tierLabelShort = selectedField ? tierDisplayLabel(selectedField.label) : null;

  const maxPct = Math.max(1, ...fields.map((f) => f.pct));
  // Header anchors: tile edges are constant, so the ticks fall in two straight
  // columns. 20 = half the 40px tick box (min-w-[40px]) the figures sit in.
  const columnAnchors: ColumnAnchors = (() => {
    const TICK_HALF = 20;
    return {
      joined: tileEdgeX("left") - TICK_GAP_PX - TICK_HALF,
      // Counts are right-aligned in the tile (10px pad + 18px chevron slot),
      // so centre the header over a typical 3-digit count, not the tile.
      // With a selection the net slot takes the count's old place and the
      // counts shift left by the slot width.
      wallets: tileEdgeX("right") - WALLETS_COL_INSET_PX - (selected || selectedSideTile ? NET_SLOT_SHIFT_PX : 0),
      left: tileEdgeX("right") + TICK_GAP_PX + TICK_HALF,
    };
  })();

  // Migration lines for the selected tier, arcing through the left (net gain)
  // or right (net loss) lane and landing exactly on the counterpart tile's
  // edge (all tiles share the same edges). Each path's `d` is
  // built in the ACTUAL flow direction (source first, destination last) so
  // the animated dot travels the true direction.
  //
  // Level 1 (default): ONE net line per counterpart. Level 2: the counterpart
  // in `expandedFlow` is broken back open into its real gained + lost arcs,
  // while every other counterpart stays netted.
  // WALLETS mode only — these are wallet counts, not TEL.
  const migrationLines = useMemo(() => {
    if (!selectedField || !isWallets) return [];
    const selfX = { left: tileEdgeX("left"), right: tileEdgeX("right") };
    const y0 = rowCenterY(selectedField.index);

    // Collect what each side will draw BEFORE positioning, so every line fans
    // against its true neighbours — an expanded counterpart contributes one
    // line to each side, and both have to fan with the rest of that side.
    type Spec = { counterpart: string; side: "left" | "right"; value: number; up: boolean; incoming: boolean; label: string };
    const specs: Spec[] = [];
    for (const n of netMigrationsFor(selectedField.migrations)) {
      if (n.counterpart === expandedFlow) {
        for (const m of selectedField.migrations) {
          if (m.counterpart !== n.counterpart || m.count <= 0) continue;
          specs.push({
            counterpart: n.counterpart, side: m.gained ? "left" : "right",
            value: m.count, up: m.up, incoming: m.gained,
            label: `${m.gained ? "+" : "−"}${fmtInt(m.count)}`,
          });
        }
      } else if (n.net !== 0) {
        specs.push({
          counterpart: n.counterpart, side: n.side, value: Math.abs(n.net),
          up: n.up, incoming: n.net > 0, label: signed(n.net, fmtInt),
        });
      }
      // net === 0 and not expanded: equal in both directions, so there is no
      // net movement to draw. The panel still lists it (see WalletsPanel) so
      // the churn isn't hidden, it just doesn't earn a line here.
    }

    // One shared width scale (max gross count) across BOTH levels on purpose:
    // a net line is then legitimately thinner than the gross arcs it opens
    // into, and "thicker = more wallets" keeps one meaning throughout.
    const out: { key: string; flowKey: string; d: string; color: string; w: number; label: string; labelX: number; labelY: number; tooltip: string; dashed: boolean }[] = [];
    for (const side of ["left", "right"] as const) {
      const list = specs.filter((s) => s.side === side);
      list.forEach((s, k) => {
        const cIdx = TIERS.indexOf(s.counterpart);
        if (cIdx < 0) return;
        const theirY = rowCenterY(cIdx);
        const theirX = tileEdgeX(side);
        const myY = fanY(y0, k, list.length);
        const myX = selfX[side];
        const d = s.incoming ? laneArcPath(theirX, theirY, myX, myY, side) : laneArcPath(myX, myY, theirX, theirY, side);
        // Bubble content: the expanded (gross) sub-line reads as a plain
        // arrival/departure; the collapsed (net) line states it's a net
        // figure so it isn't mistaken for the full gross amount.
        const tooltip = s.counterpart === expandedFlow
          ? (s.incoming ? `${fmtInt(s.value)} arrived from ${s.counterpart}` : `${fmtInt(s.value)} left for ${s.counterpart}`)
          : (s.incoming ? `Net ${fmtInt(s.value)} into ${selectedField.label} from ${s.counterpart}` : `Net ${fmtInt(s.value)} out of ${selectedField.label} to ${s.counterpart}`);
        // Colour by DIRECTION relative to this tier, not by `up`. Arrivals are
        // green; departures take this tier's outflow verdict (sold-dominated →
        // red, wallet relocation → yellow). Keying on `up` painted an arrival
        // from a LARGER tier with this tier's sale verdict — those wallets left
        // someone else's tier, so this tier's "sold" verdict never applied to
        // them (the narrative helper below already refuses to say otherwise).
        // Label on the arc itself (its apex), clear of the tick figures beside the tile.
        const mid = s.incoming ? laneArcMid(theirX, theirY, myX, myY, side) : laneArcMid(myX, myY, theirX, theirY, side);
        out.push({
          key: `${side}-${s.counterpart}`, flowKey: s.counterpart, d,
          color: s.incoming ? POSITIVE : colorForVerdict(selectedField.verdict),
          dashed: !s.incoming && selectedField.verdict === "relocated",
          w: strokeWidth(s.value, maxMigrationCount), label: s.label,
          labelX: mid.x, labelY: mid.y,
          tooltip,
        });
      });
    }
    return out;
  }, [selectedField, maxMigrationCount, isWallets, expandedFlow, TIERS]);

  // TEL-mode equivalent of the above, on the same two-level model: level 1
  // draws ONE net line per cause category (three lines, not six), entering
  // from the left source tile when the net is positive or leaving to the
  // right sink tile when negative; level 2 breaks the expanded category back
  // into its real came + went pair. Reuses the exact geometry the six-line
  // view already used — a net line IS one of those two paths, chosen by sign.
  const telLines = useMemo(() => {
    if (!selectedField || isWallets) return [];
    const { cause } = selectedField;
    // One denominator for both levels so a net line stays legitimately
    // thinner than the gross lines it opens into (same rationale as Wallets).
    const denom = Math.max(cause.inTotal, cause.total, 1);
    const destX = tileEdgeX("left");
    const srcX = tileEdgeX("right");
    const barY = (j: number) => fanY(rowCenterY(selectedField.index), j, 3);
    const out: { key: string; flowKey: string; d: string; color: string; w: number; label: string; labelX: number; labelY: number; tooltip: string; dashed: boolean }[] = [];
    // Built source-first (origin -> destination) throughout so the pulsing
    // dot always travels the direction the TEL actually moved.
    const came = (j: number, v: number, color: string, label: string, tooltip: string) => ({
      key: `came-${j}`, d: bezierPath(198, sideCenterY(j), destX, barY(j)), color, dashed: color === NEUTRAL,
      w: strokeWidth(v, denom), label, labelX: destX - 44, labelY: (sideCenterY(j) + barY(j)) / 2, tooltip,
    });
    const went = (j: number, v: number, color: string, label: string, tooltip: string) => ({
      key: `went-${j}`, d: bezierPath(srcX, barY(j), 738, sideCenterY(j)), color, dashed: color === NEUTRAL,
      w: strokeWidth(v, denom), label, labelX: srcX + 44, labelY: (sideCenterY(j) + barY(j)) / 2, tooltip,
    });
    netCausesFor(cause).forEach((c, j) => {
      // Gross expand: color each leg by what it is — inflows green (buy),
      // outflows red (sell), wallet↔wallet always yellow — not by the net
      // tone of the category (which painted both legs the same color).
      const inColor = c.key === "wallet" ? NEUTRAL : POSITIVE;
      const outColor = c.key === "wallet" ? NEUTRAL : NEGATIVE;
      if (c.key === expandedFlow) {
        // Wallet drill is told by yellow tier-to-tier attribution arcs (see
        // attributionLines) — skip the side-tile hop so the canvas doesn't
        // draw two competing yellow stories at once.
        if (c.key === "wallet") return;
        if (c.inV > 0) out.push({ ...came(j, c.inV, inColor, `+${fmtTel(c.inV)}`, `${fmtTel(c.inV)} ${ticker} ${c.inLabel}`), key: `came-${c.key}`, flowKey: c.key });
        if (c.outV > 0) out.push({ ...went(j, c.outV, outColor, `−${fmtTel(c.outV)}`, `${fmtTel(c.outV)} ${ticker} ${c.outLabel}`), key: `went-${c.key}`, flowKey: c.key });
      } else if (c.net !== 0) {
        const netTooltip = c.net > 0 ? `Net ${fmtTel(c.net)} ${ticker} in from ${c.label}` : `Net ${fmtTel(-c.net)} ${ticker} out to ${c.label}`;
        const line = c.net > 0 ? came(j, c.net, colorForTone(c.tone), signed(c.net, fmtTel), netTooltip) : went(j, -c.net, colorForTone(c.tone), signed(c.net, fmtTel), netTooltip);
        out.push({ ...line, key: `net-${c.key}`, flowKey: c.key });
      }
    });
    return out;
  }, [selectedField, isWallets, expandedFlow, ticker, sideCenterY]);

  // Third level: once the "Other wallets" category is drilled into (path
  // click, panel row, OR the 2-step: tier selected → click To/From wallet),
  // draw yellow TIER-TO-TIER arcs between the selected tier and each
  // attributed counterpart — the actual redistribution paths, not a hop
  // through the side-tile column. Direction filter: To wallet → only
  // destinations (movedByDestTier); From wallet → only sources
  // (inflowsBySourceTier); path/panel expand with no side filter → both.
  // Gated like TierAttributionBreakdown (all chains + real attribution days).
  const attributionLines = useMemo(() => {
    if (isWallets || !selectedField || expandedFlow !== "wallet" || chain !== "all" || attributedDays === 0) return [];
    const { cause } = selectedField;
    const selfLeft = tileEdgeX("left");
    const selfRight = tileEdgeX("right");
    const y0 = rowCenterY(selectedField.index);
    const walletSideFilter = selectedSideTile?.key === "wallet" ? selectedSideTile.side : null;
    const showIn = walletSideFilter == null || walletSideFilter === "in";
    const showOut = walletSideFilter == null || walletSideFilter === "out";
    const inEntries = showIn
      ? Object.entries(cause.inflowsBySourceTier).filter(([tier, v]) => tier !== "untracked" && v > 0)
      : [];
    const outEntries = showOut
      ? Object.entries(cause.movedByDestTier).filter(([tier, v]) => tier !== "untracked" && v > 0)
      : [];
    const inDenom = Math.max(cause.receivedWallet, 1);
    const outDenom = Math.max(cause.moved, 1);
    const out: { key: string; tier: string; d: string; color: string; w: number; label: string; labelX: number; labelY: number; tooltip: string; dashed: boolean }[] = [];

    // Fan each side against its own neighbours so arcs don't stack on one y.
    inEntries.forEach(([tier, v], k) => {
      const cIdx = TIERS.indexOf(tier);
      if (cIdx < 0) return;
      const theirX = tileEdgeX("left");
      const theirY = rowCenterY(cIdx);
      const myY = fanY(y0, k, inEntries.length);
      // Source-first: counterpart → selected (TEL arrived from that tier).
      out.push({
        key: `attr-in-${tier}`, tier, color: NEUTRAL, dashed: true, w: strokeWidth(v, inDenom),
        d: laneArcPath(theirX, theirY, selfLeft, myY, "left"),
        label: `+${fmtTel(v)}`, labelX: selfLeft - 40, labelY: (myY + theirY) / 2,
        tooltip: `${fmtTel(v)} ${ticker} arrived from ${tier} via wallet transfer`,
      });
    });
    outEntries.forEach(([tier, v], k) => {
      const cIdx = TIERS.indexOf(tier);
      if (cIdx < 0) return;
      const theirX = tileEdgeX("right");
      const theirY = rowCenterY(cIdx);
      const myY = fanY(y0, k, outEntries.length);
      // Source-first: selected → counterpart (TEL left for that tier).
      out.push({
        key: `attr-out-${tier}`, tier, color: NEUTRAL, dashed: true, w: strokeWidth(v, outDenom),
        d: laneArcPath(selfRight, myY, theirX, theirY, "right"),
        label: `−${fmtTel(v)}`, labelX: selfRight + 40, labelY: (myY + theirY) / 2,
        tooltip: `${fmtTel(v)} ${ticker} went to ${tier} via wallet transfer`,
      });
    });
    return out;
  }, [isWallets, selectedField, expandedFlow, selectedSideTile, chain, attributedDays, ticker, TIERS]);

  // Side-tile pivot: lines from the selected cause tile to every tier that
  // contributed (or from every tier to the selected sink). Skipped while a
  // tier is selected — that path is the 2-step wallet drill (attribution
  // above), not a market-wide fan that would clear the tier story.
  const sideTileLines = useMemo(() => {
    if (isWallets || !selectedSideTile || selected) return [];
    const { side, key } = selectedSideTile;
    const j = sideTileRowIndex(key);
    const label = SIDE_TILE_LABELS[side][key];
    const rows = fields
      .map((f) => ({ f, v: valueForSideTile(f.cause, side, key) }))
      .filter(({ v }) => v > 0);
    // Rank-based uniform steps: biggest volume → thickest, then evenly
    // thinner for each lower rank (ties share a width). Sqrt-ratio scaling
    // compressed mid-tier lines together; this keeps a clear ladder.
    const widths = rankedStrokeWidths(rows.map((r) => r.v));
    const color = key === "wallet" ? NEUTRAL : side === "in" ? POSITIVE : NEGATIVE;
    return rows.map(({ f, v }, i) => {
      const tierEdgeX = tileEdgeX(side === "in" ? "left" : "right");
      const tierY = rowCenterY(f.index);
      const sideX = side === "in" ? 198 : 738;
      const sideY = sideCenterY(j);
      const d = side === "in"
        ? bezierPath(sideX, sideY, tierEdgeX, tierY)
        : bezierPath(tierEdgeX, tierY, sideX, sideY);
      const tooltip = side === "in"
        ? `${fmtTel(v)} ${ticker} into ${f.label} via ${label}`
        : `${fmtTel(v)} ${ticker} from ${f.label} via ${label}`;
      return {
        key: `side-${side}-${key}-${f.label}`,
        tier: f.label,
        d,
        color,
        dashed: color === NEUTRAL,
        w: widths[i],
        label: fmtTel(v),
        labelX: (sideX + tierEdgeX) / 2,
        labelY: (sideY + tierY) / 2,
        tooltip,
      };
    });
  }, [isWallets, selectedSideTile, selected, fields, ticker, sideCenterY]);

  // The three biggest lines always carry their amount; the rest wait for hover.
  const mainLines = isWallets ? migrationLines : telLines;
  const topMainKeys = useMemo(() => topKeys(mainLines), [mainLines]);
  const topAttrKeys = useMemo(() => topKeys(attributionLines), [attributionLines]);
  const topSideKeys = useMemo(() => topKeys(sideTileLines), [sideTileLines]);

  // Counterpart tiers drawn by the wallet 2-step drill — used to keep those
  // tiles lit while the rest of the column dims.
  const walletDrillTiers = useMemo(() => {
    if (!selectedField || expandedFlow !== "wallet") return null;
    const side = selectedSideTile?.key === "wallet" ? selectedSideTile.side : null;
    const s = new Set<string>();
    if (side !== "out") {
      for (const [t, v] of Object.entries(selectedField.cause.inflowsBySourceTier)) {
        if (t !== "untracked" && v > 0) s.add(t);
      }
    }
    if (side !== "in") {
      for (const [t, v] of Object.entries(selectedField.cause.movedByDestTier)) {
        if (t !== "untracked" && v > 0) s.add(t);
      }
    }
    return s;
  }, [selectedField, expandedFlow, selectedSideTile]);

  if (loading) return <FlowSkeleton terminal={isTerminal} height={CANVAS_H} />;
  if (empty) return <FlowEmpty message={flowsEmptyText} />;
  if (errored || !ready) return <FlowError />;

  const detailNode: ReactNode = selectedField ? (
    isWallets
      ? <WalletsPanel field={selectedField} period={walletsPeriod} avail={avail} crossingsWindow={crossingsWindow} expandedFlow={expandedFlow} onToggleFlow={toggleFlow} onHoverFlow={setHoveredFlow} />
      : <TelPanel field={selectedField} period={telPeriod} windowLabel={rangeLabel} avail={avail} expandedFlow={expandedFlow} onToggleFlow={toggleFlow} onHoverFlow={setHoveredFlow} chain={chain} attributedDays={attributedDays} totalDays={totalDays} sourceTierSince={sourceTierSince} />
  ) : selectedSideTile && !isWallets ? (
    <SideTilePanel
      selection={selectedSideTile}
      fields={fields}
      hoveredTier={hoveredAttrTier}
      onHoverTier={setHoveredAttrTier}
    />
  ) : (selected || selectedSideTile) ? (
    <DetailEmpty>Nothing to show for this selection.</DetailEmpty>
  ) : null;

  const hasAnySelection = !!(selected || selectedSideTile);
  const showAsOfBadge = !(asOf.status === "fresh" && asOf.date) || hasAnySelection;
  const metricToggle = (
    <div role="group" aria-label="Measure tiers by" className="inline-flex rounded-full border border-border/60 bg-card/80 p-0.5">
      {([["wallets", "Wallets"], ["tel", ticker]] as const).map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={metric === key}
          onClick={() => onMetricChange(key)}
          className={`${isTerminal ? "h-7 px-3 text-xs" : "min-h-[44px] px-3 py-1 text-xs"} font-semibold rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${metric === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-primary"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
  const clearButton = hasAnySelection ? (
    <button
      type="button"
      onClick={clearSelection}
      className={`inline-flex items-center gap-1 rounded-full border border-border px-2.5 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isTerminal ? "h-7 text-xs" : "min-h-[44px] text-sm"}`}
      aria-label="Clear selection (Esc)"
      data-testid="flow-clear-selection"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
      Clear
    </button>
  ) : null;
  // Color legend — the same green/red/yellow meaning applies to every figure
  // in this diagram, so it's stated once. Each label opens its explainer.
  // Both modes start without it: the colours only mean something once a
  // tier's or side tile's lines are drawn.
  const legend = !hasAnySelection ? null : (
    <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-muted-foreground">
      {LEGEND.map((l) => (
        <span key={l.label} className="inline-flex items-center gap-1.5">
          <svg aria-hidden="true" width="22" height="8" viewBox="0 0 22 8" className="shrink-0">
            <line x1="1" y1="4" x2="21" y2="4" stroke={l.color} strokeWidth="3" strokeLinecap="round" strokeDasharray={l.dashed ? REDISTRIBUTION_DASH : undefined} />
          </svg>
          <ExplainNumber value={l.short} explanation={t(l.explanation)} ariaLabel={`${l.label}: what this colour means`} className="inline-flex min-h-6 items-center max-xl:relative max-xl:before:absolute max-xl:before:-inset-x-1 max-xl:before:-inset-y-2.5 max-xl:before:content-['']" />
        </span>
      ))}
    </div>
  );

  // A signed number; an exact zero reads "0"; a missing feed reads "—".
  const netText = (v: number | null, f: (n: number) => string) => netDisplay(v, f).text;
  const netTone = (v: number | null, f: (n: number) => string): Tone => netDisplay(v, f).tone;
  const toneOf = (v: number): Tone => (v === 0 ? "neutral" : v > 0 ? "positive" : "negative");
  // One slim strip in every layout. Sentences live in each stat's tooltip; the
  // tier name appears once as a chip instead of in every label.
  const grossOut = selectedField
    ? { dex: selectedField.cause.dex, cex: selectedField.cause.cex, moved: selectedField.cause.moved }
    : grossExplainer;
  const telStats: Stat[] = [
    {
      key: "net", label: `Net ${ticker}`, tone: netTone(scopedNetTel, fmtTel), value: netText(scopedNetTel, fmtTel),
      tip: netTelTip({ ticker, period: telPeriod, gross: grossOut, scope: tierLabelShort, fmt: fmtTel }),
    },
    {
      key: "demand", label: "Buy − sell", tone: retailDemand ? toneOf(retailDemand.net) : undefined,
      value: retailDemand ? signed(retailDemand.net, fmtTel) : "—",
      tip: `${rangeLabel}. ${buySellTip(retailDemand, fmtTel)}`,
    },
    {
      key: "dex", label: "DEX bought / sold",
      value: scopedDex
        ? <><span style={{ color: POSITIVE_TEXT }}>{fmtTel(scopedDex.bought)}</span>{" / "}<span style={{ color: NEGATIVE_TEXT }}>{fmtTel(scopedDex.sold)}</span></>
        : "—",
      tip: scopedDex ? `${rangeLabel}. ${dexTip(!!tierLabelShort)}` : "No DEX activity recorded yet.",
    },
  ];
  const walletCols = walletColumns(walletsPeriod, ticker);
  const selectedNetWallets = selectedField ? netOf("wallets", selectedField, avail) : null;
  const walletStats: Stat[] | null = selectedField
    ? [
        { key: "joined", label: walletCols.joined.label, tip: walletCols.joined.tip, tone: selectedField.addedCount > 0 ? "positive" : "neutral", value: selectedField.addedCount > 0 ? `+${fmtInt(selectedField.addedCount)}` : "0" },
        { key: "left", label: walletCols.left.label, tip: walletCols.left.tip, tone: selectedField.removedCount > 0 ? "negative" : "neutral", value: selectedField.removedCount > 0 ? `−${fmtInt(selectedField.removedCount)}` : "0" },
        { key: "net", label: "Net", tip: netChangeTip(walletsPeriod), tone: netTone(selectedNetWallets, fmtInt), value: netText(selectedNetWallets, fmtInt) },
      ]
    : null;
  // Wallets idle: no strip (a total across tiers is always 0).
  const statStrip = isWallets
    ? (walletStats && !isTerminal ? <StatStrip stats={walletStats} prefix={tierLabelShort} testId="tier-stat-strip" /> : null)
    : <StatStrip stats={telStats} prefix={tierLabelShort} stacked={isTerminal} testId="tier-stat-strip" />;

  // Pieces shared by the stacked layout (inline) and the terminal rail.
  const notices = (
    <>
      {complete !== true && (
        <Callout icon={null} className={`justify-center rounded-lg text-center ${isTerminal ? "shrink-0 px-2 py-1 text-xs" : "px-3 py-2 text-sm"}`}>
          On-chain classification is still backfilling for some chains — figures below may under-represent recent activity.
        </Callout>
      )}

      {flowChangelogEvents.length > 0 && (
        <div className={`rounded-lg border border-border/60 bg-muted/10 text-muted-foreground text-center inline-flex items-center justify-center gap-1.5 w-full ${isTerminal ? "shrink-0 px-2 py-0.5 text-xs" : "px-3 py-2 text-sm"}`}>
          Classification changed during this window — some figures below may blend the old and new categorization.
          <InfoTooltip
            text={`Transfers in this window were scanned before this reclassification landed, so day-buckets predating it still reflect the old categorization:\n\n${flowChangelogEvents.map((e) => `${e.date}: ${e.summary}`).join("\n\n")}`}
          />
        </div>
      )}

      {isWallets && chain !== "all" && (
        <div className={`text-center text-xs text-muted-foreground ${isTerminal ? "shrink-0" : ""}`}>
          Tier sizes are for this chain; wallet moves between tiers (the +/− ticks and lines) are tracked across all chains combined.
        </div>
      )}
    </>
  );
  const hintText =
        isPhone
          ? isWallets
            ? selected
              ? "Details for this tier are below. Tap it again to close."
              : "Tap a tier to see where its wallets came from and went."
            : selected
              ? "Buy and sell pressure for this tier is below. Tap it again for period totals."
              : "Tap a tier to scope buy and sell pressure to that tier."
          : isWallets
          ? selected
            ? `Showing where ${tierDisplayLabel(selected)} wallets came from and went. Click a line for its gross flows; Esc or Clear to reset.`
            : `${verb} a tier to see where its wallets came from and went.`
          : selectedField && expandedFlow === "wallet"
            ? (selectedSideTile?.side === "out"
              ? "Yellow lines are wallet transfers out of this tier — click To wallet again to close."
              : selectedSideTile?.side === "in"
                ? "Yellow lines are wallet transfers into this tier — click From wallet again to close."
                : "Yellow lines are wallet transfers between this tier and others.")
            : selectedField
              ? "Click a yellow To wallet / From wallet tile to trace those transfers tier-to-tier. Click the tier again for period totals."
              : "Click a tier to scope buy/sell pressure to that tier, or a side tile (Bought on DEX, From exchange, …) for every tier’s share. Click off a tier for period totals.";

  // One aria-live node: the short prompt while idle, the full text (screen
  // readers only) once something is selected.
  const liveHint = hasAnySelection ? hintText : tierPrompt(metric, ticker, verb);

  const sideTileLabel = selectedSideTile && !selectedField ? SIDE_TILE_LABELS[selectedSideTile.side][selectedSideTile.key] : null;
  const tableSheet = (
    <TierFlowTableSheet
      fields={fields}
      metric={metric}
      ticker={ticker}
      rangeLabel={rangeLabel}
      asOfDate={asOf.date ?? null}
      period={periodByMetric[metric]}
      avail={avail}
    />
  );
  // Phones keep the tile list; the rail appears only once a tier is chosen.
  const railVisible = isTerminal || !isPhone || hasAnySelection;
  const railInner = railVisible ? (
    <TierRail
      layout={isTerminal ? "terminal" : "stacked"}
      metric={metric}
      ticker={ticker}
      fields={fields}
      selectedField={selectedField}
      sideTileLabel={sideTileLabel}
      outflowsAsOf={outflowsAsOf}
      hint={isTerminal ? liveHint : undefined}
      hintHidden={hasAnySelection}
      stats={isTerminal && !isWallets ? statStrip : undefined}
      expandedFlow={expandedFlow}
      onSelectTier={selectTier}
      onToggleFlow={toggleFlow}
      onHoverFlow={setHoveredFlow}
      onClose={clearSelection}
      tableButton={tableSheet}
      period={periodByMetric}
      avail={avail}
    >
      {detailNode}
    </TierRail>
  ) : null;
  const railNode = isTerminal || !railInner ? railInner : (
    <div ref={inlineDetailRef} className="scroll-mt-48" data-testid="tier-flow-detail">{railInner}</div>
  );

  const mainContent = (
    <>
      {isTerminal && notices}
      {isTerminal ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
          {metricToggle}
          {legend}
          <div className="ml-auto flex items-center gap-2">
            {clearButton}
            <InfoTooltip text={[infoPrefix, isWallets ? INFO_WALLETS : t(INFO_TEL), INFO_RESET].filter(Boolean).join("\n\n")} label="How to read the tier flows" className={INFO_HIT_44} />
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex items-center gap-1.5">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Retail distribution by tier</h3>
              {/* A fresh as-of date lives in the tooltip; a stale feed (or an
                  open selection) shows the badge on the second line. */}
              <InfoTooltip
                text={[infoPrefix, showAsOfBadge ? null : `Flows as of ${asOf.date}.`, isWallets ? INFO_WALLETS : t(INFO_TEL), INFO_RESET].filter(Boolean).join("\n\n")}
                label="How to read the tier flows"
                className={INFO_HIT_44}
              />
            </div>
            {metricToggle}
          </div>
          {(showAsOfBadge || clearButton || legend) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {showAsOfBadge && <AsOfBadge iso={outflowsAsOf} label="Flows as of" testId="tier-outflows-asof" />}
              {clearButton}
              {legend}
            </div>
          )}
        </>
      )}

      {!isTerminal && notices}

      {/* One slim stat strip: Wallets shows it only for a selected tier (a
          total across tiers is always 0); TEL always shows it. */}
      {!isTerminal && statStrip}

      {!isTerminal && (
        <div className={hasAnySelection ? "sr-only" : `text-center ${compact ? "text-xs" : "text-sm"} text-muted-foreground`} aria-live="polite">
          {liveHint}
        </div>
      )}

      {isPhone ? (
        <>
        {isWallets && <PhoneListHeader period={walletsPeriod} ticker={ticker} />}
        <ul className="space-y-1.5" aria-label={`Retail tiers by ${isWallets ? "wallet count" : `${ticker} held`}`}>
          {[...fields].sort((a, b) => a.index - b.index).map((f) => {
            const isSelected = selected === f.label;
            const cur = isWallets ? f.row?.count ?? 0 : f.row?.totalBalance ?? 0;
            const fmt = isWallets ? fmtInt : fmtTel;
            const rowNet = netDisplay(netOf(isWallets ? "wallets" : "tel", f, avail), fmt);
            return (
              <li key={f.label}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  data-tier={f.label}
                  onClick={() => selectTier(f.label)}
                  className={`relative flex min-h-[48px] w-full items-center gap-2 overflow-hidden rounded-lg border px-3 py-2 text-left transition-colors ${isSelected ? "ring-2 ring-offset-1 ring-offset-background" : "hover:bg-muted/40"}`}
                  style={{ borderColor: isSelected ? TILE_ACCENT : "hsl(var(--border) / 0.6)", ["--tw-ring-color" as string]: TILE_ACCENT }}
                >
                  {/* Share-of-retail bar behind the row, same encoding as the
                      tile width on the desktop canvas. */}
                  <span aria-hidden="true" className="absolute inset-y-0 left-0" style={{ width: `${Math.max(2, Math.min(100, f.pct))}%`, background: isSelected ? TILE_ACCENT : TILE_SURFACE, opacity: isSelected ? 0.28 : 1 }} />
                  <span className="relative min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{tierDisplayLabel(f.label)}</span>
                    {isWallets && (f.addedCount > 0 || f.removedCount > 0) && (
                      <span className="block text-xs tabular-nums text-muted-foreground">
                        <span style={{ color: POSITIVE_TEXT }}>+{fmtInt(f.addedCount)} in</span>
                        {" · "}
                        <span style={{ color: NEGATIVE_TEXT }}>−{fmtInt(f.removedCount)} out</span>
                      </span>
                    )}
                  </span>
                  <span className="relative shrink-0 text-right">
                    <span className="block text-sm font-bold tabular-nums text-foreground">{fmt(cur)}</span>
                    <span className="block text-xs font-semibold tabular-nums" style={{ color: rowNet.tone === "neutral" ? undefined : rowNet.tone === "positive" ? POSITIVE_TEXT : NEGATIVE_TEXT }}>
                      {rowNet.text}
                    </span>
                  </span>
                  <ChevronRight className={`relative h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isSelected ? "rotate-90" : ""}`} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        </>
      ) : (
      <div className={scrollCue ? "flex items-center gap-1" : "contents"}>
      {scrollCue && (
        <button type="button" aria-label="Scroll diagram left" aria-disabled={!edges.left} onClick={() => edges.left && nudgeCanvas(-1)} className={SCROLL_BUTTON_CLASS}>
          <ChevronLeft className="h-5 w-5" aria-hidden="true" />
        </button>
      )}
      <div className={scrollCue ? "relative min-w-0 flex-1" : "contents"}>
      <div
        ref={setScrollEl}
        data-testid="tier-flow-canvas"
        data-scale={scale.toFixed(3)}
        className={isTerminal ? "relative overflow-x-auto" : "overflow-x-auto -webkit-overflow-scrolling-touch pb-1"}
      >
        <div
          className={`shrink-0 ${isTerminal && canvasW * scale <= (scrollEl?.clientWidth ?? 0) ? "mx-auto" : ""}`}
          style={{ width: canvasW * scale }}
        >
        {isWallets && (
          <WalletColumnHeaders period={walletsPeriod} ticker={ticker} anchors={columnAnchors} scale={scale} originX={originX} netMode={hasAnySelection} netAnchor={tileEdgeX("right") - WALLETS_COL_INSET_PX - 10} />
        )}
        <div
          className={`relative shrink-0 ${isWallets ? "overflow-hidden" : ""}`}
          style={{ width: canvasW * scale, height: CANVAS_H * scale }}
        >
        <div
          // Tier nodes and any arcs fade in once with the first load.
          className={`absolute left-0 top-0 ${canvasIntro ? "ha-fade-in" : ""}`}
          style={{
            width: CANVAS_W, height: CANVAS_H, transform: `scale(${scale})`, transformOrigin: "top left", left: -originX * scale,
            ["--tier-hit-pad" as string]: `${hitPad(scale, TIER_H, (PITCH - TIER_H) / 2)}px`,
            ["--tick-hit-pad" as string]: `${hitPad(scale, 40, 8)}px`,
          }}
        >
          {/* The svg itself stays pointer-events:none so it never intercepts
              tile clicks; only the individual flow groups opt back in. Lines
              are a MOUSE convenience for expanding/previewing a flow — they
              are deliberately not tab stops (the canvas holds no focusable
              SVG, by design). The equivalent keyboard/screen-reader path is
              the real <button> rows in the panel below, which drive the same
              expand state (and, via focus, the same hover-preview dim). */}
          <svg width={CANVAS_W} height={CANVAS_H} className="absolute inset-0 pointer-events-none" style={{ zIndex: 0 }}>
            {selectedField && (isWallets ? migrationLines : telLines).map((l) => {
              const dimmed = hoveredFlow != null && hoveredFlow !== l.flowKey;
              // Amount sits on the path once clicked (expanded) or while
              // hovered — not always-on, so the canvas stays readable when
              // many lines are drawn.
              const showAmount = expandedFlow === l.flowKey || hoveredFlow === l.flowKey || topMainKeys.has(l.key);
              return (
                <Tooltip key={l.key} delayDuration={150}>
                  <TooltipTrigger asChild>
                    <g
                      className="pointer-events-auto cursor-pointer transition-opacity duration-150"
                      style={{ opacity: dimmed ? 0.15 : 1 }}
                      onClick={() => toggleFlow(l.flowKey)}
                      onMouseEnter={() => setHoveredFlow(l.flowKey)}
                      onMouseLeave={() => setHoveredFlow((prev) => (prev === l.flowKey ? null : prev))}
                      aria-hidden="true"
                    >
                      {/* Invisible fat stroke: a 1-9px line is a hard click
                          target, so this widens the hit area (and the hover
                          area for the preview bubble) without changing the
                          visual. */}
                      <path d={l.d} fill="none" stroke="transparent" strokeWidth={Math.max(16, l.w + 12)} strokeLinecap="round" />
                      <FlowPath d={l.d} color={l.color} width={l.w} dashed={l.dashed} />
                      {showAmount && (
                        <FlowAmountLabel x={l.labelX} y={l.labelY} color={l.color} label={l.label} />
                      )}
                    </g>
                  </TooltipTrigger>
                  <TooltipContent className="text-sm">{l.tooltip}</TooltipContent>
                </Tooltip>
              );
            })}
            {/* Level 3: the "Other wallets" category's own per-tier lines,
                drawn on top once it's expanded — same hover bubble + dim
                pattern, keyed by tier instead of by category. */}
            {attributionLines.map((l) => {
              const dimmed = hoveredAttrTier != null && hoveredAttrTier !== l.tier;
              const showAmount = hoveredAttrTier === l.tier || expandedFlow === "wallet" || topAttrKeys.has(l.key);
              return (
                <Tooltip key={l.key} delayDuration={150}>
                  <TooltipTrigger asChild>
                    <g
                      className="pointer-events-auto cursor-pointer transition-opacity duration-150"
                      style={{ opacity: dimmed ? 0.15 : 1 }}
                      onMouseEnter={() => setHoveredAttrTier(l.tier)}
                      onMouseLeave={() => setHoveredAttrTier((prev) => (prev === l.tier ? null : prev))}
                      aria-hidden="true"
                    >
                      <path d={l.d} fill="none" stroke="transparent" strokeWidth={Math.max(16, l.w + 12)} strokeLinecap="round" />
                      <FlowPath d={l.d} color={l.color} width={l.w} dashed={l.dashed} />
                      {showAmount && (
                        <FlowAmountLabel x={l.labelX} y={l.labelY} color={l.color} label={l.label} />
                      )}
                    </g>
                  </TooltipTrigger>
                  <TooltipContent className="text-sm">{l.tooltip}</TooltipContent>
                </Tooltip>
              );
            })}
            {/* Side-tile pivot lines: one bezier per tier that contributed to
                the selected cause. Hover-dim shares hoveredAttrTier with the
                contribution panel rows below. */}
            {sideTileLines.map((l) => {
              const dimmed = hoveredAttrTier != null && hoveredAttrTier !== l.tier;
              const showAmount = hoveredAttrTier === l.tier || topSideKeys.has(l.key);
              return (
                <Tooltip key={l.key} delayDuration={150}>
                  <TooltipTrigger asChild>
                    <g
                      className="pointer-events-auto cursor-pointer transition-opacity duration-150"
                      style={{ opacity: dimmed ? 0.15 : 1 }}
                      onMouseEnter={() => setHoveredAttrTier(l.tier)}
                      onMouseLeave={() => setHoveredAttrTier((prev) => (prev === l.tier ? null : prev))}
                      aria-hidden="true"
                    >
                      <path d={l.d} fill="none" stroke="transparent" strokeWidth={Math.max(16, l.w + 12)} strokeLinecap="round" />
                      <FlowPath d={l.d} color={l.color} width={l.w} dashed={l.dashed} />
                      {showAmount && (
                        <FlowAmountLabel x={l.labelX} y={l.labelY} color={l.color} label={l.label} />
                      )}
                    </g>
                  </TooltipTrigger>
                  <TooltipContent className="text-sm">{l.tooltip}</TooltipContent>
                </Tooltip>
              );
            })}
          </svg>

          {/* Source/sink tiles are a TEL concept (DEX/exchange/wallet origin
              of TEL) — not rendered at all in Wallets mode, where nothing on
              the canvas would ever connect to them. */}
          {!isWallets && <div role="group" aria-label={`Where retail ${ticker} came from`} className="contents">{SIDE_LABELS_IN.map((s, j) => {
            const aggregate = selectedField
              ? valueForSideTile(selectedField.cause, "in", s.key)
              : fields.reduce((sum, f) => sum + valueForSideTile(f.cause, "in", s.key), 0);
            const isSideSelected = selectedSideTile?.side === "in" && selectedSideTile.key === s.key;
            // While a side tile is the pivot, dim the other side tiles (and
            // keep this one fully opaque). When a tier is selected, keep the
            // prior dimming rules for hovered cause / attribution lines.
            const dimmedBySide = selectedSideTile != null && !isSideSelected;
            const dimmedByTierHover = selected != null && (
              (hoveredFlow != null && hoveredFlow !== s.key)
              || (hoveredAttrTier != null && s.key !== "wallet")
            );
            const dimmed = dimmedBySide || dimmedByTierHover;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => selectSideTile({ side: "in", key: s.key })}
                aria-pressed={isSideSelected}
                aria-label={`${s.label}: ${aggregate > 0 ? `${fmtTel(aggregate)} ${ticker}` : "none"}${selectedField ? ` into ${tierDisplayLabel(selectedField.label)}` : ""}`}
                className={`absolute rounded-xl border px-2 py-1.5 flex flex-col justify-center text-left transition-opacity duration-150 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${dimmed ? "opacity-30" : "opacity-100"} ${isSideSelected ? "ring-2 ring-offset-1 ring-offset-background" : ""}`}
                style={{
                  left: 8, top: sideTop(j), width: 190, height: SIDE_H,
                  borderColor: s.color,
                  background: isSideSelected ? tintFill(s.color, 0.18) : tintFill(s.color, 0.08),
                  ["--tw-ring-color" as string]: s.color,
                }}
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold truncate">{s.label}</div>
                <div className="text-sm font-bold tabular-nums" style={{ color: s.color }}>{aggregate > 0 ? fmtTel(aggregate) : "—"}</div>
              </button>
            );
          })}</div>}
          {!isWallets && <div role="group" aria-label={`Where retail ${ticker} went`} className="contents">{SIDE_LABELS_OUT.map((s, j) => {
            const outKey: SideTileKey = s.key;
            const aggregate = selectedField
              ? valueForSideTile(selectedField.cause, "out", outKey)
              : fields.reduce((sum, f) => sum + valueForSideTile(f.cause, "out", outKey), 0);
            const isSideSelected = selectedSideTile?.side === "out" && selectedSideTile.key === outKey;
            const dimmedBySide = selectedSideTile != null && !isSideSelected;
            const dimmedByTierHover = selected != null && (
              (hoveredFlow != null && hoveredFlow !== s.key)
              || (hoveredAttrTier != null && s.key !== "wallet")
            );
            const dimmed = dimmedBySide || dimmedByTierHover;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => selectSideTile({ side: "out", key: outKey })}
                aria-pressed={isSideSelected}
                aria-label={`${s.label}: ${aggregate > 0 ? `${fmtTel(aggregate)} ${ticker}` : "none"}${selectedField ? ` from ${tierDisplayLabel(selectedField.label)}` : ""}`}
                className={`absolute rounded-xl border px-2 py-1.5 flex flex-col justify-center text-left transition-opacity duration-150 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${dimmed ? "opacity-30" : "opacity-100"} ${isSideSelected ? "ring-2 ring-offset-1 ring-offset-background" : ""}`}
                style={{
                  left: 738, top: sideTop(j), width: 190, height: SIDE_H,
                  borderColor: s.color,
                  background: isSideSelected ? tintFill(s.color, 0.18) : tintFill(s.color, 0.08),
                  ["--tw-ring-color" as string]: s.color,
                }}
              >
                <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold truncate">{s.label}</div>
                <div className="text-sm font-bold tabular-nums" style={{ color: s.color }}>{aggregate > 0 ? fmtTel(aggregate) : "—"}</div>
              </button>
            );
          })}</div>}

          {/* Tier tiles: all one width (TIER_TILE_W), centred on
              TIER_COL_CENTER_X, so edges, labels, counts and the +N / -N
              ticks line up in straight columns. Size is the bar inside. */}
          <div role="group" aria-label={`Balance tiers, by ${isWallets ? "wallet count" : `${ticker} held`}`} className="contents">
          {fields.map((f) => {
            const isSelected = selected === f.label;
            // While hovering a flow line, the tile at its OTHER end highlights
            // along with the line itself — the rest dim. Two independent
            // sources feed this: Wallets-mode hoveredFlow (a counterpart tier
            // label) and TEL-mode hoveredAttrTier (a tier label from the
            // expanded "Other wallets" attribution OR a side-tile pivot line)
            // — never both at once, since one only exists per mode.
            const isHoveredCounterpart = !isSelected && ((isWallets && hoveredFlow === f.label) || (!isWallets && hoveredAttrTier === f.label));
            const anyHoverActive = isWallets ? hoveredFlow != null : hoveredAttrTier != null;
            const dimmedByHover = anyHoverActive && !isSelected && !isHoveredCounterpart;
            // When a side tile is pivoted, dim tiers that aren't contributing
            // (no line drawn) unless they're the hovered counterpart.
            const contributesToSide = selectedSideTile != null
              && valueForSideTile(f.cause, selectedSideTile.side, selectedSideTile.key) > 0;
            // Market-wide side pivot dims non-contributors; wallet 2-step drill
            // dims every tier that isn't the selected one or an attributed hop.
            const dimmedBySidePivot = selectedSideTile != null && !selected && !contributesToSide && !isHoveredCounterpart;
            const dimmedByWalletDrill = walletDrillTiers != null && !isSelected && !walletDrillTiers.has(f.label) && !isHoveredCounterpart;
            const cur = isWallets ? f.row?.count ?? 0 : f.row?.totalBalance ?? 0;
            const barFraction = tierBarFraction((f.pct / maxPct) * 100);
            const netSlot = netSlotText(isWallets ? "wallets" : "tel", f, avail);
            return (
              // A wrapping div (not the button itself) is the positioned
              // element — the up/down tick markers need their own clickable
              // <button> for ExplainNumber's popover, and a <button> can't
              // validly contain another <button>. The tile's own click
              // surface is the inner <button> below; the ticks sit beside it
              // as siblings so both are independently interactive.
              <div key={f.label} className="absolute" style={{ left: tileEdgeX("left"), top: rowTop(f.index), width: TIER_TILE_W, height: TIER_H }}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={hasAnySelection ? `${tierDisplayLabel(f.label)}: ${isWallets ? `${fmtInt(cur)} wallets` : `${fmtTel(cur)} ${ticker}`}, net ${netSlot.text} ${isWallets ? "wallets" : ticker}` : undefined}
                  data-tier={f.label}
                  onClick={() => selectTier(f.label)}
                  // transition-all so metric/chain changes animate the recolor
                  // smoothly. hover/active scale is a transform (compositor-only).
                  className={`group absolute inset-0 max-xl:before:absolute max-xl:before:-inset-y-[var(--tier-hit-pad)] max-xl:before:inset-x-0 max-xl:before:content-[''] rounded-lg border text-left transition-all duration-300 ease-out hover:scale-[1.02] active:scale-[0.99] ${
                    isSelected ? "scale-[1.015] ring-2 ring-offset-1 ring-offset-background"
                    : isHoveredCounterpart ? "ring-1"
                    : (dimmedByHover || dimmedBySidePivot || dimmedByWalletDrill) ? "opacity-30"
                    : selected || selectedSideTile ? "opacity-70 hover:opacity-100"
                    : "hover:shadow-md"
                  }`}
                  style={{
                    borderColor: isSelected || isHoveredCounterpart
                      ? TILE_ACCENT
                      : (dimmedByHover || dimmedBySidePivot || dimmedByWalletDrill)
                        ? "hsl(var(--border) / 0.3)"
                        : "hsl(var(--border) / 0.6)",
                    background: "hsl(var(--card))",
                    ["--tw-ring-color" as string]: TILE_ACCENT,
                  }}
                >
                  <div className="h-full w-full relative overflow-hidden rounded-lg">
                    <div
                      className="absolute inset-0 rounded-lg transition-colors duration-300"
                      style={isSelected ? { background: TILE_ACCENT, opacity: 0.28 } : { background: TILE_SURFACE }}
                    />
                    {/* Label pinned left; total + signed net pinned right,
                        with a real gap (ml-2) before the chevron so the
                        number doesn't read as "attached to the chevron" the
                        way flush-right-with-no-gap did before. Abandoned
                        absolute-centering the value in the tile: on narrow
                        tiles a truncated label plus a pill-boxed centered
                        value read as two disconnected chips glued together,
                        not one clean row — plain flex with real spacing beats
                        fighting the layout to force a literal center point.
                        The net slot below is fixed-width and shown only while
                        a selection exists, so counts still share one right
                        edge. Net also lives in the rail, ranked list, header
                        strip and table sheet. */}
                    <div className="relative h-full flex items-center px-2.5 pb-1.5 gap-1.5 sm:gap-2 min-w-0">
                      <span className="text-[13px] sm:text-sm font-semibold truncate shrink min-w-0" title={tierDisplayLabel(f.label)}>{tierDisplayLabel(f.label)}</span>
                      <span className="ml-auto shrink-0 text-right text-sm font-bold tabular-nums whitespace-nowrap">{isWallets ? fmtInt(cur) : fmtTel(cur)}</span>
                      {/* Net slot: reserved only while something is selected,
                          same width in every tile so counts share one right
                          edge. Fades in with the ticks fading out. */}
                      <span
                        aria-hidden="true"
                        data-testid="tier-net"
                        className={`${TICK_FADE} ${hasAnySelection ? "opacity-100 visible" : "opacity-0 invisible w-0 overflow-hidden -ml-1.5 sm:-ml-2"} shrink-0 text-right text-xs sm:text-[13px] font-semibold tabular-nums whitespace-nowrap`}
                        style={{ ...(hasAnySelection ? { width: NET_SLOT_W_PX } : null), color: netSlot.tone === "neutral" ? "hsl(var(--muted-foreground))" : netSlot.tone === "positive" ? POSITIVE_TEXT : NEGATIVE_TEXT }}
                      >{netSlot.text}</span>
                      {/* Persistent, low-opacity "this opens something"
                          affordance — visible before any tile is ever
                          clicked, not just discoverable by accident hover. */}
                      <ChevronRight
                        className={`hidden sm:block h-3.5 w-3.5 shrink-0 ml-1 transition-opacity ${isSelected ? "opacity-0" : "opacity-40 group-hover:opacity-90"}`}
                        aria-hidden="true"
                      />
                    </div>
                    {/* Size bar: decorative (the printed count is the accessible
                        value). Length = the log-scaled share of the largest tier. */}
                    <div aria-hidden="true" className="absolute inset-x-2.5 bottom-1.5 h-1 rounded-full" style={{ background: "hsl(var(--foreground) / 0.12)" }}>
                      <div className="h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${barFraction * 100}%`, background: "hsl(var(--foreground) / 0.6)" }} />
                    </div>
                  </div>
                </button>
                {/* Gross in/out ticks — a wallets concept, shown only in
                    Wallets mode so TEL mode doesn't mix in a number from a
                    different story. LEFT (outside the bar) = wallets that
                    LEFT this tier for another one this period; RIGHT
                    (outside the bar) = wallets that ARRIVED into this tier
                    from another one. Always red for outflow, always green
                    for inflow — sign, not a verdict, decides the color, same
                    convention as the total/net figure inside the bar. These
                    are gross migration counts (any counterpart tier), not
                    the net (joined - left) shown in the tile's net slot while
                    a tier is selected. */}
                {/* Side convention: ADDED on the left, REMOVED on the right —
                    matching where the migration arcs actually terminate when a
                    tile is expanded (`side: m.gained ? "left" : "right"`).
                    Previously the ticks were the other way round, so a green
                    "+12 added" tick sat on the right while every green inbound
                    arc landed on the left. */}
                {/* 40px canvas hit area (≥24px rendered down to a 0.6
                    canvas scale — the smallest stacked/tablet and terminal
                    scales) and a name that says what the number counts.
                    Absolutely positioned, so the larger box never shifts
                    the tile layout. */}
                {isWallets && f.addedCount > 0 && (
                  <span aria-hidden={hasAnySelection ? true : undefined} className={`absolute right-full top-1/2 -mt-[3px] -translate-y-1/2 text-right text-sm font-bold tabular-nums ${TICK_FADE} ${hasAnySelection ? "opacity-0 invisible pointer-events-none" : "opacity-100 visible"}`} style={{ color: POSITIVE_TEXT, marginRight: TICK_GAP_PX, textShadow: TICK_HALO }}>
                    <ExplainNumber
                      value={`+${fmtInt(f.addedCount)}`}
                      explanation={t(addedTickExplanation(f))}
                      ariaLabel={`+${fmtInt(f.addedCount)} wallet${f.addedCount === 1 ? "" : "s"} arrived into ${tierDisplayLabel(f.label)}. Explain`}
                      className="inline-flex min-h-[40px] min-w-[40px] items-center justify-end px-1 max-xl:relative max-xl:before:absolute max-xl:before:-inset-x-[var(--tick-hit-pad)] max-xl:before:-inset-y-[var(--tick-hit-pad)] max-xl:before:content-['']"
                    />
                  </span>
                )}
                {isWallets && f.removedCount > 0 && (
                  <span aria-hidden={hasAnySelection ? true : undefined} className={`absolute left-full top-1/2 -mt-[3px] -translate-y-1/2 text-left text-sm font-bold tabular-nums ${TICK_FADE} ${hasAnySelection ? "opacity-0 invisible pointer-events-none" : "opacity-100 visible"}`} style={{ color: NEGATIVE_TEXT, marginLeft: TICK_GAP_PX, textShadow: TICK_HALO }}>
                    <ExplainNumber
                      value={`−${fmtInt(f.removedCount)}`}
                      explanation={t(removedTickExplanation(f))}
                      ariaLabel={`${fmtInt(f.removedCount)} wallet${f.removedCount === 1 ? "" : "s"} left ${tierDisplayLabel(f.label)}. Explain`}
                      className="inline-flex min-h-[40px] min-w-[40px] items-center justify-start px-1 max-xl:relative max-xl:before:absolute max-xl:before:-inset-x-[var(--tick-hit-pad)] max-xl:before:-inset-y-[var(--tick-hit-pad)] max-xl:before:content-['']"
                    />
                  </span>
                )}
              </div>
            );
          })}
          </div>
        </div>
        </div>
        </div>
      </div>
      {scrollCue && edges.left && (
        <div aria-hidden="true" data-testid="tier-flow-fade-left" className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-card to-transparent" />
      )}
      {scrollCue && edges.right && (
        <div aria-hidden="true" data-testid="tier-flow-fade-right" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-card to-transparent" />
      )}
      </div>
      {scrollCue && (
        <button type="button" aria-label="Scroll diagram right" aria-disabled={!edges.right} onClick={() => edges.right && nudgeCanvas(1)} className={SCROLL_BUTTON_CLASS}>
          <ChevronRight className="h-5 w-5" aria-hidden="true" />
        </button>
      )}
      </div>
      )}

      {!isTerminal && railNode}
    </>
  );

  return (
    <div
      className={isTerminal ? "grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px] min-[1440px]:grid-cols-[minmax(0,1fr)_400px]" : "space-y-3"}
      data-testid="tier-flow"
    >
      {isTerminal ? <div className="flex min-w-0 flex-col gap-2">{mainContent}</div> : mainContent}
      {isTerminal && railNode}
      {/* Plain list, not a <table> — a table's auto-layout sizing algorithm
          can ignore sr-only's width:1px and expand to its content's intrinsic
          width regardless, which (being position:absolute) doesn't reflow
          the page but DOES widen the nearest scrollable ancestor's scrollable
          area, causing the page body itself to gain a horizontal scrollbar.
          A plain list has no such intrinsic-sizing override and clips cleanly. */}
      <ul className="sr-only">
        <li>Retail distribution by balance tier, {rangeLabel}</li>
        {fields.map((f) => (
          <li key={f.label}>
            {tierDisplayLabel(f.label)}: {fmtInt(f.row?.count ?? 0)} holders, {fmtTel(f.row?.totalBalance ?? 0)} {ticker}.{" "}
            Net wallets: {netDisplay(netOf("wallets", f, avail), fmtInt).text}.{" "}
            Net {ticker}: {netDisplay(netOf("tel", f, avail), fmtTel).text}.
          </li>
        ))}
      </ul>
    </div>
  );
};

// Amount badge drawn on a flow path when that path is hovered or clicked
// open. Halo stroke keeps the figure readable over the line color itself.
const FlowAmountLabel = ({ x, y, color, label }: { x: number; y: number; color: string; label: string }) => (
  <text
    x={x}
    y={y}
    fill={color === POSITIVE ? POSITIVE_TEXT : color === NEGATIVE ? NEGATIVE_TEXT : "hsl(var(--foreground))"}
    textAnchor="middle"
    dominantBaseline="middle"
    fontSize={14}
    fontWeight={700}
    style={{ paintOrder: "stroke", stroke: "hsl(var(--background))", strokeWidth: 4, pointerEvents: "none" }}
  >
    {label}
  </text>
);

// A flow line plus a pulsing dot traveling along it, in the direction `d`
// is drawn (source first, destination last) — the direction indicator the
// original right-gutter connectors had, brought back for every line type
// (migration, came, went) rather than just the one design had it for.
// index.css already has a global `prefers-reduced-motion` rule, but it only
// zeroes CSS animation/transition durations — SMIL's <animateMotion> isn't a
// CSS animation, so that rule doesn't reach it. Checked directly here instead.
const FlowPath = ({ d, color, width, dashed = false }: { d: string; color: string; width: number; dashed?: boolean }) => {
  const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // Dashed (redistribution) lines must not use flow-line-draw: it forces its own
  // dash pattern. They fade in instead, and stay a touch heavier and more opaque
  // so the gaps don't thin them out.
  return (
    <>
      {dashed ? (
        <path d={d} fill="none" stroke={color} strokeOpacity={0.85} strokeWidth={Math.max(2.5, width)} strokeLinecap="butt" strokeDasharray={REDISTRIBUTION_DASH} className="flow-line-dashed" />
      ) : (
        <path d={d} fill="none" stroke={color} strokeOpacity={0.55} strokeWidth={width} strokeLinecap="round" className="flow-line-draw" />
      )}
      {!reducedMotion && (
        <circle r={Math.max(2, width / 2)} fill={color}>
          <animateMotion dur="1.6s" repeatCount="indefinite" path={d} />
        </circle>
      )}
    </>
  );
};


const FlowSkeleton = ({ terminal = false, height = DEFAULT_CANVAS_H }: { terminal?: boolean; height?: number }) => (
  <div role="status" aria-label="Loading tier flows" className={terminal ? "flex flex-col gap-2" : "space-y-3"}>
    <div className="h-4 w-40 rounded bg-muted/40 animate-pulse" />
    <div
      className="mx-auto animate-pulse rounded-xl border border-border/50 bg-muted/20"
      style={terminal ? { width: "100%", height: Math.round(height * 0.92) } : { width: CANVAS_W, maxWidth: "100%", height }}
    />
  </div>
);

const DetailEmpty = ({ children }: { children: ReactNode }) => (
  <div
    className="flex h-full min-h-[8rem] items-center justify-center p-4 text-center text-sm text-muted-foreground"
    data-testid="tier-detail-empty"
  >
    {children}
  </div>
);

const FlowEmpty = ({ message }: { message: string }) => (
  <div
    className="flex min-h-[12rem] items-center justify-center rounded-xl border border-border/50 bg-muted/10 p-8 text-center text-sm text-muted-foreground"
    data-testid="tier-flows-empty"
  >
    {message}
  </div>
);

const FlowError = () => {
  const qc = useQueryClient();
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-border/50 bg-muted/10 p-8 text-center text-sm text-muted-foreground">
      Couldn&apos;t load the distribution data.
      <button
        type="button"
        onClick={() => void qc.refetchQueries({ predicate: (q) => q.state.status === "error" })}
        className="inline-flex min-h-11 xl:min-h-[36px] items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        Retry
      </button>
    </div>
  );
};

// Side-tile pivot panel: lists every tier's contribution to the selected
// cause (Bought on DEX, From exchange, …), sorted by amount. Hover syncs
// with the canvas lines via hoveredAttrTier.
const SideTilePanel = ({
  selection, fields, hoveredTier, onHoverTier,
}: {
  selection: SideTileSelection;
  fields: TierField[];
  hoveredTier: string | null;
  onHoverTier: (tier: string | null) => void;
}) => {
  const { ticker } = useProjectCopy();
  const label = SIDE_TILE_LABELS[selection.side][selection.key];
  const color = selection.key === "wallet" ? NEUTRAL : selection.side === "in" ? POSITIVE : NEGATIVE;
  const rows = sideTileContributions(fields, selection.side, selection.key);
  const total = rows.reduce((s, r) => s + r.value, 0);

  return (
    <div className="mx-auto max-w-lg space-y-3 premium-surface-card p-4 animate-scale-in">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-bold text-foreground">{label}</span>
        <span className="text-sm font-semibold tabular-nums" style={{ color }}>
          {total > 0 ? fmtTel(total) : "—"} {ticker}
        </span>
      </div>
      <p className="text-center text-sm text-muted-foreground leading-relaxed">
        {selection.side === "in"
          ? `How much of this inflow each retail tier received over the selected period.`
          : `How much of this outflow each retail tier sent over the selected period.`}
      </p>
      {rows.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-2">No activity in this category for the selected window.</div>
      ) : (
        <ul className="space-y-0.5 pt-1 border-t border-border/40 text-sm">
          {rows.map((r) => {
            const active = hoveredTier === r.label;
            return (
              <li key={r.label}>
                {/* Focusable so the line highlight is reachable by keyboard, not hover only. */}
                <div
                  role="group"
                  tabIndex={0}
                  aria-label={`${tierDisplayLabel(r.label)}: ${fmtTel(r.value)} ${ticker}, ${Math.round(r.share * 100)}%`}
                  onMouseEnter={() => onHoverTier(r.label)}
                  onMouseLeave={() => onHoverTier(null)}
                  onFocus={() => onHoverTier(r.label)}
                  onBlur={() => onHoverTier(null)}
                  className={`w-full rounded-md px-2 py-1.5 flex items-center gap-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "bg-muted/50" : "hover:bg-muted/40"}`}
                >
                  <span className="text-muted-foreground w-24 shrink-0 truncate">{tierDisplayLabel(r.label)}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted/60 overflow-hidden min-w-0">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(2, r.share * 100)}%`, background: color }} />
                  </div>
                  <span className="font-semibold tabular-nums shrink-0 w-20 text-right" style={{ color }}>
                    {fmtTel(r.value)}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0 w-10 text-right">
                    {Math.round(r.share * 100)}%
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

// WALLETS mode panel: the whole story is "which tiers did wallets come from
// and go to" — a net headline, one plain sentence, then the exact crossing
// list. No TEL cause-breakdown here; that's a different question, answered
// in TelPanel instead. Keeping the two panels fully separate (rather than
// one panel with conditional sections) is deliberate — it's the fix for
// "there's a lot to wrap your head around" being about two unrelated
// stories showing at once regardless of which the toggle was asking for.
const utcDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const fmtDay = (ymd: string) => {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(t) ? ymd : utcDay.format(t);
};

const WalletsPanel = ({ field, period, avail, crossingsWindow = null, expandedFlow, onToggleFlow, onHoverFlow }: { field: TierField; period: string; avail: FlowAvailability; crossingsWindow?: { from: string; to: string } | null; expandedFlow: string | null; onToggleFlow: (key: string) => void; onHoverFlow: (key: string | null) => void }) => {
  const windowLabel = crossingsWindow ? `${fmtDay(crossingsWindow.from)} → ${fmtDay(crossingsWindow.to)}` : null;
  const { row } = field;
  const netWallets = netOf("wallets", field, avail);
  const netShown = netDisplay(netWallets, fmtInt);
  const gained = field.migrations.filter((m) => m.gained);
  const lost = field.migrations.filter((m) => !m.gained);
  const gainedUp = gained.filter((m) => m.up).reduce((s, m) => s + m.count, 0);
  const gainedDown = gained.filter((m) => !m.up).reduce((s, m) => s + m.count, 0);
  const lostUp = lost.filter((m) => m.up).reduce((s, m) => s + m.count, 0);
  const lostDown = lost.filter((m) => !m.up).reduce((s, m) => s + m.count, 0);
  const nets = netMigrationsFor(field.migrations);
  const { t } = useProjectCopy();
  const rawNarrative = walletNarrativeFor(
    field.label,
    { gainedUp, gainedDown, lostUp, lostDown },
    field.verdict,
    field.cause,
    windowLabel,
  );
  // Cause clauses carry {ticker} placeholders (see shrinkCauseClause).
  const narrative = rawNarrative ? t(rawNarrative) : rawNarrative;

  return (
    <div className="mx-auto max-w-lg space-y-3 premium-surface-card p-4 animate-scale-in">
      <div className="flex items-baseline justify-between">
        <span className="font-bold text-foreground">{tierDisplayLabel(field.label)}</span>
        <span className="text-xs text-muted-foreground">{row ? `${fmtInt(row.count)} holders` : "—"}</span>
      </div>

      <div className="text-center text-sm text-muted-foreground">
        Net ({windowLabel ?? "selected period"}):{" "}
        <span className={`font-semibold ${NET_TONE_CLASS[netShown.tone]}`}>
          <ExplainNumber
            value={netWallets === null ? netShown.text : `${netShown.text} wallets`}
            explanation={`${netChangeTip(period)} ${fmtInt(field.addedCount)} joined, ${fmtInt(field.removedCount)} left ${field.label}.`}
            className="inline-flex min-h-6 items-center max-xl:relative max-xl:before:absolute max-xl:before:-inset-x-1 max-xl:before:-inset-y-3 max-xl:before:content-['']"
          />
        </span>
      </div>

      {narrative && <p className="text-center text-sm text-muted-foreground leading-relaxed">{narrative}</p>}

      {/* One row per counterpart tier showing the NET movement, biggest first.
          Each row is a real button: it expands in place to the two gross
          numbers behind that net, and drives the same canvas expansion the
          lines do — so this is also the keyboard path for a feature the SVG
          lines only offer to a mouse. */}
      {nets.length > 0 && (
        <div className="pt-1 border-t border-border/40 text-sm">
          <div className="text-center text-muted-foreground font-semibold uppercase tracking-wide text-xs mb-1">
            Net movement by tier
            {windowLabel && (
              <span className="ml-1 font-normal normal-case tracking-normal" data-testid="crossings-window">
                · {windowLabel}
              </span>
            )}
          </div>
          <ul className="space-y-0.5">
            {nets.map((n) => {
              const isOpen = expandedFlow === n.counterpart;
              // Colour must follow the SIGN of the number actually printed
              // below (`signed(n.net)`). `n.up` is the dominant side's
              // direction, which is independent of that sign — so a net of −8
              // whose dominant side happened to be "grew out" rendered as a
              // green "−8", and a positive net could render red.
              // Readable text tokens, not the chart fills (yellow fails contrast
              // as light-mode text), plus a word so colour is not the only cue.
              const tone = n.net === 0 ? undefined : n.net > 0 ? POSITIVE_TEXT : NEGATIVE_TEXT;
              return (
                <li key={n.counterpart}>
                  <button
                    type="button"
                    onClick={() => onToggleFlow(n.counterpart)}
                    onMouseEnter={() => onHoverFlow(n.counterpart)}
                    onMouseLeave={() => onHoverFlow(null)}
                    onFocus={() => onHoverFlow(n.counterpart)}
                    onBlur={() => onHoverFlow(null)}
                    aria-expanded={isOpen}
                    data-flow-row={n.counterpart}
                    className="w-full rounded-md px-2 py-1 max-xl:min-h-11 flex items-center justify-between gap-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="text-muted-foreground">{tierDisplayLabel(n.counterpart)}</span>
                    <span className="font-semibold tabular-nums" style={{ color: tone }}>
                      {n.net === 0 ? <span className="text-muted-foreground">no net change</span> : `${signed(n.net, fmtInt)} ${n.net > 0 ? "arrived" : "left"}`}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-2 pb-1 text-xs text-muted-foreground leading-relaxed">
                      <span className="tabular-nums font-semibold" style={{ color: POSITIVE_TEXT }}>+{fmtInt(n.gained)}</span> arrived from {n.counterpart}
                      {" · "}
                      <span className="tabular-nums font-semibold" style={{ color: NEGATIVE_TEXT }}>−{fmtInt(n.lost)}</span> left for {n.counterpart}
                      <div className="mt-0.5">
                        {n.net === 0
                          ? `Equal in both directions — wallets crossed this boundary, but ${field.label} ended the period no different for it.`
                          : n.net > 0
                            ? `Net ${signed(n.net, fmtInt)} into ${field.label}${n.up ? " — the wallets behind it grew up from a smaller tier." : " — the wallets behind it dropped in from a larger tier."}`
                            : `Net ${signed(n.net, fmtInt)} out of ${field.label}${n.up ? " — the wallets behind it grew up into a larger tier." : " — the wallets behind it shrank down into a smaller tier."}`}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {/* The list is exactly where someone starts adding numbers up, so
              say plainly why they don't reach the headline figure. */}
        </div>
      )}

      {nets.length === 0 && !narrative && (
        <p className="text-sm text-muted-foreground" data-testid="tier-detail-empty">
          No wallet moves into or out of this tier in this period.
        </p>
      )}
    </div>
  );
};

// TEL mode panel: the whole story is "where did the TEL come from / go to
// on-chain" — a net headline, the cause breakdown bars-as-text, and a plain
// narrative sentence. No wallet-migration list here — see WalletsPanel.
// Renders the counterparty-tier breakdown for wallet-to-wallet TEL, or the
// honest "not yet"/"not under this chain filter" states in its place. The
// two maps (inflowsBySourceTier, movedByDestTier) are sparse and always sum
// exactly to receivedWallet/moved respectively — `untracked` is the
// explicit, never-hidden remainder (no tier on the counterparty, or a day
// that predates this feature).
const TierAttributionBreakdown = ({
  inflowsBySourceTier, movedByDestTier, receivedWallet, moved, chain, attributedDays, totalDays, sourceTierSince,
}: {
  inflowsBySourceTier: Record<string, number>;
  movedByDestTier: Record<string, number>;
  receivedWallet: number;
  moved: number;
  chain: ChainKey;
  attributedDays: number;
  totalDays: number;
  sourceTierSince: string | null;
}) => {
  const { ticker } = useProjectCopy();
  const renderList = (map: Record<string, number>, total: number) => {
    const entries = Object.entries(map)
      .filter(([, v]) => v !== 0)
      .sort(([, a], [, b]) => b - a);
    const untracked = map.untracked ?? Math.max(0, total - entries.filter(([k]) => k !== "untracked").reduce((s, [, v]) => s + v, 0));
    return (
      <ul className="mt-0.5 space-y-0.5">
        {entries.filter(([k]) => k !== "untracked").map(([tier, v]) => (
          <li key={tier} className="flex items-center justify-between gap-2 tabular-nums">
            <span>{tier}</span>
            <span>{fmtTel(v)} {ticker}</span>
          </li>
        ))}
        <li className="flex items-center justify-between gap-2 tabular-nums text-muted-foreground">
          <span>Untracked (no tier on counterparty)</span>
          <span>{fmtTel(untracked)} {ticker}</span>
        </li>
      </ul>
    );
  };

  if (chain !== "all") {
    return (
      <span className="opacity-80">
        Counterparty-tier attribution isn't available under a specific chain filter — switch to "All chains" to see which tiers this {ticker} came from or went to.
        {" "}"Other wallets" also includes addresses that hold no {ticker} balance of their own.
      </span>
    );
  }

  return (
    <div className="opacity-90">
      {attributedDays === 0 ? (
        <span className="opacity-80">
          No counterparty-tier attribution exists for this window yet — it's a new pipeline feature that accrues going forward, so every wallet-to-wallet {ticker} amount below currently reads as untracked.
        </span>
      ) : (
        <span className="opacity-80">
          Source/destination attribution covers {fmtInt(attributedDays)} of {fmtInt(totalDays)} days in this window{sourceTierSince ? ` (since ${sourceTierSince})` : ""}.
        </span>
      )}
      {receivedWallet > 0 && (
        <div className="mt-1">
          <div className="font-semibold text-foreground/80">Where it came from:</div>
          {renderList(inflowsBySourceTier, receivedWallet)}
        </div>
      )}
      {moved > 0 && (
        <div className="mt-1">
          <div className="font-semibold text-foreground/80">Where it went:</div>
          {renderList(movedByDestTier, moved)}
        </div>
      )}
      <span className="opacity-80 block mt-1">"Other wallets" also includes addresses that hold no {ticker} balance of their own.</span>
    </div>
  );
};

const TelPanel = ({ field, period, windowLabel, avail, expandedFlow, onToggleFlow, onHoverFlow, chain, attributedDays, totalDays, sourceTierSince }: {
  field: TierField; period: string; windowLabel: string | null; avail: FlowAvailability; expandedFlow: string | null; onToggleFlow: (key: string) => void; onHoverFlow: (key: string | null) => void;
  chain: ChainKey; attributedDays: number; totalDays: number; sourceTierSince: string | null;
}) => {
  const { cause, row } = field;
  const netTel = netTelOf(field);
  const netTelShown = netDisplay(netOf("tel", field, avail), fmtTel);
  const { ticker, t } = useProjectCopy();
  const rawNarrative = avail.hasOutflows ? telNarrativeFor(field.label, netTel, cause) : null;
  const narrative = rawNarrative ? t(rawNarrative) : null;
  const nets = netCausesFor(cause);
  const hasAnyFlow = cause.hasData || cause.hasInData;

  return (
    <div className="mx-auto max-w-lg space-y-3 premium-surface-card p-4 animate-scale-in">
      <div className="flex items-baseline justify-between">
        <span className="font-bold text-foreground">{tierDisplayLabel(field.label)}</span>
        <span className="text-xs text-muted-foreground">{row ? `${fmtTel(row.totalBalance)} ${ticker}` : "—"}</span>
      </div>

      <div className="text-center text-sm text-muted-foreground">
        Net ({windowLabel ?? "selected period"}):{" "}
        <span className={`font-semibold ${NET_TONE_CLASS[netTelShown.tone]}`}>
          <ExplainNumber value={avail.hasOutflows ? `${netTelShown.text} ${ticker}` : netTelShown.text} explanation={netChangeTip(period, "tel", ticker)} className="inline-flex min-h-6 items-center max-xl:relative max-xl:before:absolute max-xl:before:-inset-x-1 max-xl:before:-inset-y-3 max-xl:before:content-['']" />
        </span>
      </div>

      {/* Net flow per category, biggest story first, each expandable to the
          two gross figures behind it. Same button-driven expansion as the
          canvas lines, so this is the keyboard path for that interaction. */}
      {hasAnyFlow && (
        <div className="pt-1 border-t border-border/40 text-sm">
          <div className="text-center text-muted-foreground font-semibold uppercase tracking-wide text-xs mb-1">
            Net flow by source
          </div>
          <ul className="space-y-0.5">
            {nets.map((c) => {
              const isOpen = expandedFlow === c.key;
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    onClick={() => onToggleFlow(c.key)}
                    onMouseEnter={() => onHoverFlow(c.key)}
                    onMouseLeave={() => onHoverFlow(null)}
                    onFocus={() => onHoverFlow(c.key)}
                    onBlur={() => onHoverFlow(null)}
                    aria-expanded={isOpen}
                    data-flow-row={c.key}
                    className="w-full rounded-md px-2 py-1 max-xl:min-h-11 flex items-center justify-between gap-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="text-muted-foreground">{c.label}</span>
                    <span className="font-semibold tabular-nums" style={{ color: colorForTone(c.tone) }}>
                      {c.net === 0 ? <span className="text-muted-foreground">no net flow</span> : `${signed(c.net, fmtTel)} ${ticker} ${c.tone === "neutral" ? "redistribution" : c.net > 0 ? "buy" : "sell"}`}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-2 pb-1 text-xs text-muted-foreground leading-relaxed">
                      <span className="tabular-nums font-semibold" style={{ color: c.key === "wallet" ? NEUTRAL : POSITIVE }}>+{fmtTel(c.inV)}</span> {c.inLabel}
                      {" · "}
                      <span className="tabular-nums font-semibold" style={{ color: c.key === "wallet" ? NEUTRAL : NEGATIVE }}>−{fmtTel(c.outV)}</span> {c.outLabel}
                      {c.key === "wallet" && (
                        <div className="mt-0.5">
                          {cause.splitTel > 0 && <>Of what left, {fmtTel(cause.splitTel)} went out across {fmtInt(cause.splitEvents)} same-day fan-out{cause.splitEvents === 1 ? "" : "s"} to multiple wallets{cause.soloMoved > 0 ? `, and ${fmtTel(cause.soloMoved)} to a single wallet` : ""}. </>}
                          {cause.splitTel === 0 && cause.soloMoved > 0 && <>All of what left went to a single other wallet each time. </>}
                          Wallet-to-wallet moves are neutral either way — neither buying nor selling.{" "}
                          <TierAttributionBreakdown
                            inflowsBySourceTier={cause.inflowsBySourceTier}
                            movedByDestTier={cause.movedByDestTier}
                            receivedWallet={cause.receivedWallet}
                            moved={cause.moved}
                            chain={chain}
                            attributedDays={attributedDays}
                            totalDays={totalDays}
                            sourceTierSince={sourceTierSince}
                          />
                        </div>
                      )}
                      {c.key === "cex" && (
                        <div className="mt-0.5">Withdrawals count as accumulation and deposits as distribution — the exchange-side trade itself isn't on-chain, so a deposit is a strong signal of intent to sell, not a confirmed sale.</div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {narrative && <p className="text-center text-sm text-muted-foreground leading-relaxed">{narrative}</p>}

      {!hasAnyFlow && !narrative && (
        <p className="text-sm text-muted-foreground" data-testid="tier-detail-empty">
          No on-chain flows recorded for this tier in this period.
        </p>
      )}
    </div>
  );
};

// Phrase for wallets that shrank *out of* this tier, keyed off the same
// sold-vs-relocated verdict that colors the down-ticks and migration lines.
const shrinkCauseClause = (verdict: TierField["verdict"], hasOutflowData: boolean): string => {
  if (!hasOutflowData || verdict === "unknown") return "";
  if (verdict === "sold") {
    return " — this tier's {ticker} outflows were mostly sales (DEX or exchange deposits)";
  }
  return " — this tier's {ticker} outflows were mostly wallet-to-wallet moves, not sales";
};

// The tile's flanking ticks report MEMBERSHIP change — wallets removed from
// this tier (left tick) and added to it (right tick) — not the direction of
// the size crossing. Each still breaks down by which way the wallet moved,
// since "left for a bigger tier" and "left for a smaller one" mean opposite
// things, and only shrinking outflows may claim this tier's sale/relocate
// verdict (a wallet growing out of the tier didn't sell anything).
const removedTickExplanation = (field: TierField): string => {
  const lost = field.migrations.filter((m) => !m.gained);
  const lostUp = lost.filter((m) => m.up).reduce((s, m) => s + m.count, 0);
  const lostDown = lost.filter((m) => !m.up).reduce((s, m) => s + m.count, 0);
  const n = field.removedCount;
  const plural = n === 1 ? "" : "s";
  const parts: string[] = [];
  if (lostUp > 0) {
    parts.push(`${fmtInt(lostUp)} grew up into a larger tier`);
  }
  if (lostDown > 0) {
    parts.push(`${fmtInt(lostDown)} shrank down into a smaller tier${shrinkCauseClause(field.verdict, field.cause.hasData)}`);
  }
  if (parts.length === 0) {
    return `${fmtInt(n)} wallet${plural} left ${field.label} this period.`;
  }
  return `${fmtInt(n)} wallet${plural} left ${field.label} this period: ${parts.join("; ")}.`;
};

const addedTickExplanation = (field: TierField): string => {
  const gained = field.migrations.filter((m) => m.gained);
  const gainedUp = gained.filter((m) => m.up).reduce((s, m) => s + m.count, 0);
  const gainedDown = gained.filter((m) => !m.up).reduce((s, m) => s + m.count, 0);
  const n = field.addedCount;
  const plural = n === 1 ? "" : "s";
  const parts: string[] = [];
  if (gainedUp > 0) {
    parts.push(`${fmtInt(gainedUp)} grew up from a smaller tier${growCauseClause(field.cause)}`);
  }
  if (gainedDown > 0) {
    parts.push(`${fmtInt(gainedDown)} arrived after dropping from a bigger tier`);
  }
  if (parts.length === 0) {
    return `${fmtInt(n)} wallet${plural} arrived into ${field.label} this period.`;
  }
  return `${fmtInt(n)} wallet${plural} arrived into ${field.label} this period: ${parts.join("; ")}.`;
};

// Inflow mix for upward arrivals into this tier: demand vs wallet receipt.
const growCauseClause = (cause: Cause): string => {
  if (!cause.hasInData || cause.inTotal <= 0) return "";
  const demandPct = ((cause.boughtDex + cause.boughtCex) / cause.inTotal) * 100;
  if (demandPct >= 50) {
    return ` — this tier's {ticker} inflows were mostly real demand (${demandPct.toFixed(0)}% DEX buys or exchange withdrawals)`;
  }
  const walletPct = (cause.receivedWallet / cause.inTotal) * 100;
  return ` — this tier's {ticker} inflows were mostly wallet transfers (${walletPct.toFixed(0)}%), not fresh buys`;
};

// Plain-language analysis of tier-to-tier wallet crossings. Counts are still
// crossings (not per-wallet txs); cause wording reuses this tier's TEL
// verdict / inflow mix — the same signal that colors the lines — rather than
// hedging every shrink with "likely a sale or splitting funds."
const walletNarrativeFor = (
  tier: string,
  { gainedUp, gainedDown, lostUp, lostDown }: { gainedUp: number; gainedDown: number; lostUp: number; lostDown: number },
  verdict: TierField["verdict"],
  cause: Cause,
  windowLabel: string | null = null,
): string | null => {
  const gainedTotal = gainedUp + gainedDown;
  const period = windowLabel ? `between ${windowLabel.replace(" → ", " and ")}` : "this period";
  const lostTotal = lostUp + lostDown;
  if (gainedTotal === 0 && lostTotal === 0) return null;

  const growClause = growCauseClause(cause);
  const shrinkClause = shrinkCauseClause(verdict, cause.hasData);
  const sentences: string[] = [];

  if (gainedTotal > 0) {
    const parts: string[] = [];
    // Upward arrivals can lean on this tier's inflow mix. Downward arrivals
    // left a *larger* tier — don't apply *this* tier's sale verdict to them.
    if (gainedUp > 0) {
      parts.push(`${fmtInt(gainedUp)} grew up into it from a smaller tier${growClause}`);
    }
    if (gainedDown > 0) {
      parts.push(`${fmtInt(gainedDown)} arrived after their balance fell from a larger tier`);
    }
    sentences.push(`This tier gained ${fmtInt(gainedTotal)} wallet${gainedTotal === 1 ? "" : "s"} ${period}: ${parts.join(", and ")}.`);
  }
  if (lostTotal > 0) {
    const parts: string[] = [];
    // lostUp is an outflow — do not attach inflow growCauseClause.
    if (lostUp > 0) {
      parts.push(`${fmtInt(lostUp)} grew up out of it into a larger tier`);
    }
    if (lostDown > 0) {
      parts.push(`${fmtInt(lostDown)} shrank out of it into a smaller tier${shrinkClause}`);
    }
    sentences.push(`It lost ${fmtInt(lostTotal)} wallet${lostTotal === 1 ? "" : "s"}: ${parts.join(", and ")}.`);
  }
  const crossingNet = gainedTotal - lostTotal;
  sentences.push(`Net ${signed(crossingNet, fmtInt)} wallets (${fmtInt(gainedTotal)} joined, ${fmtInt(lostTotal)} left).`);
  return sentences.join(" ");
};

// One analytical sentence per tier scenario, with real numbers filled in —
// the plain-language counterpart to the segmented bars above, for a reader
// who wants the takeaway without parsing a stacked breakdown. Covers every
// combination the data can actually produce: accumulated (with/without a
// source breakdown yet), net outflow dominated by real sales, net outflow
// that's mostly redistribution, and the no-data case.
const telNarrativeFor = (tier: string, netTel: number, cause: Cause): string | null => {
  // Net is TEL in minus TEL out (owner decision 2026-10-31), the same figure
  // the panel header shows.
  const net = netTel;
  if (net === 0 && !cause.hasData && !cause.hasInData) return null;
  if (net === 0) return `${tier} had no net change in {ticker} over this period: what came in matched what left.`;

  if (net > 0) {
    if (cause.hasInData && cause.inTotal > 0) {
      const demandPct = ((cause.boughtDex + cause.boughtCex) / cause.inTotal) * 100;
      const walletPct = (cause.receivedWallet / cause.inTotal) * 100;
      const lede = demandPct >= 50
        ? `most of it real demand — ${demandPct.toFixed(0)}% was bought on a DEX or withdrawn from an exchange`
        : `mostly wallets repositioning — ${walletPct.toFixed(0)}% simply arrived from other wallets, only ${demandPct.toFixed(0)}% was a fresh DEX buy or exchange withdrawal`;
      return `${tier} accumulated a net ${fmtTel(net)} {ticker} over this period, ${lede}.`;
    }
    return `${tier} accumulated a net ${fmtTel(net)} {ticker} over this period — the on-chain source breakdown is still backfilling.`;
  }

  if (cause.hasData && cause.total > 0) {
    // Match useFlowField verdict: moved >= sold → relocated (so sales only
    // when soldPct > 50, not on a 50/50 tie).
    const soldPct = cause.soldPct;
    return soldPct > 50
      ? `${tier} had a net outflow of ${fmtTel(Math.abs(net))} {ticker}, and ${soldPct.toFixed(0)}% of what left actually reached the market — sold on a DEX or deposited to an exchange.`
      : `${tier} had a net outflow of ${fmtTel(Math.abs(net))} {ticker}, but only ${soldPct.toFixed(0)}% of what left actually reached the market — the rest was just relocated to other wallets, still held.`;
  }

  return net < 0 ? `${tier} had a net outflow of ${fmtTel(Math.abs(net))} {ticker} over this period.` : null;
};
