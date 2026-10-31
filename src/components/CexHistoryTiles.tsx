import { useMemo, useState } from "react";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { LineChart, Line, XAxis, YAxis } from "recharts";
import { computeYAxisFromRows } from "@/lib/chartAxes";
import "@/lib/rechartsMotion";
import { ChevronDown, ChevronUp } from "lucide-react";
import { ZoomFrame } from "@/components/chart/ZoomFrame";
import { useChartZoom } from "@/hooks/useChartZoom";
import { useCexBalanceHistory } from "@/hooks/useCexBalanceHistory";
import { buildCexHistoryTiles, MIN_CEX_TILE_BALANCE } from "@/components/buildCexHistoryTiles";
import { ChangeIndicator } from "@/components/ChangeIndicator";
import { useClassificationChangelog, getEventsAffecting } from "@/hooks/useClassificationChangelog";

export { MIN_CEX_TILE_BALANCE } from "@/components/buildCexHistoryTiles";

const formatCompactAmount = (value: number) => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return `${Math.round(value)}`;
};

const tileChartConfig = (ticker: string) => ({
  balance: {
    label: `${ticker} Balance`,
    color: "hsl(var(--primary))",
  },
});

type CexHistoryTilesProps = {
  rangeDays: number;
};

/**
 * Tiles shown before the reader asks for the rest. buildCexHistoryTiles sorts
 * descending by current balance, so these are always the exchanges that hold
 * the most TEL — the long tail below them is real but rarely what someone came
 * to see, and on a phone the grid is one column, so ~15 tiles was ~2000px of
 * scroll before the footnote.
 */
const DEFAULT_VISIBLE_TILES = 6;

type TileRow = { timestamp: number; balance: number };

/** One exchange's balance sparkline, with the shared zoom gestures. */
const CexSparkline = ({ series, ticker }: { series: TileRow[]; ticker: string }) => {
  const zoom = useChartZoom(series, (d) => d.timestamp);
  const chartConfig = useMemo(() => tileChartConfig(ticker), [ticker]);
  // Hidden axis, but still fitted to the visible window so a flat balance isn't drawn as a cliff or a void.
  const yScale = useMemo(() => computeYAxisFromRows(zoom.rows, ["balance"], { kind: "line", allowNegative: false }), [zoom.rows]);
  return (
    <ZoomFrame zoom={zoom} className="h-20 w-full">
      <ChartContainer config={chartConfig} className="h-full w-full aspect-auto">
                <LineChart data={zoom.rows} margin={{ top: 2, right: 2, bottom: 0, left: 2 }} accessibilityLayer>
                  <XAxis dataKey="timestamp" type="number" domain={["dataMin", "dataMax"]} scale="time" hide />
                  <YAxis hide domain={yScale.domain} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) => {
                          const ts = payload?.[0]?.payload?.timestamp;
                          return ts ? new Date(ts).toLocaleDateString(undefined, { timeZone: "UTC" }) : "";
                        }}
                        formatter={(value) => [`${formatCompactAmount(Number(value))} ${ticker}`, "Balance"]}
                      />
                    }
                  />
                  <Line
                    dataKey="balance"
                    type="monotone"
                    stroke="var(--color-balance)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ChartContainer>
    </ZoomFrame>
  );
};

export const CexHistoryTiles = ({ rangeDays }: CexHistoryTilesProps) => {
  const { data: entries } = useCexBalanceHistory();
  const { data: changelog } = useClassificationChangelog();
  const [showAll, setShowAll] = useState(false);
  const { ticker } = useProjectCopy();

  const tiles = useMemo(
    () => buildCexHistoryTiles(entries, rangeDays),
    [entries, rangeDays],
  );

  // A reclassification (e.g. the 2026-08-08 KuCoin vault relabel) between a
  // tile's baseline point and now means its change conflates real inflow
  // with a bookkeeping move — see ChangeIndicator's changelogEvents doc.
  // Per-tile because each exchange's own series' baseline date can differ
  // (shorter series near the archive's start).
  const nowMs = Date.now();
  const cexEventsByTile = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getEventsAffecting>>();
    for (const tile of tiles) {
      const baselineTs = tile.series[0]?.timestamp;
      map.set(
        tile.name,
        Number.isFinite(baselineTs) ? getEventsAffecting(changelog, "cexBalance", baselineTs, nowMs) : [],
      );
    }
    return map;
  }, [tiles, changelog, nowMs]);

  if (tiles.length === 0) return null;

  const hidden = Math.max(0, tiles.length - DEFAULT_VISIBLE_TILES);
  const visibleTiles = showAll ? tiles : tiles.slice(0, DEFAULT_VISIBLE_TILES);
  // How much of the exchange book the shown tiles actually account for, so
  // collapsing the tail is honest rather than silently partial.
  const shownShare = (() => {
    const total = tiles.reduce((sum, t) => sum + t.current, 0);
    if (total <= 0) return null;
    return (visibleTiles.reduce((sum, t) => sum + t.current, 0) / total) * 100;
  })();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
          Exchange Balance History
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visibleTiles.map((tile) => {
          const events = cexEventsByTile.get(tile.name) ?? [];
          return (
          <div
            key={tile.name}
            className="premium-surface-card p-4"
          >
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <span className="text-sm font-medium text-foreground truncate">{tile.name}</span>
              <span className="text-sm text-muted-foreground tabular-nums whitespace-nowrap">
                {formatCompactAmount(tile.current)} {ticker}
                {tile.change !== null && events.length > 0 ? (
                  <span className="ml-1.5 inline-flex align-middle">
                    <ChangeIndicator
                      current={tile.current}
                      previous={tile.current - tile.change}
                      changelogEvents={events}
                      size="sm"
                    />
                  </span>
                ) : (
                  /* Same polarity as Exchange Netflow / the exchange table
                     above: MORE on the exchange (potential sell pressure) is
                     red, LESS (leaving for self-custody) is green — kept
                     consistent across this whole card. */
                  tile.change !== null && (
                    <span
                      className={`ml-1.5 text-xs ${
                        tile.change > 0
                          ? "text-negative"
                          : tile.change < 0
                            ? "text-positive"
                            : "text-muted-foreground"
                      }`}
                    >
                      {tile.change >= 0 ? "+" : "-"}
                      {formatCompactAmount(Math.abs(tile.change))}
                    </span>
                  )
                )}
              </span>
            </div>
            <CexSparkline series={tile.series} ticker={ticker} />
          </div>
          );
        })}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((prev) => !prev)}
          className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-full border border-border/60 bg-card/80 px-4 text-xs font-semibold text-muted-foreground transition-colors hover:text-primary sm:w-auto"
        >
          {showAll ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              Show top {DEFAULT_VISIBLE_TILES} only
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              Show {hidden} smaller {hidden === 1 ? "exchange" : "exchanges"}
            </>
          )}
        </button>
      )}
      <p className="text-xs text-muted-foreground">
        Daily {ticker} held in known wallets per exchange. History begins Jan 2026.
        {hidden > 0 && !showAll && shownShare !== null
          ? ` Showing the ${DEFAULT_VISIBLE_TILES} largest, ${shownShare.toFixed(1)}% of tracked exchange balance.`
          : ""}
        Exchanges holding under {MIN_CEX_TILE_BALANCE.toLocaleString()} {ticker} are omitted here (still listed in the table above).
      </p>
    </div>
  );
};
