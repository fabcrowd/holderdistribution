import { useProject } from "@/hooks/useProject";
import { useMemo, useState } from "react";
import { useIntro } from "@/hooks/useMotion";
import { useClassificationChangelog, getEventsAffecting } from "@/hooks/useClassificationChangelog";
import { clampToRange, shortBucketLabel } from "@/lib/chartRange";
import { useHolderGrowth } from "@/hooks/useHolderGrowth";
import { useExchangeFlow } from "@/hooks/useExchangeFlow";
import { useCexBalanceHistory } from "@/hooks/useCexBalanceHistory";
import type { DisplaySelection, HolderLiteSnapshot } from "@/hooks/useHolderSnapshot";
import { formatCompact, formatSignedCompact } from "@/lib/format";
import { HOLDERS_PRIMARY_ROW_HEIGHT, SECONDARY_CHART_ROW_PX, TABLE_PANEL_PX } from "@/lib/terminalLayout";
import { TerminalPanel, PanelMessage, PanelError, PanelSkeleton, Delta } from "./TerminalPanel";
import { TimeChart, SignedBars, CategoryBars, type ChartMarker } from "./MiniCharts";
import { DetailsButton } from "./DetailsButton";
import { heldPanelTip } from "@/lib/heldPanelTip";
import { StakedPanelTip } from "./StakedPanelTip";
import { V3_STAKING_DEPLOY_DATE, v3StakingGapEvents } from "@/lib/staking";

const int = new Intl.NumberFormat("en-US");
const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;

type Props = {
  snapshot: HolderLiteSnapshot | undefined;
  snapshotError: boolean;
  selectedView: DisplaySelection;
  rangeDays: number;
  onExplore: (panel: string) => void;
};

/** Points inside the selected range — YTD from Jan 1, rolling ranges back
 *  from the series' own last date (feeds can lag "now"). */
const withinRange = <T,>(rows: T[], getT: (r: T) => number, days: number): T[] => clampToRange(rows, getT, days);

/** Unbackfilled reclassifications that touch `metric`, from the chart's first
 *  point to today, as chart markers. An event after the last data point
 *  (feed lag) still shows: the axis extends to it. */
const reclassMarkers = (
  changelog: Parameters<typeof getEventsAffecting>[0],
  metric: string,
  firstMs: number | undefined,
): ChartMarker[] => {
  if (firstMs == null) return [];
  const seen = new Set<string>();
  return getEventsAffecting(changelog, metric, firstMs, Date.now())
    .filter((e) => (seen.has(e.date) ? false : (seen.add(e.date), true)))
    .map((e) => ({ t: Date.parse(e.date), label: "† Reclassified", description: "Wallets were reclassified" }));
};

const LegendKey = ({
  id,
  swatch,
  label,
  value,
  active,
  onActive,
}: {
  id: string;
  swatch: string;
  label: string;
  value: string;
  active: string | null;
  onActive: (id: string | null) => void;
}) => (
  <button
    type="button"
    aria-pressed={active === id}
    aria-label={`${label} ${value}. Highlight ${label} line`}
    onMouseEnter={() => onActive(id)}
    onMouseLeave={() => onActive(null)}
    onFocus={() => onActive(id)}
    onBlur={() => onActive(null)}
    onClick={() => onActive(active === id ? null : id)}
    className={`inline-flex min-h-6 items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-opacity hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
      active != null && active !== id ? "opacity-50" : ""
    }`}
  >
    <span className={`h-2 w-2 rounded-sm ${swatch}`} aria-hidden="true" />
    {label} <span className="font-semibold text-foreground">{value}</span>
  </button>
);

const firstLast = <T,>(rows: T[]) => (rows.length ? { first: rows[0], last: rows[rows.length - 1] } : null);

export const HoldersTerminal = ({ snapshot, snapshotError, selectedView, rangeDays, onExplore }: Props) => {
  const { project } = useProject();
  const tk = project.ticker;
  const pn = project.name;
  const growth = useHolderGrowth({ view: selectedView, days: rangeDays });
  const intro = useIntro();
  const flow = useExchangeFlow();
  const cexHistory = useCexBalanceHistory();
  const { data: changelog } = useClassificationChangelog();
  const [balanceFocus, setBalanceFocus] = useState<string | null>(null);
  const isCombined = selectedView === "combined";
  const view = snapshot?.views[selectedView];
  const combinedStaking = snapshot?.views.combined?.stakingStats;
  const v3Staking = combinedStaking?.v3 ?? null;
  // Legacy 0 / v3 N is the Solana program recorded on the v3 channel. One
  // staked series, not a TEL-style split.
  const splitStaking = (combinedStaking?.legacy?.stakedTotal ?? 0) > 0 && (v3Staking?.stakedTotal ?? 0) > 0;
  const v3DeployDate = v3Staking?.deployDate ?? V3_STAKING_DEPLOY_DATE;
  const v3DeployMs = Date.parse(v3DeployDate);

  const holders = useMemo(
    () =>
      withinRange(
        (growth.data?.series ?? []).map((p) => ({ t: Date.parse(p.timestamp), holders: p.holders })),
        (r) => r.t,
        rangeDays,
      ),
    [growth.data, rangeDays],
  );
  const balance = useMemo(
    () =>
      withinRange(
        (growth.data?.balanceSeries ?? []).map((p) => ({ t: Date.parse(p.timestamp), retail: p.retail, cex: p.cex })),
        (r) => r.t,
        rangeDays,
      ),
    [growth.data, rangeDays],
  );
  const staking = useMemo(
    () =>
      withinRange(
        (growth.data?.stakingSeries ?? []).map((p) => {
          const t = Date.parse(p.timestamp);
          return {
            t,
            staking: p.staking,
            // The v3 series starts at the module's deploy; before it, v3 is 0
            // and the total is just the legacy line.
            stakingV3: t >= v3DeployMs ? p.stakingV3 : null,
            stakingTotal: p.stakingTotal,
          };
        }),
        (r) => r.t,
        rangeDays,
      ),
    [growth.data, rangeDays, v3DeployMs],
  );
  const stakingMarkers = useMemo<ChartMarker[]>(
    () =>
      staking.length && v3Staking && staking[0].t <= v3DeployMs
        ? [{ t: v3DeployMs, label: "v3 migration", description: "The v3 StakingModule went live and stakers began migrating from the legacy contract" }]
        : [],
    [staking, v3Staking, v3DeployMs],
  );
  const holderMarkers = useMemo(() => reclassMarkers(changelog, "retail.count", holders[0]?.t), [changelog, holders]);
  // Same † rule as the header KPIs: a reclassification after the period's
  // first point for the metric a card's delta shows suppresses that delta.
  const holderRelabel = useMemo(
    () => (holders[0] ? getEventsAffecting(changelog, "retail.count", holders[0].t, Date.now()) : []),
    [changelog, holders],
  );
  const balanceMarkers = useMemo(() => reclassMarkers(changelog, "retail.balance", balance[0]?.t), [changelog, balance]);
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
  // Staked = legacy + v3. Headline is today's measured total; the delta runs
  // from the period's first point, and is a "†" when that point falls in the
  // stretch where v3 wasn't recorded (no baseline, so no honest delta).
  const stakedNow = combinedStaking?.stakedTotal ?? s?.last.stakingTotal ?? s?.last.staking ?? null;
  const stakedFirst = s ? (splitStaking ? s.first.stakingTotal : s.first.stakingTotal ?? s.first.staking) : null;
  const stakedRelabel = s && splitStaking ? v3StakingGapEvents(s.first.t, s.first.stakingTotal == null ? null : 0, v3DeployDate, tk) : [];
  const stakingSplit = splitStaking && v3Staking && combinedStaking?.legacy
    ? `Legacy ${formatCompact(combinedStaking.legacy.stakedTotal)} / v3 ${formatCompact(v3Staking.stakedTotal)}`
    : null;
  const loading = growth.isLoading;
  const growthFailed = !!growth.error && !growth.data;

  const series = (content: React.ReactNode, has: boolean) =>
    loading ? <PanelSkeleton /> : growthFailed ? <PanelError>Couldn't load holder history.</PanelError> : has ? content : <PanelMessage>No data for this period.</PanelMessage>;

  const stats = view?.balanceStats;
  const buckets = stats?.distributionBuckets ?? [];
  const top = view?.concentration?.top ?? {};
  const prevTop = view?.concentration?.previousTop ?? {};
  const retailTotal = stats?.total ?? 0;

  return (
    <div className={`flex flex-col gap-2 ${intro ? "ha-stagger" : ""}`} data-testid="holders-terminal">
      <div
        className="grid shrink-0 grid-cols-2 gap-2"
        style={{ height: HOLDERS_PRIMARY_ROW_HEIGHT }}
        data-testid="holders-primary"
      >
      <TerminalPanel
        className="h-full min-h-0"
        title="Retail holders"
        info={`Wallets holding more than 0 ${tk}, excluding exchange, DEX, contract and ${pn}-controlled wallets.`}
        stat={
          h && (
            <>
              <span className="font-semibold text-foreground">{int.format(h.last.holders)}</span>
              <Delta value={h.last.holders - h.first.holders} format={(n) => int.format(Math.round(n))} relabel={holderRelabel} />
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
            markers={holderMarkers}
          />,
          holders.length > 1,
        )}
      </TerminalPanel>

      <TerminalPanel
        className="h-full min-h-0"
        title={`${tk} held`}
        info={heldPanelTip(project, {
          stakedTotal: v3Staking ? (combinedStaking?.stakedTotal ?? 0) : (combinedStaking?.stakedTotal ?? null),
          stakedV3: v3Staking?.stakedTotal ?? null,
        })}
        stat={
          b && (
            <>
              <LegendKey id="retail" swatch="bg-primary" label="Retail" value={formatCompact(b.last.retail)} active={isCombined ? balanceFocus : null} onActive={setBalanceFocus} />
              <LegendKey
                id="cex"
                swatch="bg-[hsl(var(--ha-accent))]"
                label="CEX"
                value={b.last.cex != null ? formatCompact(b.last.cex) : "—"}
                active={isCombined ? balanceFocus : null}
                onActive={setBalanceFocus}
              />
            </>
          )
        }
        actions={<DetailsButton onClick={() => onExplore("balances")} label={`${tk} held`} />}
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
              format={(n) => `${formatCompact(n)} ${tk}`}
              label={b ? `Retail ${tk} ${formatCompact(b.last.retail)}, exchange ${tk} ${b.last.cex != null ? formatCompact(b.last.cex) : "unknown"} at the end of the period.` : `${tk} held`}
              markers={balanceMarkers}
              highlight={balanceFocus}
            />,
            balance.length > 1,
          )
        )}
      </TerminalPanel>

      </div>
      <div
        className="grid shrink-0 grid-cols-3 gap-2"
        style={{ height: SECONDARY_CHART_ROW_PX }}
        data-testid="holders-secondary"
      >
      <TerminalPanel
        className="h-full min-h-0"
        title="Exchange net flow"
        info={`Daily ${tk} deposited to minus withdrawn from known exchange wallets. A deposit is not necessarily a sale.`}
        stat={
          netflow.length > 0 && (
            <>
              <Delta value={flowTotals.in - flowTotals.out} format={(n) => formatCompact(n)} />
              <span className="text-xs text-muted-foreground">
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
          <PanelError>Couldn't load exchange flows.</PanelError>
        ) : netflow.length ? (
          <SignedBars
            data={netflow.map(({ t, value }) => ({ t, value }))}
            seriesLabel="Net to exchanges"
            format={(n) => `${formatSignedCompact(n)} ${tk}`}
            label={`Net exchange flow over the period: ${formatSignedCompact(flowTotals.in - flowTotals.out)} ${tk}.`}
          />
        ) : (
          <PanelMessage>No flow data for this period.</PanelMessage>
        )}
      </TerminalPanel>

      <TerminalPanel
        className="h-full min-h-0"
        title={`Staked ${tk}`}
        info={<StakedPanelTip />}
        stat={
          s &&
          stakedNow != null && (
            <>
              <span className="font-semibold text-foreground" data-testid="staked-total">{formatCompact(stakedNow)}</span>
              <Delta
                value={stakedFirst != null ? stakedNow - stakedFirst : stakedRelabel.length ? 0 : null}
                format={(n) => formatCompact(n)}
                relabel={stakedRelabel}
              />
            </>
          )
        }
        actions={<DetailsButton onClick={() => onExplore("staking")} label="Staking" />}
      >
        {!isCombined ? (
          <PanelMessage>Available for all chains combined only.</PanelMessage>
        ) : (
          series(
            splitStaking ? (
              <div className="flex h-full min-h-0 flex-col">
                {stakingSplit && combinedStaking?.legacy && (
                  // Doubles as the chart's legend (swatches match the series).
                  <p className="flex shrink-0 flex-wrap items-center gap-x-2 text-xs tabular-nums text-muted-foreground" data-testid="staked-split">
                    <span className="sr-only">{stakingSplit}</span>
                    <span aria-hidden="true" className="inline-flex items-center gap-1">
                      <span className="h-0.5 w-2.5 bg-primary" />
                      Total
                    </span>
                    <span aria-hidden="true" className="inline-flex items-center gap-1">
                      <span className="w-2.5 border-t border-dashed border-muted-foreground" />
                      Legacy <span className="font-semibold text-foreground">{formatCompact(combinedStaking.legacy.stakedTotal)}</span>
                    </span>
                    <span aria-hidden="true" className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-ha-accent" />
                      v3 <span className="font-semibold text-foreground">{formatCompact(v3Staking?.stakedTotal ?? 0)}</span>
                    </span>
                  </p>
                )}
                <div className="min-h-0 flex-1">
                  <TimeChart
                    data={staking}
                    series={[
                      { key: "stakingTotal", label: "Total staked", color: "hsl(var(--primary))", connectNulls: false },
                      { key: "staking", label: "Legacy contract", color: "hsl(var(--muted-foreground))", dashed: true },
                      { key: "stakingV3", label: "v3 StakingModule", color: "hsl(var(--ha-accent))", connectNulls: false },
                    ]}
                    markers={stakingMarkers}
                    format={(n) => `${formatCompact(n)} ${tk}`}
                    label={`Staked ${tk} ${stakedNow != null ? formatCompact(stakedNow) : ""} now${stakingSplit ? ` (${stakingSplit})` : ""}. The legacy contract fell as stakers moved to the v3 StakingModule; v3 balances before the latest snapshot weren't recorded.`}
                  />
                </div>
              </div>
            ) : (
              <TimeChart
                kind="area"
                data={staking.map((p) => ({ t: p.t, staking: p.stakingTotal ?? p.staking ?? p.stakingV3 }))}
                series={[{ key: "staking", label: "Staked", color: "hsl(var(--primary))" }]}
                format={(n) => `${formatCompact(n)} ${tk}`}
                label={s ? `Staked ${tk} ${formatCompact(s.last.stakingTotal ?? s.last.staking ?? s.last.stakingV3 ?? 0)} at the end of the period.` : `Staked ${tk}`}
              />
            ),
            staking.length > 1,
          )
        )}
      </TerminalPanel>

      <TerminalPanel
        className="h-full min-h-0"
        title="Wallet sizes"
        info={`Retail wallets by balance (${tk}). The gold bar contains the average balance${stats ? ` (${formatCompact(stats.average)} ${tk})` : ""}.`}
        stat={
          stats && (
            <span className="text-xs text-muted-foreground">
              median <span className="font-semibold text-foreground">{formatCompact(stats.median)}</span>
            </span>
          )
        }
        actions={<DetailsButton onClick={() => onExplore("balances")} label="Wallet sizes" />}
      >
        {!snapshot ? (
          snapshotError ? <PanelError>Couldn't load the holder snapshot.</PanelError> : <PanelSkeleton />
        ) : buckets.length ? (
          <CategoryBars
            data={buckets.map((bk) => ({
              name: shortBucketLabel(bk.rangeLabel),
              full: bk.rangeLabel,
              value: bk.count,
              highlight: bk.rangeLabel === stats?.averageRangeLabel,
            }))}
            format={(n) => int.format(n)}
            label={`Retail wallets by balance: ${buckets.map((bk) => `${bk.rangeLabel} ${int.format(bk.count)}`).join(", ")}.`}
          />
        ) : (
          <PanelMessage>No balance data.</PanelMessage>
        )}
      </TerminalPanel>

      </div>
      <div
        className="grid shrink-0 grid-cols-2 gap-2"
        style={{ height: TABLE_PANEL_PX }}
        data-testid="holders-tables"
      >
      <TerminalPanel
        className="h-full min-h-0"
        title="Concentration"
        info={`Share of retail ${tk} held by the largest N retail wallets. Change is against the previous snapshot.`}
        stat={stats && <span className="text-xs text-muted-foreground">Gini <span className="font-semibold text-foreground">{stats.gini.toFixed(3)}</span></span>}
        actions={<DetailsButton onClick={() => onExplore("concentration")} label="Concentration" />}
        flush
      >
        {!snapshot ? (
          <div className="h-full p-2">{snapshotError ? <PanelError>Couldn't load the holder snapshot.</PanelError> : <PanelSkeleton />}</div>
        ) : (
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">Share of retail {tk} held by the top wallets</caption>
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1 text-left font-medium">Top</th>
                <th scope="col" className="px-2 py-1 text-left font-medium">Share</th>
                <th scope="col" className="px-3 py-1 text-right font-medium">{tk}</th>
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
        className="h-full min-h-0"
        title="Exchange balances"
        info={`${tk} held at each exchange's known wallets, with the change over the selected period.`}
        stat={cexTotal > 0 && <span className="font-semibold text-foreground">{formatCompact(cexTotal)}</span>}
        actions={<DetailsButton onClick={() => onExplore("exchanges")} label="Exchange balances" />}
        flush
      >
        {cexHistory.isLoading ? (
          <div className="h-full p-2"><PanelSkeleton /></div>
        ) : cexHistory.isError ? (
          <PanelError>Couldn't load exchange balances.</PanelError>
        ) : (
          <table className="w-full text-sm tabular-nums">
            <caption className="sr-only">{tk} held per exchange</caption>
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1 text-left font-medium">Exchange</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">{tk}</th>
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
    </div>
  );
};
