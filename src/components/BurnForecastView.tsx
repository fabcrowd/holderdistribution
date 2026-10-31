import { useMemo, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import "@/lib/rechartsMotion";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ZoomFrame } from "@/components/chart/ZoomFrame";
import { AxisBaselineNote } from "@/components/chart/AxisBaselineNote";
import { barSizing, computeYAxisFromRows, distinctTickFormatter, type YAxisScale } from "@/lib/chartAxes";
import { ChartLegend, type LegendItem } from "@/components/chart/ChartLegend";
import { useChartZoom } from "@/hooks/useChartZoom";
import { useSeriesToggle } from "@/hooks/useSeriesToggle";
import { InfoTooltip } from "@/components/InfoTooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  billMixSeries,
  buildBurnForecast,
  cashBridgeSeries,
  cashRunwaySeries,
  isThplItem,
  measuredActualsSeries,
  sheetMonthToYm,
  ymLabel,
  type BurnEvent,
  type BurnForecast,
  type BurnPlan,
  type OutstandingCategory,
} from "@/lib/burnForecast";
import { CHART_HEIGHT_CLASS } from "@/lib/terminalLayout";

const formatUsd = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);

const formatCompactUsd = (value: number) => {
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
};

const formatRunway = (forecast: BurnForecast): string => {
  if (forecast.depletedIn === "now" || forecast.runwayMonths <= 0) return "0 months";
  if (forecast.depletedIn == null) return `More than ${Math.floor(forecast.runwayMonths)} months`;
  return `${forecast.runwayMonths.toFixed(1)} months`;
};

const COLORS = {
  cash: "hsl(233 79% 56%)",
  burn: "hsl(28 90% 55%)",
  scheduled: "hsl(158 64% 42%)",
  spend: "hsl(262 83% 58%)",
  raised: "hsl(217 91% 60%)",
  paid: "hsl(0 72% 51%)",
  holdings: "hsl(28 90% 55%)",
  vendor: "hsl(233 79% 56%)",
  custody: "hsl(158 64% 42%)",
  safes: "hsl(158 64% 42%)",
  retained: "hsl(217 91% 60%)",
  bills: "hsl(0 72% 51%)",
  after: "hsl(233 79% 56%)",
};

const runwayConfig = { cashUsd: { label: "Cash remaining", color: COLORS.cash } };
const spendConfig = {
  burnUsd: { label: "Measured burn", color: COLORS.burn },
  scheduledUsd: { label: "Scheduled", color: COLORS.scheduled },
  spendUsd: { label: "Spend used", color: COLORS.spend },
};
const actualsConfig = {
  raisedUsd: { label: "Raised", color: COLORS.raised },
  paidUsd: { label: "Paid", color: COLORS.paid },
};
const SPEND_LEGEND: LegendItem[] = [
  { key: "burnUsd", label: "Measured", color: COLORS.burn, dashed: true },
  { key: "scheduledUsd", label: "Scheduled", color: COLORS.scheduled, dashed: true },
  { key: "spendUsd", label: "Used (max)", color: COLORS.spend },
];
const ACTUALS_LEGEND: LegendItem[] = [
  { key: "raisedUsd", label: "Raised", color: COLORS.raised },
  { key: "paidUsd", label: "Paid out", color: COLORS.paid },
];
const SPEND_KEYS = SPEND_LEGEND.map((i) => i.key);
const ACTUALS_KEYS = ACTUALS_LEGEND.map((i) => i.key);
const bridgeConfig = { usd: { label: "USD", color: COLORS.cash } };

const BILL_KIND: Record<OutstandingCategory, string> = {
  holdings: "Holdings AP",
  custody: "Custody",
  vendor: "Vendor",
};

const LegendDot = ({ color, label }: { color: string; label: string }) => (
  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
    {label}
  </span>
);

const Metric = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) => (
  <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-2">
    <p className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground">
      {label}
      {hint ? <InfoTooltip text={hint} /> : null}
    </p>
    <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</p>
  </div>
);

const DetailBlock = ({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) => (
  <Collapsible defaultOpen={defaultOpen} className="rounded-lg border border-border/40">
    <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground hover:bg-muted/40">
      {title}
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-2 border-t border-border/40 px-3 py-2.5">
      {children}
    </CollapsibleContent>
  </Collapsible>
);

export const BurnForecastView = ({
  plan,
  events,
  associationAddresses,
  includeThpl,
  onIncludeThpl,
  now = new Date(),
}: {
  plan: BurnPlan;
  events: BurnEvent[];
  associationAddresses: string[];
  includeThpl: boolean;
  onIncludeThpl: (value: boolean) => void;
  now?: Date;
}) => {
  const forecast = useMemo(
    () =>
      buildBurnForecast({
        plan,
        events,
        now,
        includeThpl,
        associationAddresses,
      }),
    [plan, events, now, includeThpl, associationAddresses],
  );

  const cashSeries = useMemo(() => cashRunwaySeries(forecast), [forecast]);
  const spendSeries = useMemo(
    () => cashSeries.filter((point) => point.id !== "now"),
    [cashSeries],
  );
  const actualsSeries = useMemo(() => measuredActualsSeries(forecast), [forecast]);
  const mixSeries = useMemo(() => billMixSeries(forecast), [forecast]);
  const bridgeSeries = useMemo(() => cashBridgeSeries(forecast), [forecast]);
  // Month axes are categories: zoom windows are in row-index units.
  const cashZoom = useChartZoom(cashSeries, (_, i) => i);
  const spendZoom = useChartZoom(spendSeries, (_, i) => i);
  const spendToggle = useSeriesToggle(SPEND_KEYS);
  const actualsToggle = useSeriesToggle(ACTUALS_KEYS);
  // Each chart's y-axis is fitted to its visible rows (zoom) and visible series (legend toggles).
  const cashAxisAuto = computeYAxisFromRows(cashZoom.rows, ["cashUsd"], { kind: "line" });
  const cashAxis = cashZoom.yScale("left", cashAxisAuto);
  const spendAxisAuto = computeYAxisFromRows(spendZoom.rows, SPEND_KEYS.filter((k) => spendToggle.isVisible(k)), { kind: "line" });
  const spendAxis = spendZoom.yScale("left", spendAxisAuto);
  const actualsAxis = computeYAxisFromRows(actualsSeries, ACTUALS_KEYS.filter((k) => actualsToggle.isVisible(k)), { kind: "bar" });
  const bridgeAxis = computeYAxisFromRows(bridgeSeries, ["usd"], { kind: "bar" });
  const axisFmt = (axis: YAxisScale) => distinctTickFormatter(axis.ticks, formatCompactUsd);
  const actualsSizing = barSizing(actualsSeries.length);
  const bridgeSizing = barSizing(bridgeSeries.length);
  const mixTotal = mixSeries.reduce((sum, row) => sum + row.usd, 0);
  const depleteLabel =
    forecast.depletedIn && forecast.depletedIn !== "now"
      ? cashSeries.find((point) => point.id === forecast.depletedIn)?.label
      : forecast.depletedIn === "now"
        ? "Now"
        : undefined;

  const nowYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const remainingKeys = [...new Set(plan.monthlyBurn.flatMap((line) => Object.keys(line.monthlyUsd)))]
    .map((label) => ({ label, ym: sheetMonthToYm(label) }))
    .filter((row): row is { label: string; ym: string } => Boolean(row.ym && row.ym > nowYm))
    .sort((a, b) => a.ym.localeCompare(b.ym));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Operating runway</p>
        <p className="mt-0.5 text-2xl font-semibold tabular-nums text-foreground">
          {formatRunway(forecast)}
        </p>
        <p className="mt-1 text-sm text-foreground">
          After {formatUsd(forecast.cash.outstandingUsd)} of invoices due now, then
          {" "}{formatUsd(forecast.operatingSpendUsd)} per month
          {forecast.depletedIn && forecast.depletedIn !== "now"
            ? ` · runs out ${ymLabel(forecast.depletedIn)}.`
            : forecast.depletedIn === "now"
              ? " · bills due now exceed stablecoin on hand."
              : "."}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Each month uses the current payout rate ({formatUsd(forecast.measured.averagePaidUsd)})
          or the scheduled month ({formatUsd(forecast.plannedMonthlyUsd)}), whichever is higher.
          That schedule continues after {plan.forecastWindow}. Forward THPL is off unless you tick
          the box; the July THPL invoice is already in bills due now.
        </p>
        <label className="mt-2 flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={includeThpl}
            onChange={(e) => onIncludeThpl(e.target.checked)}
            className="h-3.5 w-3.5 accent-primary"
          />
          Include THPL in the monthly schedule going forward
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric
          label="Measured burn"
          value={`${formatUsd(forecast.measured.averagePaidUsd)}/mo`}
          hint="Average USDC/USDT paid to external payees over the last three months of TEL sales."
        />
        <Metric
          label={includeThpl ? "Planned burn" : "Planned burn (ex THPL)"}
          value={`${formatUsd(forecast.plannedMonthlyUsd)}/mo`}
          hint="Sum of remaining monthly lines on the TAO burn-forecast sheet."
        />
        <Metric
          label="Spend used"
          value={`${formatUsd(forecast.operatingSpendUsd)}/mo`}
          hint="max(measured burn, scheduled month). This is the line the runway chart spends."
        />
        <Metric
          label="Stablecoin on hand"
          value={formatUsd(forecast.cash.onHandUsd)}
          hint="Sheet safes plus TEL-sale proceeds still in selling wallets. Not TEL inventory."
        />
        <Metric
          label="Bills due now"
          value={formatUsd(forecast.cash.outstandingUsd)}
          hint="Every still-unpaid invoice on the Aug 25 sheet, including the July THPL invoice."
        />
        <Metric
          label="After bills due"
          value={formatUsd(forecast.cash.afterBillsUsd)}
          hint="On-hand stablecoin minus that full outstanding book."
        />
      </div>

      <article className="space-y-2 rounded-lg border border-border/40 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">
            Cash remaining
          </h4>
          <div className="flex flex-wrap gap-3">
            <LegendDot color={COLORS.cash} label="After bills, then month-end" />
            {depleteLabel ? <LegendDot color="hsl(0 72% 51%)" label={`Runs out ${depleteLabel}`} /> : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Starts at stablecoin left after invoices due now. Each month subtracts the spend used
          above. TEL inventory is not in this series.
        </p>
        <ZoomFrame zoom={cashZoom} yAxes={{ left: cashAxisAuto.domain }} notes={<AxisBaselineNote baseline={cashAxis.baseline} format={formatCompactUsd} />}>
        <ChartContainer config={runwayConfig} className={`${CHART_HEIGHT_CLASS.standard} w-full aspect-auto`}>
          <AreaChart data={cashZoom.rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
            <defs>
              <linearGradient id="burn-cash-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.cash} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLORS.cash} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} className="stroke-border/40" />
            <XAxis dataKey="label" tickMargin={8} />
            <YAxis
              tickFormatter={axisFmt(cashAxis)}
              tickMargin={8}
              width={48}
              domain={cashAxis.domain}
              ticks={cashAxis.ticks}
              allowDataOverflow={cashZoom.yRanges.left != null}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => [formatUsd(Number(value)), "Cash remaining"]}
                />
              }
            />
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
            {depleteLabel ? (
              <ReferenceLine
                x={depleteLabel}
                stroke="hsl(0 72% 51%)"
                strokeDasharray="4 4"
              />
            ) : null}
            <Area
              type="monotone"
              dataKey="cashUsd"
              stroke={COLORS.cash}
              strokeWidth={2}
              fill="url(#burn-cash-fill)"
            />
          </AreaChart>
        </ChartContainer>
        </ZoomFrame>
      </article>

      <div className="grid gap-3 lg:grid-cols-2">
        <article className="space-y-2 rounded-lg border border-border/40 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">
              Monthly spend
            </h4>
            <ChartLegend items={SPEND_LEGEND} hidden={spendToggle.hidden} onToggle={spendToggle.toggle} />
          </div>
          <ZoomFrame zoom={spendZoom} yAxes={{ left: spendAxisAuto.domain }} notes={<AxisBaselineNote baseline={spendAxis.baseline} format={formatCompactUsd} />}>
          <ChartContainer config={spendConfig} className={`${CHART_HEIGHT_CLASS.standard} w-full aspect-auto`}>
            <LineChart data={spendZoom.rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
              <CartesianGrid vertical={false} className="stroke-border/40" />
              <XAxis dataKey="label" tickMargin={8} />
              <YAxis tickFormatter={axisFmt(spendAxis)} domain={spendAxis.domain} ticks={spendAxis.ticks} allowDataOverflow={spendZoom.yRanges.left != null} tickMargin={8} width={48} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => [
                      formatUsd(Number(value)),
                      spendConfig[name as keyof typeof spendConfig]?.label ?? String(name),
                    ]}
                  />
                }
              />
              {spendToggle.isVisible("burnUsd") && (
              <Line
                type="monotone"
                dataKey="burnUsd"
                stroke={COLORS.burn}
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
              />
              )}
              {spendToggle.isVisible("scheduledUsd") && (
              <Line
                type="monotone"
                dataKey="scheduledUsd"
                stroke={COLORS.scheduled}
                strokeWidth={2}
                strokeDasharray="2 2"
                dot={false}
              />
              )}
              {spendToggle.isVisible("spendUsd") && (
              <Line
                type="monotone"
                dataKey="spendUsd"
                stroke={COLORS.spend}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
              )}
            </LineChart>
          </ChartContainer>
          </ZoomFrame>
        </article>

        <article className="space-y-2 rounded-lg border border-border/40 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">
              Last three months
            </h4>
            <ChartLegend items={ACTUALS_LEGEND} hidden={actualsToggle.hidden} onToggle={actualsToggle.toggle} />
          </div>
          <p className="text-xs text-muted-foreground">
            Raised is stablecoin from TEL sales. Paid is that stablecoin sent to an outside payee.
          </p>
          <ChartContainer config={actualsConfig} className={`${CHART_HEIGHT_CLASS.standard} w-full aspect-auto`}>
            <BarChart data={actualsSeries} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={actualsSizing.barCategoryGap}>
              <CartesianGrid vertical={false} className="stroke-border/40" />
              <XAxis dataKey="label" tickMargin={8} />
              <YAxis tickFormatter={axisFmt(actualsAxis)} domain={actualsAxis.domain} ticks={actualsAxis.ticks} tickMargin={8} width={48} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => [
                      formatUsd(Number(value)),
                      actualsConfig[name as keyof typeof actualsConfig]?.label ?? String(name),
                    ]}
                  />
                }
              />
              {actualsToggle.isVisible("raisedUsd") && <Bar dataKey="raisedUsd" fill={COLORS.raised} radius={[2, 2, 0, 0]} maxBarSize={actualsSizing.maxBarSize} minPointSize={actualsSizing.minPointSize} />}
              {actualsToggle.isVisible("paidUsd") && <Bar dataKey="paidUsd" fill={COLORS.paid} radius={[2, 2, 0, 0]} maxBarSize={actualsSizing.maxBarSize} minPointSize={actualsSizing.minPointSize} />}
            </BarChart>
          </ChartContainer>
        </article>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <article className="space-y-2 rounded-lg border border-border/40 px-3 py-2.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">
            Opening cash walk
          </h4>
          <ChartContainer config={bridgeConfig} className={`${CHART_HEIGHT_CLASS.compact} w-full aspect-auto`}>
            <BarChart data={bridgeSeries} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={bridgeSizing.barCategoryGap}>
              <CartesianGrid vertical={false} className="stroke-border/40" />
              <XAxis dataKey="label" tickMargin={8} interval={0} />
              <YAxis tickFormatter={axisFmt(bridgeAxis)} domain={bridgeAxis.domain} ticks={bridgeAxis.ticks} tickMargin={8} width={48} />
              <ChartTooltip
                content={
                  <ChartTooltipContent formatter={(value) => [formatUsd(Number(value)), ""]} />
                }
              />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
              <Bar dataKey="usd" radius={[2, 2, 0, 0]} maxBarSize={bridgeSizing.maxBarSize} minPointSize={bridgeSizing.minPointSize}>
                {bridgeSeries.map((row) => (
                  <Cell key={row.key} fill={COLORS[row.key]} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
          <p className="text-xs text-muted-foreground">
            Authorized-not-pulled ({formatUsd(forecast.cash.authorizedUsd)}) is not cash on hand.
            One-offs totalling {formatUsd(forecast.cash.oneOffsUsd)} stay off this operating runway.
          </p>
        </article>

        <article className="space-y-2 rounded-lg border border-border/40 px-3 py-2.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">
            Bills due now
          </h4>
          {mixTotal > 0 ? (
            <>
              <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                {mixSeries.map((row) => (
                  <div
                    key={row.key}
                    className="h-full"
                    style={{
                      width: `${(row.usd / mixTotal) * 100}%`,
                      backgroundColor: COLORS[row.key],
                    }}
                    title={`${row.label} ${formatUsd(row.usd)}`}
                  />
                ))}
              </div>
              <ul className="space-y-1 text-xs">
                {mixSeries.map((row) => (
                  <li key={row.key} className="flex items-center justify-between gap-3">
                    <LegendDot color={COLORS[row.key]} label={row.label} />
                    <span className="tabular-nums">{formatUsd(row.usd)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No unpaid invoices on the sheet.</p>
          )}
        </article>
      </div>

      <DetailBlock title="Month-by-month runway" defaultOpen>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 px-2 text-xs">Month</TableHead>
                <TableHead className="h-8 px-2 text-right text-xs">Opening</TableHead>
                <TableHead className="h-8 px-2 text-right text-xs">Burn</TableHead>
                <TableHead className="h-8 px-2 text-right text-xs">Scheduled</TableHead>
                <TableHead className="h-8 px-2 text-right text-xs">Spend</TableHead>
                <TableHead className="h-8 px-2 text-right text-xs">Closing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forecast.months.slice(0, 12).map((month) => (
                <TableRow
                  key={month.id}
                  className={month.closingUsd < 0 ? "bg-destructive/5 hover:bg-destructive/10" : "hover:bg-muted/30"}
                >
                  <TableCell className="p-2 text-xs">{month.label}</TableCell>
                  <TableCell className="p-2 text-right text-xs tabular-nums">
                    {formatUsd(month.openingUsd)}
                  </TableCell>
                  <TableCell className="p-2 text-right text-xs tabular-nums">
                    {formatUsd(month.burnUsd)}
                  </TableCell>
                  <TableCell className="p-2 text-right text-xs tabular-nums">
                    {formatUsd(month.scheduledUsd)}
                  </TableCell>
                  <TableCell className="p-2 text-right text-xs tabular-nums">
                    {formatUsd(month.spendUsd)}
                  </TableCell>
                  <TableCell className="p-2 text-right text-xs tabular-nums">
                    {formatUsd(month.closingUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DetailBlock>

      <DetailBlock title="Expected monthly schedule">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 px-2 text-xs">Item</TableHead>
                {remainingKeys.map(({ label }) => (
                  <TableHead key={label} className="h-8 px-2 text-right text-xs">
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.monthlyBurn
                .filter((line) => includeThpl || !isThplItem(line.name))
                .filter((line) => remainingKeys.some(({ label }) => line.monthlyUsd[label] != null))
                .map((line) => (
                  <TableRow key={line.name} className="hover:bg-muted/30">
                    <TableCell className="p-2 text-xs">{line.name}</TableCell>
                    {remainingKeys.map(({ label }) => (
                      <TableCell key={label} className="p-2 text-right text-xs tabular-nums">
                        {line.monthlyUsd[label] != null ? formatUsd(line.monthlyUsd[label] as number) : "—"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </DetailBlock>

      {forecast.bills.items.length > 0 && (
        <DetailBlock title="Invoice book">
          <p className="text-xs text-muted-foreground">
            Sheet line items sum to {formatUsd(forecast.bills.items.reduce((s, r) => s + r.amountUsd, 0))}.
            {" "}
            {formatUsd(forecast.bills.holdingsUsd)} is the July THPL invoice. The rest is
            vendor/custody; none of those amounts show as a matching sale-proceed after the invoice
            month, so they stay due.
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 px-2 text-xs">Invoice</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Kind</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Due</TableHead>
                  <TableHead className="h-8 px-2 text-right text-xs">Amount</TableHead>
                  <TableHead className="h-8 px-2 text-right text-xs">Still due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {forecast.bills.items.map((row) => (
                  <TableRow key={row.item} className="hover:bg-muted/30">
                    <TableCell className="p-2 text-xs">
                      <div>{row.item}</div>
                      <div className="text-xs text-muted-foreground">{row.note}</div>
                    </TableCell>
                    <TableCell className="p-2 text-xs text-muted-foreground">
                      {BILL_KIND[row.category]}
                    </TableCell>
                    <TableCell className="p-2 text-xs text-muted-foreground">
                      {row.dueDate || row.period || "—"}
                    </TableCell>
                    <TableCell className="p-2 text-right text-xs tabular-nums">
                      {formatUsd(row.amountUsd)}
                    </TableCell>
                    <TableCell className="p-2 text-right text-xs tabular-nums">
                      {formatUsd(row.stillDueUsd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DetailBlock>
      )}
    </div>
  );
};
