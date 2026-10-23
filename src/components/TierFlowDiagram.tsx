import { useMemo, useRef, useState, useEffect, useLayoutEffect, useCallback, type ReactNode } from "react";
import { AsOfBadge } from "@/components/AsOfBadge";
import { useChartIntro } from "@/hooks/useMotion";
import { createPortal } from "react-dom";
import { ChevronRight, RotateCw, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { InfoTooltip } from "@/components/InfoTooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useExchangeFlow } from "@/hooks/useExchangeFlow";
import { useMediaQuery, PHONE_QUERY } from "@/hooks/useMediaQuery";
import {
  TIERS, CANVAS_W, CANVAS_H, rowTop, rowCenterY, tileW, tierLeftX, TIER_COL_CENTER_X, tileEdgeX,
  sideTop, sideCenterY, SIDE_H, bezierPath, laneArcPath, fanY, strokeWidth, rankedStrokeWidths, TIER_H,
  tierDisplayLabel,
} from "@/components/tierflow/geometry";
import { useFlowField, type ChainKey, type TierRow, type Cause, type TierField } from "@/components/tierflow/useFlowField";
import {
  netMigrationsFor, netCausesFor, valueForSideTile, sideTileContributions, sideTileRowIndex, SIDE_TILE_LABELS,
  retailDemandFor, tierNetTel, tierDexActivity,
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
  /** Real date of the snapshot the deltas/net are compared against — YTD's
   *  Jan-1 boundary and the nearest available history entry are rarely the
   *  same day, so this must be labeled honestly rather than implying "since
   *  Jan 1" when the true baseline is weeks later. */
  baselineDate?: string | null;
  /** † rule: when the caller suppressed tier deltas (a reclassification after
   *  the baseline), it passes previous* = null plus the reason to show in
   *  place of "no baseline", so the diagram agrees with the Tiers table. */
  suppressedNote?: { count?: string | null; balance?: string | null };
  /** Chain filter from the page-level selector; defaults to all chains. */
  chain?: ChainKey;
  /** Controlled selection, shared with sibling panels (Tiers table, bars). */
  selection?: DistSelection;
  onSelectionChange?: (next: DistSelection) => void;
  /** "terminal": fits the canvas to its container in both dimensions and
   *  drops the card chrome the surrounding panel already provides. */
  layout?: "stacked" | "terminal";
  /** Terminal layout: where the selected tier / side tile detail renders
   *  (the right-hand column). Falls back to inline below the canvas. */
  detailContainer?: HTMLElement | null;
};

// Strict three-way classification used everywhere in this diagram: GREEN =
// buy pressure, RED = sell pressure, YELLOW = redistribution (LP / wallet
// moves — no market buy or sell). Same palette in both Wallets and TEL modes.
const GREEN = "hsl(142 71% 45%)", RED = "hsl(0 72% 55%)", YELLOW = "hsl(48 95% 50%)";
const POSITIVE = GREEN, NEGATIVE = RED, NEUTRAL = YELLOW;
// Darker variants for text on tinted backgrounds — GREEN/RED are chart fills and
// fail 4.5:1 as small text.
const POSITIVE_TEXT = "hsl(var(--tier-positive-text))", NEGATIVE_TEXT = "hsl(var(--tier-negative-text))";
const MUTED = "hsl(var(--muted-foreground))";
const BUY_DEX = POSITIVE, BUY_CEX = POSITIVE, BUY_WALLET = NEUTRAL;
const colorForVerdict = (verdict: "unknown" | "relocated" | "sold") =>
  (verdict === "relocated" ? NEUTRAL : verdict === "sold" ? NEGATIVE : MUTED);
// netFlow.ts stays palette-free and returns a semantic tone; the view owns
// the mapping to actual hues.
const colorForTone = (tone: FlowTone) => (tone === "positive" ? POSITIVE : tone === "negative" ? NEGATIVE : NEUTRAL);
/** Light tinted fill so selected/idle pressure tiles keep core chroma visible. */
const tintFill = (color: string, alpha = 0.15) =>
  color.startsWith("hsl(") ? color.replace(/\)$/, ` / ${alpha})`) : color;

const signed = (v: number, f: (n: number) => string) => `${v >= 0 ? "+" : "−"}${f(Math.abs(v))}`;
const fmtTel = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return `${Math.round(v)}`;
};
const fmtInt = (v: number) => new Intl.NumberFormat().format(Math.round(v));

// Two entirely separate explainer texts, one per mode — each describes ONLY
// what that mode actually shows, instead of one paragraph covering both
// wallet migration and TEL cause-breakdown regardless of which is on screen.
const INFO_WALLETS =
  "Each tile is a retail balance tier, sized by holder count. The two small ticks flanking a tile are gross migration counts over the selected period: on the left, in green, how many wallets ARRIVED into that tier; on the right, in red, how many LEFT it. The figure inside the bar is the tier's net change, taken from the balance snapshots themselves rather than from these two counts.\n\nClick a tier to see exactly which tiers its wallets came from (arriving on the left) and went to (leaving on the right) — the lines are the whole story: this mode answers \"why did the wallet COUNT change,\" using only real, tracked wallet movement between tiers.";
const INFO_TEL =
  "Each tile is a retail balance tier, sized by total TEL held. The lens is buy pressure vs sell pressure over the selected period: green on the left is TEL entering retail from the market or custody (Bought on DEX, From exchange); red on the right is TEL leaving toward a sale (Sold on DEX, To exchange). Yellow is redistribution — LP or wallet↔wallet — not market pressure.\n\nClick a tier to scope the top tiles and side columns to that tier; click off to restore period totals. Yellow To wallet / From wallet is a two-step drill: select a tier first, then that side tile to trace transfers tier-to-tier.\n\nOr click a side tile alone (Bought on DEX, From exchange, …) with no tier selected to see every tier’s share of that pressure.\n\nThe net change shown always comes from the real balance snapshots, never from adding up these flows.";

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

// The color legend shown in the header: buy / sell pressure + redistribution.
const LEGEND: { color: string; label: string; explanation: string }[] = [
  { color: POSITIVE, label: "Buy pressure", explanation: "TEL entering retail from the market or custody — bought on a DEX, or withdrawn from an exchange into self-custody. In Wallets mode, also wallets ARRIVING into a tier (left-hand tick and inbound migration lines)." },
  { color: NEGATIVE, label: "Sell pressure", explanation: "TEL leaving retail toward a sale — sold on a DEX, or deposited to an exchange (a common precursor to a sale). In Wallets mode, a tier's right-hand tick or outbound migration line uses this when that tier's outflow was dominated by real sales rather than wallet-to-wallet moves." },
  { color: NEUTRAL, label: "Redistribution", explanation: "TEL moved to another wallet or added to / withdrawn from an LP pool — not market buy or sell pressure. In Wallets mode, used when a tier's outflow was mostly relocation, not a sale." },
];

export const TierFlowDiagram = ({
  rangeDays,
  rows,
  metric,
  onMetricChange,
  baselineDate,
  suppressedNote,
  chain: chainProp,
  selection: selectionProp,
  onSelectionChange,
  layout = "stacked",
  detailContainer,
}: Props) => {
  // One-shot: fades with the first load, not when a chain change reloads it.
  const canvasIntro = useChartIntro();
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
  const { fields, netInfo, grossExplainer, maxMigrationCount, loading, errored, ready, complete, attributedDays, totalDays, sourceTierSince, outflowsAsOf, crossingsWindow } = useFlowField(rows, chain, metric, rangeDays);
  const { data: exchangeFlow } = useExchangeFlow();
  const rangeLabel = RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? `${rangeDays}D`;
  const isWallets = metric === "wallets";
  // Under 640px the scaled-down canvas renders tier labels at ~6px; phones
  // get a stacked, full-size list driving the same selection + detail panel.
  const isPhone = useMediaQuery(PHONE_QUERY);

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
  useLayoutEffect(() => {
    const el = scrollEl;
    if (el && !isTerminal) el.scrollLeft = Math.max(0, TIER_COL_CENTER_X * scale - el.clientWidth / 2);
  }, [scrollEl, ready, scale, isTerminal]);

  // Scale-to-fit. The canvas is a fixed 936×682 grid — every tile position is
  // computed in those coordinates, so it cannot reflow. Shrinking the whole
  // canvas keeps every element on screen and needs no second rendering path.
  //
  // Stacked layout: fit the WIDTH (the page scrolls vertically anyway).
  // Terminal layout: fit BOTH dimensions of the panel, so the whole diagram
  // — both side-tile columns and the bottom tier — is visible with no
  // internal scrolling. Scale is capped at 1.
  //
  // The wrapper carries the scaled size because a transform does not affect
  // layout — without it the card would reserve the full 682px.
  useLayoutEffect(() => {
    const el = scrollEl;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const byW = el.clientWidth / CANVAS_W;
      const byH = isTerminal && el.clientHeight > 0 ? el.clientHeight / CANVAS_H : Infinity;
      const next = Math.max(0.2, Math.min(1, byW, byH));
      setScale((prev) => (Math.abs(prev - next) < 0.002 ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollEl, isTerminal]);

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
  const clearSelection = () => dispatch({ type: "clear" });

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

  // Snapshot net TEL: period-wide from netInfo, or the selected tier's delta.
  const scopedNetTel = selectedField
    ? tierNetTel(selectedField.row)
    : netInfo.netTel;
  const scopedPartialTel = selectedField ? false : netInfo.partialTel;

  // DEX bought/sold: whole-market when no tier selected; that tier's swaps when selected.
  const scopedDex = useMemo(() => {
    if (selectedField) return tierDexActivity(selectedField.cause);
    return wholeMarket;
  }, [selectedField, wholeMarket]);
  const tierLabelShort = selectedField ? tierDisplayLabel(selectedField.label) : null;

  const maxPct = Math.max(1, ...fields.map((f) => f.pct));
  // Stable identity so the telLines memo below actually memoizes rather than
  // recomputing on every render (maxPct is a primitive, so this only changes
  // when the scale really does).
  const scaledTileW = useCallback((pct: number) => tileW((pct / maxPct) * 100), [maxPct]);

  // Migration lines for the selected tier, arcing through the left (net gain)
  // or right (net loss) lane and landing exactly on the counterpart tile's
  // own edge (tile widths are data-driven, so a "right" edge isn't at the
  // same x for every tier — laneArcPath handles that). Each path's `d` is
  // built in the ACTUAL flow direction (source first, destination last) so
  // the animated dot travels the true direction.
  //
  // Level 1 (default): ONE net line per counterpart. Level 2: the counterpart
  // in `expandedFlow` is broken back open into its real gained + lost arcs,
  // while every other counterpart stays netted.
  // WALLETS mode only — these are wallet counts, not TEL.
  const migrationLines = useMemo(() => {
    if (!selectedField || !isWallets) return [];
    const byLabel = new Map(fields.map((f) => [f.label, f]));
    const localMaxPct = Math.max(1, ...fields.map((f) => f.pct));
    const widthOf = (pct: number) => tileW((pct / localMaxPct) * 100);
    const edgeX = (pct: number, side: "left" | "right") => tileEdgeX(widthOf(pct), side);
    const selfX = { left: edgeX(selectedField.pct, "left"), right: edgeX(selectedField.pct, "right") };
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
    const out: { key: string; flowKey: string; d: string; color: string; w: number; label: string; labelX: number; labelY: number; tooltip: string }[] = [];
    for (const side of ["left", "right"] as const) {
      const list = specs.filter((s) => s.side === side);
      list.forEach((s, k) => {
        const cIdx = TIERS.indexOf(s.counterpart as (typeof TIERS)[number]);
        if (cIdx < 0) return;
        const counterpart = byLabel.get(s.counterpart);
        const theirY = rowCenterY(cIdx);
        const theirX = edgeX(counterpart?.pct ?? 0, side);
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
        out.push({
          key: `${side}-${s.counterpart}`, flowKey: s.counterpart, d,
          color: s.incoming ? POSITIVE : colorForVerdict(selectedField.verdict),
          w: strokeWidth(s.value, maxMigrationCount), label: s.label,
          labelX: side === "left" ? myX - 40 : myX + 40, labelY: (myY + theirY) / 2,
          tooltip,
        });
      });
    }
    return out;
  }, [selectedField, maxMigrationCount, fields, isWallets, expandedFlow]);

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
    const destX = tileEdgeX(scaledTileW(selectedField.pct), "left");
    const srcX = tileEdgeX(scaledTileW(selectedField.pct), "right");
    const barY = (j: number) => fanY(rowCenterY(selectedField.index), j, 3);
    const out: { key: string; flowKey: string; d: string; color: string; w: number; label: string; labelX: number; labelY: number; tooltip: string }[] = [];
    // Built source-first (origin -> destination) throughout so the pulsing
    // dot always travels the direction the TEL actually moved.
    const came = (j: number, v: number, color: string, label: string, tooltip: string) => ({
      key: `came-${j}`, d: bezierPath(198, sideCenterY(j), destX, barY(j)), color,
      w: strokeWidth(v, denom), label, labelX: destX - 44, labelY: (sideCenterY(j) + barY(j)) / 2, tooltip,
    });
    const went = (j: number, v: number, color: string, label: string, tooltip: string) => ({
      key: `went-${j}`, d: bezierPath(srcX, barY(j), 738, sideCenterY(j)), color,
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
        if (c.inV > 0) out.push({ ...came(j, c.inV, inColor, `+${fmtTel(c.inV)}`, `${fmtTel(c.inV)} TEL ${c.inLabel}`), key: `came-${c.key}`, flowKey: c.key });
        if (c.outV > 0) out.push({ ...went(j, c.outV, outColor, `−${fmtTel(c.outV)}`, `${fmtTel(c.outV)} TEL ${c.outLabel}`), key: `went-${c.key}`, flowKey: c.key });
      } else if (c.net !== 0) {
        const netTooltip = c.net > 0 ? `Net ${fmtTel(c.net)} TEL in from ${c.label}` : `Net ${fmtTel(-c.net)} TEL out to ${c.label}`;
        const line = c.net > 0 ? came(j, c.net, colorForTone(c.tone), signed(c.net, fmtTel), netTooltip) : went(j, -c.net, colorForTone(c.tone), signed(c.net, fmtTel), netTooltip);
        out.push({ ...line, key: `net-${c.key}`, flowKey: c.key });
      }
    });
    return out;
  }, [selectedField, isWallets, expandedFlow, scaledTileW]);

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
    const byLabel = new Map(fields.map((f) => [f.label, f]));
    const localMaxPct = Math.max(1, ...fields.map((f) => f.pct));
    const widthOf = (pct: number) => tileW((pct / localMaxPct) * 100);
    const edgeX = (pct: number, side: "left" | "right") => tileEdgeX(widthOf(pct), side);
    const selfLeft = edgeX(selectedField.pct, "left");
    const selfRight = edgeX(selectedField.pct, "right");
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
    const out: { key: string; tier: string; d: string; color: string; w: number; label: string; labelX: number; labelY: number; tooltip: string }[] = [];

    // Fan each side against its own neighbours so arcs don't stack on one y.
    inEntries.forEach(([tier, v], k) => {
      const cIdx = TIERS.indexOf(tier as (typeof TIERS)[number]);
      if (cIdx < 0) return;
      const theirX = edgeX(byLabel.get(tier)?.pct ?? 0, "left");
      const theirY = rowCenterY(cIdx);
      const myY = fanY(y0, k, inEntries.length);
      // Source-first: counterpart → selected (TEL arrived from that tier).
      out.push({
        key: `attr-in-${tier}`, tier, color: NEUTRAL, w: strokeWidth(v, inDenom),
        d: laneArcPath(theirX, theirY, selfLeft, myY, "left"),
        label: `+${fmtTel(v)}`, labelX: selfLeft - 40, labelY: (myY + theirY) / 2,
        tooltip: `${fmtTel(v)} TEL arrived from ${tier} via wallet transfer`,
      });
    });
    outEntries.forEach(([tier, v], k) => {
      const cIdx = TIERS.indexOf(tier as (typeof TIERS)[number]);
      if (cIdx < 0) return;
      const theirX = edgeX(byLabel.get(tier)?.pct ?? 0, "right");
      const theirY = rowCenterY(cIdx);
      const myY = fanY(y0, k, outEntries.length);
      // Source-first: selected → counterpart (TEL left for that tier).
      out.push({
        key: `attr-out-${tier}`, tier, color: NEUTRAL, w: strokeWidth(v, outDenom),
        d: laneArcPath(selfRight, myY, theirX, theirY, "right"),
        label: `−${fmtTel(v)}`, labelX: selfRight + 40, labelY: (myY + theirY) / 2,
        tooltip: `${fmtTel(v)} TEL went to ${tier} via wallet transfer`,
      });
    });
    return out;
  }, [isWallets, selectedField, expandedFlow, selectedSideTile, chain, attributedDays, fields]);

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
    const localMaxPct = Math.max(1, ...fields.map((f) => f.pct));
    const widthOf = (pct: number) => tileW((pct / localMaxPct) * 100);
    const color = key === "wallet" ? NEUTRAL : side === "in" ? POSITIVE : NEGATIVE;
    return rows.map(({ f, v }, i) => {
      const tierEdgeX = tileEdgeX(widthOf(f.pct), side === "in" ? "left" : "right");
      const tierY = rowCenterY(f.index);
      const sideX = side === "in" ? 198 : 738;
      const sideY = sideCenterY(j);
      const d = side === "in"
        ? bezierPath(sideX, sideY, tierEdgeX, tierY)
        : bezierPath(tierEdgeX, tierY, sideX, sideY);
      const tooltip = side === "in"
        ? `${fmtTel(v)} TEL into ${f.label} via ${label}`
        : `${fmtTel(v)} TEL from ${f.label} via ${label}`;
      return {
        key: `side-${side}-${key}-${f.label}`,
        tier: f.label,
        d,
        color,
        w: widths[i],
        label: fmtTel(v),
        labelX: (sideX + tierEdgeX) / 2,
        labelY: (sideY + tierY) / 2,
        tooltip,
      };
    });
  }, [isWallets, selectedSideTile, selected, fields]);

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

  if (loading) return <FlowSkeleton terminal={isTerminal} />;
  if (errored || !ready) return <FlowError />;

  const detailNode: ReactNode = selectedField ? (
    isWallets
      ? <WalletsPanel field={selectedField} baselineDate={baselineDate ?? null} noBaselineText={suppressedNote?.count ?? null} crossingsWindow={crossingsWindow} expandedFlow={expandedFlow} onToggleFlow={toggleFlow} onHoverFlow={setHoveredFlow} />
      : <TelPanel field={selectedField} baselineDate={baselineDate ?? null} noBaselineText={suppressedNote?.balance ?? null} expandedFlow={expandedFlow} onToggleFlow={toggleFlow} onHoverFlow={setHoveredFlow} chain={chain} attributedDays={attributedDays} totalDays={totalDays} sourceTierSince={sourceTierSince} />
  ) : selectedSideTile && !isWallets ? (
    <SideTilePanel
      selection={selectedSideTile}
      fields={fields}
      hoveredTier={hoveredAttrTier}
      onHoverTier={setHoveredAttrTier}
    />
  ) : null;

  const hasAnySelection = !!(selected || selectedSideTile);
  const metricToggle = (
    <div role="group" aria-label="Measure tiers by" className="inline-flex rounded-full border border-border/60 bg-card/80 p-0.5">
      {([["wallets", "Wallets"], ["tel", "TEL"]] as const).map(([key, label]) => (
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
  const legend = (
    <div className={`flex items-center gap-x-4 gap-y-1 flex-wrap text-muted-foreground ${isTerminal ? "text-xs" : "justify-center text-sm"}`}>
      {LEGEND.map((l) => (
        <span key={l.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: l.color }} />
          <ExplainNumber value={l.label} explanation={l.explanation} ariaLabel={`${l.label}: what this colour means`} className="inline-flex min-h-6 items-center" />
        </span>
      ))}
    </div>
  );

  return (
    <div className={isTerminal ? "flex h-full min-h-0 flex-col gap-2" : "space-y-3"} data-testid="tier-flow">
      {isTerminal ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
          {metricToggle}
          {legend}
          <div className="ml-auto flex items-center gap-2">
            <AsOfBadge iso={outflowsAsOf} label="Flows as of" testId="tier-outflows-asof" />
            {clearButton}
            <InfoTooltip text={isWallets ? INFO_WALLETS : INFO_TEL} label="How to read the tier flows" />
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">Retail distribution by tier</h3>
              <InfoTooltip text={isWallets ? INFO_WALLETS : INFO_TEL} label="How to read the tier flows" />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <AsOfBadge iso={outflowsAsOf} label="Flows as of" testId="tier-outflows-asof" />
              {clearButton}
              {metricToggle}
            </div>
          </div>
          {legend}
        </>
      )}

      {complete !== true && (
        <div className={`rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 text-center ${isTerminal ? "shrink-0 px-2 py-1 text-xs" : "px-3 py-2 text-sm"}`}>
          On-chain classification is still backfilling for some chains — figures below may under-represent recent activity.
        </div>
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
        <div className={`text-center text-muted-foreground ${isTerminal ? "shrink-0 text-[11px]" : "text-xs"}`}>
          Tier sizes are for this chain; wallet moves between tiers (the +/− ticks and lines) are tracked across all chains combined.
        </div>
      )}

      {/* WALLETS mode: one focused stat, in wallets — matches everything else
          on screen in this mode, so nothing needs a unit switch mid-read.
          TEL mode: buy/sell pressure summary — period totals when no tier is
          selected; scoped to the selected tier when one is. */}
      {isWallets ? (isTerminal ? null : (
        <div className="premium-surface-card p-4 text-center max-w-md mx-auto">
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">
            Retail wallets, net change {`(vs ${baselineLabel(baselineDate)})`}
          </div>
          {netInfo.netWallets == null ? (
            <div className="text-sm text-muted-foreground">{suppressedNote?.count ?? "No baseline available for this period."}</div>
          ) : (
            <>
              <div className={`text-xl font-bold ${netInfo.netWallets >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                {signed(netInfo.netWallets, fmtInt)} wallets
              </div>
              {netInfo.partialWallets && <div className="text-xs text-muted-foreground mt-0.5">Some tiers have no baseline yet — this total only counts the ones that do.</div>}
            </>
          )}
        </div>
      )) : (
        <>
          <div className={`grid sm:grid-cols-3 ${isTerminal ? "shrink-0 gap-2 [&>div]:!p-2 [&_.text-xl]:!text-base [&>div>div:first-child]:!text-[10px] [&>div>div:first-child]:!mb-0" : "gap-3"}`}>
            <div className="premium-surface-card p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                {tierLabelShort
                  ? `${tierLabelShort} net change`
                  : `Retail net change`}{` (vs ${baselineLabel(baselineDate)})`}
              </div>
              {scopedNetTel == null ? (
                <div className="text-sm text-muted-foreground">{suppressedNote?.balance ?? "No baseline available for this period."}</div>
              ) : (
                <>
                  <div className={`text-xl font-bold ${scopedNetTel >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                    <ExplainNumber
                      value={`${signed(scopedNetTel, fmtTel)} TEL`}
                      explanation={tierLabelShort
                        ? `Snapshot-to-snapshot change for the ${tierLabelShort} tier — includes buys, sells, exchange moves, and wallet relocation.`
                        : "The real snapshot-to-snapshot change in retail TEL — includes everything: buys, sells, exchange moves, and wallets simply relocating funds to other wallets. Not the same as \"net demand\" below, which excludes wallet-to-wallet relocation."}
                    />
                  </div>
                  {scopedPartialTel && <div className="text-xs text-muted-foreground mt-0.5">Some tiers have no baseline yet — this total only counts the ones that do.</div>}
                </>
              )}
            </div>
            <div className="premium-surface-card p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                {tierLabelShort ? `${tierLabelShort} buy − sell pressure` : "Retail buy − sell pressure"}, {rangeLabel}
              </div>
              {retailDemand ? (
                <>
                  <div className={`text-xl font-bold ${retailDemand.net >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                    <ExplainNumber
                      value={`${signed(retailDemand.net, fmtTel)} TEL`}
                      explanation={`Buy pressure (${fmtTel(retailDemand.bought)}: DEX buys + exchange withdrawals) minus sell pressure (${fmtTel(retailDemand.sold)}: DEX sells + exchange deposits)${tierLabelShort ? ` for ${tierLabelShort}` : " across retail tiers"}. Excludes wallet-to-wallet relocation — that's redistribution, not market pressure.`}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{retailDemand.net >= 0 ? "More buy than sell pressure" : "More sell than buy pressure"}, excluding wallet-to-wallet moves.</div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">No DEX/exchange activity recorded yet.</div>
              )}
            </div>
            <div className="premium-surface-card p-4 text-center">
              <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                {tierLabelShort ? `${tierLabelShort} DEX activity` : "Whole-market DEX activity"}, {rangeLabel}
              </div>
              {scopedDex ? (
                <>
                  <div className={`text-xl font-bold ${scopedDex.net >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
                    <span style={{ color: POSITIVE }}>{fmtTel(scopedDex.bought)}</span>
                    {" bought / "}
                    <span style={{ color: NEGATIVE }}>{fmtTel(scopedDex.sold)}</span>
                    {" sold"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {tierLabelShort
                      ? "This tier’s DEX swaps — same figures as Bought on DEX / Sold on DEX beside the chart."
                      : "All wallets, not just retail tiers below — a separate figure from the tier detail."}
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">No DEX activity recorded yet.</div>
              )}
            </div>
          </div>

          <div className={`text-muted-foreground text-center ${isTerminal ? "shrink-0 text-[11px]" : "text-xs"}`}>
            Of the TEL that left retail tiers:{" "}
            <span style={{ color: NEGATIVE }} className="font-semibold">
              <ExplainNumber value={`${fmtTel(grossExplainer.dex)}`} explanation="Sold on a DEX — a direct, unambiguous sale (sell pressure)." />
            </span> sold on DEX,{" "}
            <span style={{ color: NEGATIVE }} className="font-semibold">
              <ExplainNumber value={`${fmtTel(grossExplainer.cex)}`} explanation="Deposited to a known exchange wallet — sell pressure; the exchange-side trade itself isn't on-chain." />
            </span> to exchanges,{" "}
            <span style={{ color: NEUTRAL }} className="font-semibold">
              <ExplainNumber value={`${fmtTel(grossExplainer.moved)}`} explanation="Moved to another wallet — redistribution, not buy or sell pressure." />
            </span> moved to other wallets — gross figures, not the net above.
          </div>
        </>
      )}

      {/* Always-visible instruction, not buried in the (i) tooltip — the
          #1 usability gap found in review was that clicking a tier isn't
          discoverable at all. */}
      <div className={`text-center text-muted-foreground ${isTerminal ? "shrink-0 text-xs" : "text-sm"}`} aria-live="polite">
        {isPhone
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
            : "Click a tier to see where its wallets came from and went."
          : selectedField && expandedFlow === "wallet"
            ? (selectedSideTile?.side === "out"
              ? "Yellow lines are wallet transfers out of this tier — click To wallet again to close."
              : selectedSideTile?.side === "in"
                ? "Yellow lines are wallet transfers into this tier — click From wallet again to close."
                : "Yellow lines are wallet transfers between this tier and others.")
            : selectedField
              ? "Click a yellow To wallet / From wallet tile to trace those transfers tier-to-tier. Click the tier again for period totals."
              : "Click a tier to scope buy/sell pressure to that tier, or a side tile (Bought on DEX, From exchange, …) for every tier’s share. Click off a tier for period totals."}
      </div>

      {isPhone ? (
        <ul className="space-y-1.5" aria-label={`Retail tiers by ${isWallets ? "wallet count" : "TEL held"}`}>
          {[...fields].sort((a, b) => a.index - b.index).map((f) => {
            const isSelected = selected === f.label;
            const cur = isWallets ? f.row?.count ?? 0 : f.row?.totalBalance ?? 0;
            const prev = isWallets ? f.row?.previousCount ?? null : f.row?.previousTotalBalance ?? null;
            const grew = prev != null ? cur > prev : null;
            const fill = grew === null ? "hsl(var(--primary))" : grew ? POSITIVE : colorForVerdict(f.verdict);
            const fmt = isWallets ? fmtInt : fmtTel;
            return (
              <li key={f.label}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  data-tier={f.label}
                  onClick={() => selectTier(f.label)}
                  className={`relative flex min-h-[48px] w-full items-center gap-2 overflow-hidden rounded-lg border px-3 py-2 text-left transition-colors ${isSelected ? "ring-2 ring-offset-1 ring-offset-background" : "hover:bg-muted/40"}`}
                  style={{ borderColor: isSelected ? fill : "hsl(var(--border) / 0.6)", ["--tw-ring-color" as string]: fill }}
                >
                  {/* Share-of-retail bar behind the row, same encoding as the
                      tile width on the desktop canvas. */}
                  <span aria-hidden="true" className="absolute inset-y-0 left-0" style={{ width: `${Math.max(2, Math.min(100, f.pct))}%`, background: fill, opacity: 0.16 }} />
                  <span className="relative min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{tierDisplayLabel(f.label)}</span>
                    {isWallets && (f.addedCount > 0 || f.removedCount > 0) && (
                      <span className="block text-[11px] tabular-nums text-muted-foreground">
                        <span style={{ color: POSITIVE_TEXT }}>+{fmtInt(f.addedCount)} in</span>
                        {" · "}
                        <span style={{ color: NEGATIVE_TEXT }}>−{fmtInt(f.removedCount)} out</span>
                      </span>
                    )}
                  </span>
                  <span className="relative shrink-0 text-right">
                    <span className="block text-sm font-bold tabular-nums text-foreground">{fmt(cur)}</span>
                    {prev != null && cur !== prev && (
                      <span className="block text-xs font-semibold tabular-nums" style={{ color: cur > prev ? POSITIVE_TEXT : NEGATIVE_TEXT }}>
                        {cur > prev ? "+" : "−"}{fmt(Math.abs(cur - prev))}
                      </span>
                    )}
                  </span>
                  <ChevronRight className={`relative h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isSelected ? "rotate-90" : ""}`} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
      <div
        ref={setScrollEl}
        data-testid="tier-flow-canvas"
        data-scale={scale.toFixed(3)}
        className={isTerminal ? "relative flex min-h-0 flex-1 justify-center overflow-hidden" : "overflow-x-auto -webkit-overflow-scrolling-touch pb-1"}
      >
        <div className="relative shrink-0" style={{ width: CANVAS_W * scale, height: CANVAS_H * scale }}>
        <div
          // Tier nodes and any arcs fade in once with the first load.
          className={`absolute left-0 top-0 ${canvasIntro ? "ha-fade-in" : ""}`}
          style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${scale})`, transformOrigin: "top left" }}
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
              const showAmount = expandedFlow === l.flowKey || hoveredFlow === l.flowKey;
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
                      <FlowPath d={l.d} color={l.color} width={l.w} />
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
              const showAmount = hoveredAttrTier === l.tier || expandedFlow === "wallet";
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
                      <FlowPath d={l.d} color={l.color} width={l.w} />
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
              const showAmount = hoveredAttrTier === l.tier;
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
                      <FlowPath d={l.d} color={l.color} width={l.w} />
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
          {!isWallets && <div role="group" aria-label="Where retail TEL came from" className="contents">{SIDE_LABELS_IN.map((s, j) => {
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
                aria-label={`${s.label}: ${aggregate > 0 ? `${fmtTel(aggregate)} TEL` : "none"}${selectedField ? ` into ${tierDisplayLabel(selectedField.label)}` : ""}`}
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
          {!isWallets && <div role="group" aria-label="Where retail TEL went" className="contents">{SIDE_LABELS_OUT.map((s, j) => {
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
                aria-label={`${s.label}: ${aggregate > 0 ? `${fmtTel(aggregate)} TEL` : "none"}${selectedField ? ` from ${tierDisplayLabel(selectedField.label)}` : ""}`}
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

          {/* Tier tiles — CENTER-aligned: every tile shares the same
              horizontal center (TIER_COL_CENTER_X) and grows left/right by
              equal amounts as its value grows, instead of all starting flush
              left and only ever extending rightward. */}
          <div role="group" aria-label={`Balance tiers, by ${isWallets ? "wallet count" : "TEL held"}`} className="contents">
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
            const w = scaledTileW(f.pct);
            const cur = isWallets ? f.row?.count ?? 0 : f.row?.totalBalance ?? 0;
            const prev = isWallets ? f.row?.previousCount ?? null : f.row?.previousTotalBalance ?? null;
            const grew = prev != null ? cur > prev : null;
            const fill = grew === null ? "hsl(var(--primary))" : grew ? POSITIVE : colorForVerdict(f.verdict);
            // 160px floor: the narrowest tiers (500M+, 250M–500M) used to clip their
            // own label to "500…" at 100px, hiding which tier the row even was.
            // 200px fits "250M-500M" + count + net with the chevron hidden on
            // phones (it's only a hover affordance there anyway).
            const barW = Math.max(w, 200);
            const barLeft = tileEdgeX(barW, "left");
            return (
              // A wrapping div (not the button itself) is the positioned
              // element — the up/down tick markers need their own clickable
              // <button> for ExplainNumber's popover, and a <button> can't
              // validly contain another <button>. The tile's own click
              // surface is the inner <button> below; the ticks sit beside it
              // as siblings so both are independently interactive.
              <div key={f.label} className="absolute" style={{ left: barLeft, top: rowTop(f.index), width: barW, height: TIER_H }}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  data-tier={f.label}
                  onClick={() => selectTier(f.label)}
                  // transition-all (not transition-colors) so a metric toggle
                  // or chain-filter change — which move `left`/`width` via the
                  // scaled pct, not just recolor the fill — animate smoothly
                  // instead of snapping. Only 10 tiles, changing on discrete
                  // clicks/toggles rather than continuously, so animating
                  // left/width here costs a handful of layout passes total,
                  // not a per-frame cost — cheap enough to not be a real
                  // performance concern. hover/active scale is a transform
                  // (compositor-only, no layout at all) for the interactive
                  // feedback layer specifically.
                  className={`group absolute inset-0 rounded-lg border text-left transition-all duration-300 ease-out hover:scale-[1.02] active:scale-[0.99] ${
                    isSelected ? "scale-[1.015] ring-2 ring-offset-1 ring-offset-background"
                    : isHoveredCounterpart ? "ring-1"
                    : (dimmedByHover || dimmedBySidePivot || dimmedByWalletDrill) ? "opacity-30"
                    : selected || selectedSideTile ? "opacity-70 hover:opacity-100"
                    : "hover:shadow-md"
                  }`}
                  style={{
                    borderColor: isSelected || isHoveredCounterpart
                      ? fill
                      : (dimmedByHover || dimmedBySidePivot || dimmedByWalletDrill)
                        ? "hsl(var(--border) / 0.3)"
                        : "hsl(var(--border) / 0.6)",
                    background: isSelected ? tintFill(fill, 0.22) : "hsl(var(--card))",
                    ["--tw-ring-color" as string]: fill,
                  }}
                >
                  <div className="h-full w-full relative overflow-hidden rounded-lg">
                    <div className="absolute inset-0 rounded-lg transition-colors duration-300" style={{ background: fill, opacity: isSelected ? 0.28 : 0.22 }} />
                    {/* Label pinned left; total + signed net pinned right,
                        with a real gap (ml-2) before the chevron so the
                        number doesn't read as "attached to the chevron" the
                        way flush-right-with-no-gap did before. Abandoned
                        absolute-centering the value in the tile: on narrow
                        tiles a truncated label plus a pill-boxed centered
                        value read as two disconnected chips glued together,
                        not one clean row — plain flex with real spacing beats
                        fighting the layout to force a literal center point.
                        Net (cur - prev, snapshot truth per lessons.md's
                        "never derive net from summed gross flows") is a
                        second, smaller figure appended after the total,
                        signed and colored strict green/red — never the
                        verdict-based amber colorForVerdict can produce, to
                        match the green-positive/red-negative language used
                        everywhere else on this page (HolderGrowthWidget,
                        HolderKpiHero). */}
                    <div className="relative h-full flex items-center px-2 gap-1.5 sm:gap-2 min-w-0">
                      <span className="text-[13px] sm:text-sm font-semibold truncate shrink min-w-0" title={tierDisplayLabel(f.label)}>{tierDisplayLabel(f.label)}</span>
                      <span className="ml-auto flex items-center gap-1.5 shrink-0">
                        <span className="text-sm font-bold tabular-nums whitespace-nowrap">{isWallets ? fmtInt(cur) : fmtTel(cur)}</span>
                        {prev != null && cur !== prev && (
                          <span
                            className="text-xs font-semibold tabular-nums whitespace-nowrap"
                            style={{ color: cur > prev ? POSITIVE_TEXT : NEGATIVE_TEXT }}
                          >
                            {cur > prev ? "+" : "−"}{isWallets ? fmtInt(Math.abs(cur - prev)) : fmtTel(Math.abs(cur - prev))}
                          </span>
                        )}
                      </span>
                      {/* Persistent, low-opacity "this opens something"
                          affordance — visible before any tile is ever
                          clicked, not just discoverable by accident hover. */}
                      <ChevronRight
                        className={`hidden sm:block h-3.5 w-3.5 shrink-0 ml-1 transition-opacity ${isSelected ? "opacity-0" : "opacity-40 group-hover:opacity-90"}`}
                        aria-hidden="true"
                      />
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
                    the snapshot-truth net shown inside the bar — a tier can
                    show "-8 out / +12 in" outside while its net (shown
                    inside) is what actually moved the total. */}
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
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-full text-[13px] font-bold tabular-nums" style={{ color: POSITIVE }}>
                    <ExplainNumber
                      value={`+${fmtInt(f.addedCount)}`}
                      explanation={addedTickExplanation(f)}
                      ariaLabel={`+${fmtInt(f.addedCount)} wallet${f.addedCount === 1 ? "" : "s"} arrived into ${tierDisplayLabel(f.label)}. Explain`}
                      className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center px-1"
                    />
                  </span>
                )}
                {isWallets && f.removedCount > 0 && (
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-full text-[13px] font-bold tabular-nums" style={{ color: NEGATIVE }}>
                    <ExplainNumber
                      value={`−${fmtInt(f.removedCount)}`}
                      explanation={removedTickExplanation(f)}
                      ariaLabel={`${fmtInt(f.removedCount)} wallet${f.removedCount === 1 ? "" : "s"} left ${tierDisplayLabel(f.label)}. Explain`}
                      className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center px-1"
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
      )}

      {detailNode &&
        (isTerminal ? (
          detailContainer ? createPortal(<div className="terminal-detail">{detailNode}</div>, detailContainer) : null
        ) : (
          <div ref={inlineDetailRef} className="scroll-mt-48" data-testid="tier-flow-detail">
            {detailNode}
          </div>
        ))}

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
            {tierDisplayLabel(f.label)}: {f.row?.count ?? 0} holders, {f.row?.totalBalance ?? 0} TEL.{" "}
            Holder change: {f.row?.previousCount != null ? (f.row.count - f.row.previousCount) : (suppressedNote?.count ?? "no baseline")}.{" "}
            TEL change: {f.row?.previousTotalBalance != null ? (f.row.totalBalance - f.row.previousTotalBalance) : (suppressedNote?.balance ?? "no baseline")}.
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
    fill={color}
    textAnchor="middle"
    dominantBaseline="middle"
    fontSize={12}
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
const FlowPath = ({ d, color, width }: { d: string; color: string; width: number }) => {
  const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  return (
    <>
      <path d={d} fill="none" stroke={color} strokeOpacity={0.55} strokeWidth={width} strokeLinecap="round" className="flow-line-draw" />
      {!reducedMotion && (
        <circle r={Math.max(2, width / 2)} fill={color}>
          <animateMotion dur="1.6s" repeatCount="indefinite" path={d} />
        </circle>
      )}
    </>
  );
};

// Wraps any figure so clicking it pops a small bubble explaining what that
// specific number means — click, not hover, so touch users get the same
// affordance as mouse users (matches the tier-tile click convention already
// used elsewhere in this diagram). Styled as a dotted-underline inline button
// so it reads as interactive without adding visual weight to the numbers.
const ExplainNumber = ({
  value,
  explanation,
  ariaLabel,
  className = "",
}: {
  value: ReactNode;
  explanation: string;
  ariaLabel?: string;
  className?: string;
}) => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        type="button"
        onClick={(e) => e.stopPropagation()}
        aria-label={ariaLabel}
        className={`${className} underline decoration-dotted decoration-current/50 underline-offset-2 rounded-sm hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
      >
        {value}
      </button>
    </PopoverTrigger>
    <PopoverContent className="w-64 text-xs leading-relaxed" onClick={(e) => e.stopPropagation()}>
      {explanation}
    </PopoverContent>
  </Popover>
);

const FlowSkeleton = ({ terminal = false }: { terminal?: boolean }) => (
  <div role="status" aria-label="Loading tier flows" className={terminal ? "flex h-full flex-col gap-2" : "space-y-3"}>
    <div className="h-4 w-40 rounded bg-muted/40 animate-pulse" />
    <div
      className={`rounded-xl border border-border/50 bg-muted/20 animate-pulse mx-auto ${terminal ? "w-full flex-1" : ""}`}
      style={terminal ? undefined : { width: CANVAS_W, maxWidth: "100%", height: CANVAS_H }}
    />
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
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  const label = SIDE_TILE_LABELS[selection.side][selection.key];
  const color = selection.key === "wallet" ? NEUTRAL : selection.side === "in" ? POSITIVE : NEGATIVE;
  const rows = sideTileContributions(fields, selection.side, selection.key);
  const total = rows.reduce((s, r) => s + r.value, 0);

  return (
    <div className="mx-auto max-w-lg space-y-3 premium-surface-card p-4 animate-scale-in">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-bold text-foreground">{label}</span>
        <span className="text-sm font-semibold tabular-nums" style={{ color }}>
          {total > 0 ? fmtTel(total) : "—"} TEL
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
                <div
                  role="presentation"
                  onMouseEnter={() => onHoverTier(r.label)}
                  onMouseLeave={() => onHoverTier(null)}
                  className={`w-full rounded-md px-2 py-1.5 flex items-center gap-2 transition-colors ${active ? "bg-muted/50" : "hover:bg-muted/40"}`}
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

const WalletsPanel = ({ field, baselineDate, noBaselineText = null, crossingsWindow = null, expandedFlow, onToggleFlow, onHoverFlow }: { field: TierField; baselineDate: string | null; noBaselineText?: string | null; crossingsWindow?: { from: string; to: string } | null; expandedFlow: string | null; onToggleFlow: (key: string) => void; onHoverFlow: (key: string | null) => void }) => {
  // The crossing counts and the snapshot net only reconcile when they cover
  // the same dates; otherwise comparing them would be arithmetic across two
  // different periods, so the reconciliation sentence is dropped.
  const comparable = !!crossingsWindow && !!baselineDate && crossingsWindow.from === baselineDate;
  const windowLabel = crossingsWindow ? `${fmtDay(crossingsWindow.from)} → ${fmtDay(crossingsWindow.to)}` : null;
  const { row } = field;
  const netWallets = row?.previousCount != null ? (row.count - row.previousCount) : null;
  const gained = field.migrations.filter((m) => m.gained);
  const lost = field.migrations.filter((m) => !m.gained);
  const gainedUp = gained.filter((m) => m.up).reduce((s, m) => s + m.count, 0);
  const gainedDown = gained.filter((m) => !m.up).reduce((s, m) => s + m.count, 0);
  const lostUp = lost.filter((m) => m.up).reduce((s, m) => s + m.count, 0);
  const lostDown = lost.filter((m) => !m.up).reduce((s, m) => s + m.count, 0);
  const nets = netMigrationsFor(field.migrations);
  // What the tier-to-tier crossings alone add up to — deliberately NOT the
  // same quantity as netWallets (snapshot truth), which also counts wallets
  // that appeared or emptied out without crossing any boundary.
  const crossingNet = (gainedUp + gainedDown) - (lostUp + lostDown);

  const narrative = walletNarrativeFor(
    field.label,
    netWallets,
    { gainedUp, gainedDown, lostUp, lostDown },
    field.verdict,
    field.cause,
    { comparable, windowLabel },
  );

  return (
    <div className="mx-auto max-w-lg space-y-3 premium-surface-card p-4 animate-scale-in">
      <div className="flex items-baseline justify-between">
        <span className="font-bold text-foreground">{tierDisplayLabel(field.label)}</span>
        <span className="text-xs text-muted-foreground">{row ? `${fmtInt(row.count)} holders` : "—"}</span>
      </div>

      <div className="text-center text-sm text-muted-foreground">
        Net (vs {baselineLabel(baselineDate)}):{" "}
        {netWallets != null
          ? (
            <span className={netWallets >= 0 ? "text-emerald-700 dark:text-emerald-400 font-semibold" : "text-red-700 dark:text-red-400 font-semibold"}>
              <ExplainNumber
                value={`${signed(netWallets, fmtInt)} wallets`}
                explanation={`Change in holder count for ${field.label} vs the ${baselineLabel(baselineDate, "prior")} snapshot (includes wallets that appeared or emptied without crossing a tier boundary).`}
              />
            </span>
          )
          : (noBaselineText ?? "no baseline")}
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
              const tone = n.net === 0 ? undefined : n.net > 0 ? POSITIVE : colorForVerdict(field.verdict);
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
                    className="w-full rounded-md px-2 py-1 flex items-center justify-between gap-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="text-muted-foreground">{tierDisplayLabel(n.counterpart)}</span>
                    <span className="font-semibold tabular-nums" style={{ color: tone }}>
                      {n.net === 0 ? <span className="text-muted-foreground">no net change</span> : signed(n.net, fmtInt)}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-2 pb-1 text-xs text-muted-foreground leading-relaxed">
                      <span className="tabular-nums font-semibold" style={{ color: POSITIVE }}>+{fmtInt(n.gained)}</span> arrived from {n.counterpart}
                      {" · "}
                      <span className="tabular-nums font-semibold" style={{ color: colorForVerdict(field.verdict) }}>−{fmtInt(n.lost)}</span> left for {n.counterpart}
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
          {comparable && netWallets != null && netWallets !== crossingNet && (
            <p className="mt-1.5 px-2 text-xs text-muted-foreground/80 leading-relaxed">
              These crossings net to {signed(crossingNet, fmtInt)}, not the {signed(netWallets, fmtInt)} above — the other {signed(netWallets - crossingNet, fmtInt)} is wallets that appeared or emptied out entirely, without crossing a tier line.
            </p>
          )}
        </div>
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
            <span>{fmtTel(v)} TEL</span>
          </li>
        ))}
        <li className="flex items-center justify-between gap-2 tabular-nums text-muted-foreground">
          <span>Untracked (no tier on counterparty)</span>
          <span>{fmtTel(untracked)} TEL</span>
        </li>
      </ul>
    );
  };

  if (chain !== "all") {
    return (
      <span className="opacity-80">
        Counterparty-tier attribution isn't available under a specific chain filter — switch to "All chains" to see which tiers this TEL came from or went to.
        {" "}"Other wallets" also includes addresses that hold no TEL balance of their own.
      </span>
    );
  }

  return (
    <div className="opacity-90">
      {attributedDays === 0 ? (
        <span className="opacity-80">
          No counterparty-tier attribution exists for this window yet — it's a new pipeline feature that accrues going forward, so every wallet-to-wallet TEL amount below currently reads as untracked.
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
      <span className="opacity-80 block mt-1">"Other wallets" also includes addresses that hold no TEL balance of their own.</span>
    </div>
  );
};

const TelPanel = ({ field, baselineDate, noBaselineText = null, expandedFlow, onToggleFlow, onHoverFlow, chain, attributedDays, totalDays, sourceTierSince }: {
  field: TierField; baselineDate: string | null; noBaselineText?: string | null; expandedFlow: string | null; onToggleFlow: (key: string) => void; onHoverFlow: (key: string | null) => void;
  chain: ChainKey; attributedDays: number; totalDays: number; sourceTierSince: string | null;
}) => {
  const { cause, row } = field;
  const netTel = row?.previousTotalBalance != null ? (row.totalBalance - row.previousTotalBalance) : null;
  const narrative = telNarrativeFor(field.label, netTel, cause);
  const nets = netCausesFor(cause);
  const hasAnyFlow = cause.hasData || cause.hasInData;

  return (
    <div className="mx-auto max-w-lg space-y-3 premium-surface-card p-4 animate-scale-in">
      <div className="flex items-baseline justify-between">
        <span className="font-bold text-foreground">{tierDisplayLabel(field.label)}</span>
        <span className="text-xs text-muted-foreground">{row ? `${fmtTel(row.totalBalance)} TEL` : "—"}</span>
      </div>

      <div className="text-center text-sm text-muted-foreground">
        Net (vs {baselineLabel(baselineDate)}):{" "}
        {netTel != null
          ? <span className={netTel >= 0 ? "text-emerald-700 dark:text-emerald-400 font-semibold" : "text-red-700 dark:text-red-400 font-semibold"}>{signed(netTel, fmtTel)} TEL</span>
          : (noBaselineText ?? "no baseline")}
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
                    className="w-full rounded-md px-2 py-1 flex items-center justify-between gap-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="text-muted-foreground">{c.label}</span>
                    <span className="font-semibold tabular-nums" style={{ color: colorForTone(c.tone) }}>
                      {c.net === 0 ? <span className="text-muted-foreground">no net flow</span> : `${signed(c.net, fmtTel)} TEL`}
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
    </div>
  );
};

// Phrase for wallets that shrank *out of* this tier, keyed off the same
// sold-vs-relocated verdict that colors the down-ticks and migration lines.
const shrinkCauseClause = (verdict: TierField["verdict"], hasOutflowData: boolean): string => {
  if (!hasOutflowData || verdict === "unknown") return "";
  if (verdict === "sold") {
    return " — this tier's TEL outflows were mostly sales (DEX or exchange deposits)";
  }
  return " — this tier's TEL outflows were mostly wallet-to-wallet moves, not sales";
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
    return ` — this tier's TEL inflows were mostly real demand (${demandPct.toFixed(0)}% DEX buys or exchange withdrawals)`;
  }
  const walletPct = (cause.receivedWallet / cause.inTotal) * 100;
  return ` — this tier's TEL inflows were mostly wallet transfers (${walletPct.toFixed(0)}%), not fresh buys`;
};

// Plain-language analysis of tier-to-tier wallet crossings. Counts are still
// crossings (not per-wallet txs); cause wording reuses this tier's TEL
// verdict / inflow mix — the same signal that colors the lines — rather than
// hedging every shrink with "likely a sale or splitting funds."
const walletNarrativeFor = (
  tier: string,
  netWallets: number | null,
  { gainedUp, gainedDown, lostUp, lostDown }: { gainedUp: number; gainedDown: number; lostUp: number; lostDown: number },
  verdict: TierField["verdict"],
  cause: Cause,
  { comparable = true, windowLabel = null }: { comparable?: boolean; windowLabel?: string | null } = {},
): string | null => {
  const gainedTotal = gainedUp + gainedDown;
  const period = windowLabel ? `between ${windowLabel.replace(" → ", " and ")}` : "this period";
  const lostTotal = lostUp + lostDown;
  if (gainedTotal === 0 && lostTotal === 0) {
    return netWallets ? `${tier} had a net ${signed(netWallets, fmtInt)} wallets this period — that came from wallets appearing or disappearing entirely (new holders or fully cashed-out ones), not from wallets crossing in or out of this tier.` : null;
  }

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
  // Crossings alone never explain the tier's whole change: a wallet can also
  // appear from nothing or empty out completely without ever crossing a tier
  // line. Stating the crossing net, the real snapshot net, AND the gap keeps
  // the three figures from looking like arithmetic that doesn't add up.
  const crossingNet = gainedTotal - lostTotal;
  if (!comparable && netWallets != null) {
    // Different dates from the snapshot net above: don't reconcile them.
    sentences.push(`Those crossings net to ${signed(crossingNet, fmtInt)} wallets ${period}.`);
  } else if (netWallets == null) {
    sentences.push(`Those crossings net to ${signed(crossingNet, fmtInt)} wallets — there's no baseline snapshot for this period to compare the tier's overall count against.`);
  } else {
    const gap = netWallets - crossingNet;
    sentences.push(
      gap === 0
        ? `Those crossings net to ${signed(crossingNet, fmtInt)} wallets, which is exactly how much the tier's holder count moved.`
        : `Those crossings net to ${signed(crossingNet, fmtInt)} wallets, while the tier's holder count actually moved ${signed(netWallets, fmtInt)} — the ${signed(gap, fmtInt)} difference is wallets that appeared or emptied out entirely rather than crossing a tier boundary.`,
    );
  }
  return sentences.join(" ");
};

// One analytical sentence per tier scenario, with real numbers filled in —
// the plain-language counterpart to the segmented bars above, for a reader
// who wants the takeaway without parsing a stacked breakdown. Covers every
// combination the data can actually produce: accumulated (with/without a
// source breakdown yet), net outflow dominated by real sales, net outflow
// that's mostly redistribution, and the no-data case.
const telNarrativeFor = (tier: string, netTel: number | null, cause: Cause): string | null => {
  // Net comes ONLY from snapshot truth (cur − prev). It must never fall back to
  // `cause.inTotal - cause.total`: those are GROSS flow totals, and a
  // same-tier wallet-to-wallet transfer lands in both, so the difference can be
  // wrong in magnitude AND sign. Deriving a net from summed gross flows is the
  // one thing lessons.md forbids — and with no baseline the panel header two
  // lines up already says "no baseline", so quoting a net here contradicted it.
  if (netTel == null) return null;
  const net = netTel;
  if (net === 0 && !cause.hasData && !cause.hasInData) return null;

  if (net > 0) {
    if (cause.hasInData && cause.inTotal > 0) {
      const demandPct = ((cause.boughtDex + cause.boughtCex) / cause.inTotal) * 100;
      const walletPct = (cause.receivedWallet / cause.inTotal) * 100;
      const lede = demandPct >= 50
        ? `most of it real demand — ${demandPct.toFixed(0)}% was bought on a DEX or withdrawn from an exchange`
        : `mostly wallets repositioning — ${walletPct.toFixed(0)}% simply arrived from other wallets, only ${demandPct.toFixed(0)}% was a fresh DEX buy or exchange withdrawal`;
      return `${tier} accumulated a net ${fmtTel(net)} TEL over this period, ${lede}.`;
    }
    return `${tier} accumulated a net ${fmtTel(net)} TEL over this period — the on-chain source breakdown is still backfilling.`;
  }

  if (cause.hasData && cause.total > 0) {
    // Match useFlowField verdict: moved >= sold → relocated (so sales only
    // when soldPct > 50, not on a 50/50 tie).
    const soldPct = cause.soldPct;
    return soldPct > 50
      ? `${tier} had a net outflow of ${fmtTel(Math.abs(net))} TEL, and ${soldPct.toFixed(0)}% of what left actually reached the market — sold on a DEX or deposited to an exchange.`
      : `${tier} had a net outflow of ${fmtTel(Math.abs(net))} TEL, but only ${soldPct.toFixed(0)}% of what left actually reached the market — the rest was just relocated to other wallets, still held.`;
  }

  return net < 0 ? `${tier} had a net outflow of ${fmtTel(Math.abs(net))} TEL over this period.` : null;
};
