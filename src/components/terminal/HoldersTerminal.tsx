import { useMemo } from "react";
import { useHolderGrowth } from "@/hooks/useHolderGrowth";
import { useExchangeFlow } from "@/hooks/useExchangeFlow";
import { useCexBalanceHistory } from "@/hooks/useCexBalanceHistory";
import type { DisplaySelection, HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { formatCompact, formatSignedCompact } from "@/lib/format";
import { TerminalPanel, PanelMessage, PanelSkeleton, Delta } from "./TerminalPanel";
import { TimeChart, SignedBars, CategoryBars } from "./MiniCharts";
import { DetailsButton } from "./DetailsButton";

const DAY_MS = 86_400_000;
const int = new Intl.NumberFormat("en-US");
const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;

type Props = {
  snapshot: HolderLiteSnapshot | undefined;
  snapshotError: boolean;
  selectedView: DisplaySelection;
  rangeDays: number;
  onExplore: (panel: string) => void;
};

/** Points within `days` of the series' own last date (feeds can lag "now"). */
const withinRange = <T,>(rows: T[], getT: (r: T) => number, days: number): T[] => {
  if (!rows.length) return rows;
  const last = getT(rows[rows.length - 1]);
  const from = last - days * DAY_MS;
  return rows.filter((r) => getT(r) >= from);
};

const firstLast = <T,>(rows: T[]) => (rows.length ? { first: rows[0], last: rows[rows.length - 1] } : null);

export const HoldersTerminal = ({ snapshot, snapshotError, selectedView, rangeDays, onExplore }: Props) => {
  const growth = useHolderGrowth({ view: selectedView, days: rangeDays });
  const flow = useExchangeFlow();
  const cexHistory = useCexBalanceHistory();
  const isCombined = selectedView === "combined";
  const view = snapshot?.views[selectedView];

  const holders = useMemo(
    () => (growth.data?.series ?? []).map((p) => ({ t: Date.parse(p.timestamp), holders: p.holders })),
    [growth.data],
  );
  const balance = useMemo(
    () => (growth.data?.balanceSeries ?? []).map((p) => ({ t: Date.parse(p.timestamp), retail: p.retail, cex: p.cex })),
    [growth.data],
  );
  const staking = useMemo(
    () => (growth.data?.stakingSeries ?? []).map((p) => ({ t: Date.parse(p.timestamp), staking: p.staking })),
    [growth.data],
  );
  const netflow = useMemo(() => {
    const rows = (flow.data ?? []).map((e) => ({ t: Date.parse(e.date), value: e.net, in: e.in, out: e.out }));
    return withinRange(rows, (r) => r.t, Math.max(rangeDays, 1));
  }, [flow.data, rangeDays]);
  const flowTotals = netflow.reduce((a, r) => ({ in: a.in + r.in, out: a.out + r.out }), { in: 0, out: 0 });

  const exchanges = useMemo(() => {
    const entries = cexHistory.data ?? [];
    if (!entries.length) return [];
    const ranged = withinRange(entries, (e) => Date.parse(e.date), Math.max(rangeDays, 1));
    const latest = entries[entries.length - 1];
    const base = ranged[0] !== latest ? ranged[0] : null;
    return Object.entries(latest.exchanges)
      .map(([name, bal]) => ({ name, bal, delta: base ? bal - (base.exchanges[name] ?? 0) : null }))
      .filter((r) => r.bal > 0 || (r.delta ?? 0) !== 0)
      .sort((a, b) => b.bal - a.bal);
  }, [cexHistory.data, rangeDays]);
  const cexTotal = exchanges.reduce((s, r) => s + r.bal, 0);

  const h = firstLast(holders);
  const b = firstLast(balance);
  const s = firstLast(staking);
  const loading = growth.isLoading;
  const growthFailed = !!growth.error && !growth.data;

  const series = (content: React.ReactNode, has: boolean) =>
    loading ? <PanelSkeleton /> : growthFailed ? <PanelMessage>History feed unavailable.</PanelMessage> : has ? content : <PanelMessage>No data for this period.</PanelMessage>;

  const stats = view?.balanceStats;
  const buckets = stats?.distributionBuckets ?? [];
  const top = view?.concentration?.top ?? {};
  const prevTop = view?.concentration?.previousTop ?? {};
  const retailTotal = stats?.total ?? 0;

  return (
    <div className="grid h-full min-h-0 grid-cols-12 grid-rows-2 gap-2" data-testid="holders-terminal">
      <TerminalPanel
        className="col-span-4"
        title="Retail holders"
        info="Wallets holding at least 1 TEL, excluding exchange, DEX, contract and Telcoin-controlled wallets."
        stat={
          h && (
            <>
              <span className="font-semibold text-foreground">{int.format(h.last.holders)}</span>
              <Delta value={h.last.holders - h.first.holders} format={(n) => int.format(Math.round(n))} />
            </>
          )
        }
        actions={<DetailsButton onClick={() => onExplore("trends")} label="Retail holders" />}
      >
        {series(
          <TimeChart
            data={holders}
            series={[{ key: "holders", label: "Holders", color: "hsl(var(--primary))" }]}
            format={(n) => int.format(n)}
            label={h ? `Retail holders from ${int.format(h.first.holders)} to ${int.format(h.last.holders)} over the period.` : "Retail holders"}
          />,
          holders.length > 1,
        )}
      </TerminalPanel>

      <TerminalPanel
        className="col-span-4"
        title="TEL held"
        info="TEL in retail wallets compared with TEL in custody at known exchange wallets. All chains combined."
        stat={
          b && (
            <>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <span className="h-2 w-2 rounded-sm bg-primary" aria-hidden="true" />
                Retail <span className="font-semibold text-foreground">{formatCompact(b.last.retail)}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <span className="h-2 w-2 rounded-sm bg-[hsl(var(--ha-accent))]" aria-hidden="true" />
                CEX <span className="font-semibold text-foreground">{b.last.cex != null ? formatCompact(b.last.cex) : "—"}</span>
              </span>
            </>
          )
        }
        actions={<DetailsButton onClick={() => onExplore("balances")} label="TEL held" />}
      >
        {!isCombined ? (
          <PanelMessage>Available for all chains combined only.</PanelMessage>
        ) : (
          series(
            <TimeChart
              data={balance}
              series={[
                { key: "retail", label: "Retail", color: "hsl(var(--primary))" },
                { key: "cex", label: "Exchanges", color: "hsl(var(--ha-accent))" },
              ]}
              format={(n) => `${formatCompact(n)} TEL`}
              label={b ? `Retail TEL ${formatCompact(b.last.retail)}, exchange TEL ${b.last.cex != null ? formatCompact(b.last.cex) : "unknown"} at the end of the period.` : "TEL held"}
            />,
            balance.length > 1,
          )
        )}
      </TerminalPanel>

      <TerminalPanel
        className="col-span-4"
        title="Exchange net flow"
        info="Daily TEL deposited to minus withdrawn from known exchange wallets. A deposit is not necessarily a sale."
        stat={
          netflow.length > 0 && (
            <>
              <Delta value={flowTotals.in - flowTotals.out} format={(n) => formatCompact(n)} />
              <span className="text-[11px] text-muted-foreground">
                in {formatCompact(flowTotals.in)} · out {formatCompact(flowTotals.out)}
              </span>
            </>
          )
        }
        actions={<DetailsButton onClick={() => onExplore("flows")} label="Exchange flows" />}
      >
        {flow.isLoading ? (
          <PanelSkeleton />
        ) : flow.isError ? (
          <PanelMessage>Exchange flow feed unavailable.</PanelMessage>
        ) : netflow.length ? (
          <SignedBars
            data={netflow.map(({ t, value }) => ({ t, value }))}
            seriesLabel="Net to exchanges"
            format={(n) => `${formatSignedCompact(n)} TEL`}
            label={`Net exchange flow over the period: ${formatSignedCompact(flowTotals.in - flowTotals.out)} TEL.`}
          />
        ) : (
          <PanelMessage>No flow data for this period.</PanelMessage>
        )}
      </TerminalPanel>

      <TerminalPanel
        className="col-span-3"
        title="Staked TEL"
        info="Retail TEL locked in staking contracts. All chains combined."
        stat={
          s && (
            <>
              <span className="font-semibold text-foreground">{formatCompact(s.last.staking)}</span>
              <Delta value={s.last.staking - s.first.staking} format={(n) => formatCompact(n)} />
            </>
          )
        }
        actions={<DetailsButton onClick={() => onExplore("staking")} label="Staking" />}
      >
        {!isCombined ? (
          <PanelMessage>Available for all chains combined only.</PanelMessage>
        ) : (
          series(
            <TimeChart
              kind="area"
              data={staking}
              series={[{ key: "staking", label: "Staked", color: "hsl(var(--primary))" }]}
              format={(n) => `${formatCompact(n)} TEL`}
              label={s ? `Staked TEL ${formatCompact(s.last.staking)} at the end of the period.` : "Staked TEL"}
            />,
            staking.length > 1,
          )
        )}
      </TerminalPanel>

      <TerminalPanel
        className="col-span-3"
        title="Wallet sizes"
        info={`Retail wallets by balance (TEL). The gold bar contains the average balance${stats ? ` (${formatCompact(stats.average)} TEL)` : ""}.`}
        stat={
          stats && (
            <span className="text-[11px] text-muted-foreground">
              median <span className="font-semibold text-foreground">{formatCompact(stats.median)}</span>
            </span>
          )
        }
        actions={<DetailsButton onClick={() => onExplore("balances")} label="Wallet sizes" />}
      >
        {!snapshot ? (
          snapshotError ? <PanelMessage>Snapshot unavailable.</PanelMessage> : <PanelSkeleton />
        ) : buckets.length ? (
          <CategoryBars
            data={buckets.map((bk) => ({ name: bk.rangeLabel, value: bk.count, highlight: bk.rangeLabel === stats?.averageRangeLabel }))}
            format={(n) => int.format(n)}
            label={`Retail wallets by balance: ${buckets.map((bk) => `${bk.rangeLabel} ${int.format(bk.count)}`).join(", ")}.`}
          />
        ) : (
          <PanelMessage>No balance data.</PanelMessage>
        )}
      </TerminalPanel>

      <TerminalPanel
        className="col-span-3"
        title="Concentration"
        info="Share of retail TEL held by the largest N retail wallets. Change is against the previous snapshot."
        stat={stats && <span className="text-[11px] text-muted-foreground">Gini <span className="font-semibold text-foreground">{stats.gini.toFixed(3)}</span></span>}
        actions={<DetailsButton onClick={() => onExplore("concentration")} label="Concentration" />}
        flush
      >
        {!snapshot ? (
          <div className="h-full p-2">{snapshotError ? <PanelMessage>Snapshot unavailable.</PanelMessage> : <PanelSkeleton />}</div>
        ) : (
          <table className="w-full text-xs tabular-nums">
            <caption className="sr-only">Share of retail TEL held by the top wallets</caption>
            <thead className="sticky top-0 bg-card text-[11px] text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1 text-left font-medium">Top</th>
                <th scope="col" className="px-2 py-1 text-left font-medium">Share</th>
                <th scope="col" className="px-3 py-1 text-right font-medium">TEL</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(top)
                .sort((a, z) => Number(a[0]) - Number(z[0]))
                .map(([n, bal]) => {
                  const share = retailTotal > 0 ? (bal / retailTotal) * 100 : 0;
                  const prev = prevTop[n];
                  return (
                    <tr key={n} className="border-t border-border/50">
                      <th scope="row" className="px-3 py-1 text-left font-medium">{int.format(Number(n))}</th>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-full min-w-[3rem] overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(share, 100)}%` }} />
                          </div>
                          <span className="w-12 shrink-0 text-right">{pct(share)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-1 text-right">
                        <span className="mr-1.5">{formatCompact(bal)}</span>
                        <Delta value={prev != null ? bal - prev : null} format={(x) => formatCompact(x, 1)} />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </TerminalPanel>

      <TerminalPanel
        className="col-span-3"
        title="Exchange balances"
        info="TEL held at each exchange's known wallets, with the change over the selected period."
        stat={cexTotal > 0 && <span className="font-semibold text-foreground">{formatCompact(cexTotal)}</span>}
        actions={<DetailsButton onClick={() => onExplore("exchanges")} label="Exchange balances" />}
        flush
      >
        {cexHistory.isLoading ? (
          <div className="h-full p-2"><PanelSkeleton /></div>
        ) : cexHistory.isError ? (
          <PanelMessage>Exchange balance feed unavailable.</PanelMessage>
        ) : (
          <table className="w-full text-xs tabular-nums">
            <caption className="sr-only">TEL held per exchange</caption>
            <thead className="sticky top-0 bg-card text-[11px] text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1 text-left font-medium">Exchange</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">TEL</th>
                <th scope="col" className="px-3 py-1 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {exchanges.map((r) => (
                <tr key={r.name} className="border-t border-border/50">
                  <th scope="row" className="max-w-[8rem] truncate px-3 py-1 text-left font-medium" title={r.name}>{r.name}</th>
                  <td className="px-2 py-1 text-right">{formatCompact(r.bal)}</td>
                  <td className="px-3 py-1 text-right"><Delta value={r.delta} format={(x) => formatCompact(x, 1)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TerminalPanel>
    </div>
  );
};
