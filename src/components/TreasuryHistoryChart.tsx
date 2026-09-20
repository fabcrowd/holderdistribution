import { useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useTreasuryHistory } from "@/hooks/useTreasuryHistory";
import { computeSeriesDomain, activeKeys } from "@/lib/chartDomain";
import { formatChartTimestamp } from "@/lib/chartDate";
import { HOLDINGS_CATEGORY_KEYS } from "@/lib/supplyBreakdown";
import { InfoTooltip } from "@/components/InfoTooltip";

/**
 * Project-held balances over time, one line per group.
 *
 * ENTITY STRUCTURE — the thing this chart must never blur:
 *
 *   Telcoin Association  (umbrella)
 *     ├─ Treasury            category `treasury`  — the TEL Treasury address
 *     └─ TAO & Safes         category `council`   — TAO Safe / TAO Distribution /
 *                                                   TAO Implementation, the TAN,
 *                                                   TELx, Platform, Compliance and
 *                                                   Treasury Councils, and the
 *                                                   Developer / Staker / Validator /
 *                                                   Miner Safes
 *   Telcoin Holdings     (SEPARATE ENTITY)  category `holdings`
 *
 * Telcoin Association and Telcoin Holdings are DISTINCT ENTITIES and are never
 * summed into a combined "team" figure — see lessons.md. The two Association
 * lines are prefixed "Association — " precisely so splitting them cannot be
 * misread as two separate organisations, while Holdings stays unprefixed and
 * visibly apart.
 *
 * `treasury` and `council` used to share one "Association Safes" line. They are
 * different subsets of the same umbrella, so they are now plotted separately
 * and named for it. `treasury-history.json` has always stored them as separate
 * keys per date, so this is a rendering change only, with no pipeline re-run.
 *
 * ASSOCIATION_CATEGORY_KEYS also contains `staking-contract`, which
 * reconcile-supply.js never emits (it contributes 0, since staked TEL is
 * attributed to individual stakers instead). Splitting the series means it no
 * longer rides along silently inside a summed key; UNKNOWN_KEYS below asserts
 * that every category actually present in the data is plotted by exactly one
 * line, so a category that later becomes non-zero surfaces instead of vanishing.
 *
 * Note the pie above still groups Association = treasury + council, so the two
 * surfaces differ in granularity by design — the copy says so rather than
 * leaving a reader to reconcile 1.33B against 1.77B on one screen.
 */
const SERIES = {
  association: {
    label: "Association — Treasury",
    color: "hsl(262 83% 58%)",
    keys: ["treasury"] as readonly string[],
  },
  council: {
    label: "Association — TAO & Safes",
    color: "hsl(158 64% 42%)",
    keys: ["council"] as readonly string[],
  },
  holdings: {
    label: "Telcoin Holdings",
    color: "hsl(217 91% 60%)",
    keys: HOLDINGS_CATEGORY_KEYS as readonly string[],
  },
  escrow: {
    label: "Escrow",
    color: "hsl(28 90% 55%)",
    keys: ["escrow"] as readonly string[],
  },
} as const;

/** Categories deliberately not plotted: emitted as 0, or already counted elsewhere. */
const IGNORED_CATEGORY_KEYS: readonly string[] = ["staking-contract"];

type SeriesKey = keyof typeof SERIES;
type Mode = "balance" | "change";

const chartConfig = Object.fromEntries(
  (Object.keys(SERIES) as SeriesKey[]).map((k) => [k, { label: SERIES[k].label, color: SERIES[k].color }]),
);

const formatCompactTEL = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B TEL`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M TEL`;
  return `${new Intl.NumberFormat().format(Math.round(value))} TEL`;
};
const formatSignedTEL = (value: number) => {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatCompactTEL(Math.abs(value))}`;
};

export const TreasuryHistoryChart = ({ rangeDays }: { rangeDays: number }) => {
  const { data } = useTreasuryHistory();
  // Escrow off by default: at ~6.3B it is roughly two-thirds of the total and
  // flattens the other two, and it is third-party custody (BitGo, Anchorage)
  // rather than discretionary supply.
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    association: true,
    council: true,
    holdings: true,
    escrow: false,
  });
  const [mode, setMode] = useState<Mode>("balance");

  const points = useMemo(() => {
    const entries = data?.entries ?? [];
    if (entries.length === 0) return [];
    const rows = entries.map((entry) => {
      const sum = (keys: readonly string[]) =>
        keys.reduce((total, key) => total + (Number(entry.categories?.[key]) || 0), 0);
      // Built by iterating SERIES so adding a line cannot silently skip the
      // point builder — the drift that let treasury and council share one line.
      const row: Record<string, number> = { timestamp: Date.parse(entry.date) };
      for (const key of Object.keys(SERIES) as SeriesKey[]) {
        row[key] = sum(SERIES[key].keys);
      }
      return row;
    });
    // Every category present in the data must be plotted by exactly one series
    // or explicitly ignored. Previously `treasury` and `council` were summed
    // into one line, so a category could change meaning without anything
    // noticing; now that each line maps to a single key, a NEW category (or a
    // staking-contract balance that stops being ~0) would otherwise just
    // disappear from the chart. Warn rather than throw — a missing line is bad,
    // a blank Supply tab is worse.
    if (import.meta.env.DEV) {
      const plotted = new Set([
        ...Object.values(SERIES).flatMap((serie) => [...serie.keys]),
        ...IGNORED_CATEGORY_KEYS,
      ]);
      const unplotted = new Set<string>();
      for (const entry of entries) {
        for (const [key, value] of Object.entries(entry.categories ?? {})) {
          // 1 TEL, well above the float dust reconcile-supply.js emits for
          // staking-contract (~9.5e-7) but far below anything material.
          if (!plotted.has(key) && Math.abs(Number(value) || 0) > 1) unplotted.add(key);
        }
      }
      if (unplotted.size > 0) {
        console.warn(
          `TreasuryHistoryChart: category not plotted by any series: ${[...unplotted].join(", ")}`,
        );
      }
    }

    const latest = rows[rows.length - 1]?.timestamp;
    const cutoff = Number.isFinite(latest) ? latest - rangeDays * 86400000 : null;
    return cutoff === null ? rows : rows.filter((r) => r.timestamp >= cutoff);
  }, [data?.entries, rangeDays]);

  const display = useMemo(() => {
    if (mode === "balance" || points.length === 0) return points;
    const base = points[0];
    return points.map((p) => {
      const row: Record<string, number> = { timestamp: p.timestamp };
      for (const key of Object.keys(SERIES) as SeriesKey[]) {
        row[key] = p[key] - base[key];
      }
      return row;
    });
  }, [points, mode]);

  const domain = useMemo(
    () => computeSeriesDomain(display, activeKeys(visible), { allowNegative: mode === "change" }),
    [display, visible, mode],
  );

  if (!data || points.length < 2) return null;

  const fmt = mode === "change" ? formatSignedTEL : formatCompactTEL;
  const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
  const tipFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

  return (
    <div className="pt-5 mt-5 border-t border-border/40">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="font-medium text-foreground text-sm">Project-held balances over time</span>
        <InfoTooltip text={`Daily balances reconstructed from on-chain Transfer logs, one line per group.\n\nThe two "Association —" lines are subsets of ONE entity, the Telcoin Association: its Treasury address, and its TAO / council / ops Safes. The pie above combines them into a single Association bucket, so it shows one figure where this chart shows two.\n\nTelcoin Holdings is a SEPARATE entity, not part of the Association, and the two are never combined into a single figure.\n\nEscrow is third-party custody (BitGo, Anchorage) plus five assumed Holdings-funded vaults — not discretionary supply, and hidden by default because it dwarfs the rest.`} />
        <div className="inline-flex rounded-full border border-border/60 bg-card/80 p-0.5 ml-auto">
          {(["balance", "change"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`text-xs font-semibold rounded-full px-3 py-1 transition-colors ${
                mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-primary"
              }`}
            >
              {m === "balance" ? "Balance" : "Change"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        {(Object.keys(SERIES) as SeriesKey[]).map((key) => {
          const on = visible[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => setVisible((prev) => ({ ...prev, [key]: !prev[key] }))}
              className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                on ? "border-transparent text-white" : "border-border/60 text-muted-foreground hover:text-foreground"
              }`}
              style={on ? { backgroundColor: SERIES[key].color } : undefined}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: on ? "currentColor" : SERIES[key].color }}
              />
              {SERIES[key].label}
            </button>
          );
        })}
      </div>

      <div className="h-56 w-full">
        <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
          <LineChart data={display}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={(v) => formatChartTimestamp(v, dateFmt)}
              tickMargin={8}
            />
            <YAxis tickFormatter={(v) => fmt(Number(v))} domain={domain} tickMargin={8} width={56} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) =>
                    formatChartTimestamp(payload?.[0]?.payload?.timestamp, tipFmt)
                  }
                  formatter={(value, name) => [fmt(Number(value)), SERIES[name as SeriesKey]?.label ?? String(name)]}
                />
              }
            />
            {mode === "change" && <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />}
            {(Object.keys(SERIES) as SeriesKey[]).map((key) =>
              visible[key] ? (
                <Line
                  key={key}
                  dataKey={key}
                  type="monotone"
                  stroke={`var(--color-${key})`}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ) : null,
            )}
          </LineChart>
        </ChartContainer>
      </div>
    </div>
  );
};
