import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DisplaySelection, HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { useHolderHistoricalDelta } from "@/hooks/useHolderHistoricalDelta";
import { TierFlowDiagram, type TierMetric } from "@/components/TierFlowDiagram";
import { tierDisplayLabel } from "@/components/tierflow/geometry";
import { mergeDistributionBaseline, summarizeTierGrowth } from "@/lib/distributionRows";
import { RANGE_OPTIONS } from "@/lib/timeRange";
import { formatCompact } from "@/lib/format";
import { TerminalPanel, PanelMessage, PanelSkeleton, Delta } from "./TerminalPanel";

const int = new Intl.NumberFormat("en-US");

type Props = {
  snapshot: HolderLiteSnapshot | undefined;
  snapshotError: boolean;
  selectedView: DisplaySelection;
  rangeDays: number;
  onViewChange: (v: DisplaySelection) => void;
};

export const DistributionTerminal = ({ snapshot, snapshotError, selectedView, rangeDays, onViewChange }: Props) => {
  const { data: historicalDelta } = useHolderHistoricalDelta({ view: selectedView, days: rangeDays, enabled: rangeDays >= 1 });
  const [metric, setMetric] = useState<TierMetric>("wallets");
  const view = snapshot?.views[selectedView];
  const rows = useMemo(
    () => mergeDistributionBaseline(view?.distribution ?? [], historicalDelta?.distribution ?? null),
    [view, historicalDelta],
  );
  const growth = summarizeTierGrowth(rows);
  const rangeLabel = RANGE_OPTIONS.find((o) => o.days === rangeDays)?.label ?? `${rangeDays}D`;
  const flowAvailable = selectedView === "combined" && rangeDays >= 1;

  const netByTier = rows.map((r) => ({
    name: tierDisplayLabel(r.label),
    value: r.previousCount != null ? r.count - r.previousCount : 0,
    has: r.previousCount != null,
  }));

  const placeholder = !snapshot ? (snapshotError ? <PanelMessage>Snapshot unavailable.</PanelMessage> : <PanelSkeleton />) : null;

  return (
    <div className="grid h-full min-h-0 grid-cols-12 grid-rows-2 gap-2" data-testid="distribution-terminal">
      <TerminalPanel
        className="col-span-7 row-span-2"
        title="Tier flows"
        info="Each bar is a retail balance tier. Hover or select a tier to see where its wallets and TEL came from and went to over the period. Retail only; sub-1-TEL dust wallets are counted in the lowest tier."
        stat={
          growth.tiers > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                {growth.grew} of {growth.tiers}
              </span>{" "}
              tiers gained wallets · <Delta value={growth.netWallets} format={(n) => int.format(n)} /> net over {rangeLabel}
            </span>
          )
        }
      >
        {placeholder ??
          (flowAvailable ? (
            <TierFlowDiagram
              rangeDays={rangeDays}
              metric={metric}
              onMetricChange={setMetric}
              baselineDate={historicalDelta?.referenceDate ?? null}
              rows={rows.map((r) => ({
                label: r.label,
                count: r.count ?? 0,
                totalBalance: r.totalBalance ?? 0,
                previousCount: r.previousCount ?? null,
                previousTotalBalance: r.previousTotalBalance ?? null,
              }))}
            />
          ) : (
            <PanelMessage>
              <span>
                Tier flows are tracked for all chains combined.{" "}
                <button type="button" className="font-semibold text-primary underline" onClick={() => onViewChange("combined")}>
                  View all chains
                </button>
              </span>
            </PanelMessage>
          ))}
      </TerminalPanel>

      <TerminalPanel
        className="col-span-5"
        title="Net wallet change by tier"
        info="Retail wallets in each tier now, minus at the start of the period."
      >
        {placeholder ??
          (netByTier.some((d) => d.has) ? (
            <div
              role="img"
              aria-label={`Net wallet change by tier: ${netByTier.map((d) => `${d.name} ${d.value >= 0 ? "+" : ""}${int.format(d.value)}`).join(", ")}.`}
              className="h-full w-full"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={netByTier} layout="vertical" margin={{ top: 2, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.6} />
                  <XAxis type="number" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompact(v, 1)} />
                  <YAxis type="category" dataKey="name" width={72} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickLine={false} axisLine={false} interval={0} />
                  <Tooltip
                    cursor={{ fill: "hsl(var(--muted))" }}
                    formatter={(v: number) => [`${v >= 0 ? "+" : ""}${int.format(v)}`, "Net wallets"]}
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 11 }}
                    labelStyle={{ color: "hsl(var(--popover-foreground))" }}
                    itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                  />
                  <Bar dataKey="value" isAnimationActive={false} radius={2}>
                    {netByTier.map((d) => (
                      <Cell key={d.name} fill={d.value >= 0 ? "hsl(var(--ha-positive))" : "hsl(var(--ha-negative))"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <PanelMessage>No baseline for this period yet.</PanelMessage>
          ))}
      </TerminalPanel>

      <TerminalPanel className="col-span-5" title="Tiers" info="Wallets and TEL per tier, with the change over the period, and each tier's share of retail TEL." flush>
        {placeholder ? (
          <div className="h-full p-2">{placeholder}</div>
        ) : (
          <table className="w-full text-xs tabular-nums">
            <caption className="sr-only">Retail wallets and TEL by balance tier</caption>
            <thead className="sticky top-0 bg-card text-[11px] text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1 text-left font-medium">Tier (TEL)</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Wallets</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Change</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">TEL</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Change</th>
                <th scope="col" className="px-3 py-1 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-border/50">
                  <th scope="row" className="whitespace-nowrap px-3 py-1 text-left font-medium">{tierDisplayLabel(r.label)}</th>
                  <td className="px-2 py-1 text-right">{int.format(r.count)}</td>
                  <td className="px-2 py-1 text-right">
                    <Delta value={r.previousCount != null ? r.count - r.previousCount : null} format={(n) => int.format(n)} />
                  </td>
                  <td className="px-2 py-1 text-right">{formatCompact(r.totalBalance)}</td>
                  <td className="px-2 py-1 text-right">
                    <Delta value={r.previousTotalBalance != null ? r.totalBalance - r.previousTotalBalance : null} format={(n) => formatCompact(n, 1)} />
                  </td>
                  <td className="px-3 py-1 text-right">{r.percent.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TerminalPanel>
    </div>
  );
};
