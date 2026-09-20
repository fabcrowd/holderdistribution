import { stableQuoteUsd } from "./dispositionPnl";

export type BurnPlanLine = {
  name: string;
  category: string;
  billingBasis: string;
  monthlyUsd: Record<string, number | null>;
};

export type BurnPlanAmount = {
  item: string;
  amountUsd: number | null;
  notes?: string;
  period?: string;
  dueDate?: string;
};

export type BurnPlan = {
  asOfDate: string;
  forecastWindow: string;
  summary: {
    baseMonthlyBurnUsd: number;
    baseMonthlyBurnExThplUsd: number;
  };
  monthlyBurn: BurnPlanLine[];
  outstandingPayments: BurnPlanAmount[];
  oneOffCosts: BurnPlanAmount[];
  safeHoldingsUsd: BurnPlanAmount[];
  authorizedNotYetPulled: BurnPlanAmount[];
};

export type BurnEvent = {
  kind?: string;
  timestamp: number | null;
  quoteToken: string | null;
  quoteAmount: number | null;
  proceedTo: string | null;
  proceedStatus: string | null;
};

export type BurnForecastMonth = {
  id: string;
  label: string;
  openingUsd: number;
  burnUsd: number;
  scheduledUsd: number;
  spendUsd: number;
  closingUsd: number;
};

export type OutstandingCategory = "holdings" | "custody" | "vendor";

export type OutstandingBill = {
  item: string;
  amountUsd: number;
  period: string;
  dueDate: string;
  category: OutstandingCategory;
  hitsOperatingUsdc: boolean;
  settledUsd: number;
  stillDueUsd: number;
  note: string;
};

export type BurnForecast = {
  measured: {
    monthIds: string[];
    paidUsd: number[];
    raisedUsd: number[];
    averagePaidUsd: number;
    averageRaisedUsd: number;
  };
  plannedMonthlyUsd: number;
  operatingSpendUsd: number;
  bills: {
    totalUsd: number;
    holdingsUsd: number;
    usdcUsd: number;
    settledUsd: number;
    items: OutstandingBill[];
  };
  cash: {
    sheetSafesUsd: number;
    retainedUsd: number;
    onHandUsd: number;
    outstandingUsd: number;
    afterBillsUsd: number;
    afterUsdcBillsUsd: number;
    oneOffsUsd: number;
    authorizedUsd: number;
  };
  months: BurnForecastMonth[];
  runwayMonths: number;
  depletedIn: string | null;
};

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (n: number) => String(n).padStart(2, "0");

export const isThplItem = (name: string): boolean => /thpl/i.test(name);

export const classifyOutstandingItem = (item: string): OutstandingCategory => {
  if (isThplItem(item)) return "holdings";
  if (/bitgo|anchorage/i.test(item)) return "custody";
  return "vendor";
};

export const outstandingHitsOperatingUsdc = (item: string): boolean =>
  classifyOutstandingItem(item) !== "holdings";

export const operatingMonthSpend = (burnUsd: number, scheduledUsd: number): number =>
  Math.max(burnUsd, scheduledUsd);

const SETTLE_TOLERANCE = 0.02;

const parsePeriodStart = (period: string): number | null => {
  const m = period.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b/i);
  if (!m) return null;
  const month = MONTH_LABELS.findIndex((label) => label.toLowerCase() === m[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  return Date.UTC(Number(m[2]), month, 1) / 1000;
};

const settledAgainstInvoice = (events: BurnEvent[], amountUsd: number, period: string): number => {
  if (amountUsd <= 0) return 0;
  const after = parsePeriodStart(period);
  let matched = 0;
  for (const event of events) {
    const usd = quoteUsd(event);
    if (!usd || isRetained(event) || !event.proceedTo) continue;
    if (after != null && (event.timestamp == null || event.timestamp < after)) continue;
    if (Math.abs(usd - amountUsd) / amountUsd <= SETTLE_TOLERANCE) {
      matched += usd;
    }
  }
  return Math.min(matched, amountUsd);
};

const outstandingNote = (item: string, settledUsd: number): string => {
  const category = classifyOutstandingItem(item);
  if (settledUsd > 0) {
    return "Matching stablecoin payment found on the sale rail — not still due.";
  }
  if (category === "holdings") {
    return "Holdings payroll AP. No USDC payee on the Association sale rail — historically settled intercompany / TEL, but it is still due.";
  }
  if (category === "custody") {
    return "Custody invoice. Not a contractor EOA on the sale rail; still a cash claim.";
  }
  return "No matching sale-proceed payment in the ledger window — treat as still due.";
};

export const sheetMonthToYm = (label: string): string | null => {
  const m = label.trim().match(/^([A-Za-z]{3})-(\d{2})$/);
  if (!m) return null;
  const month = MONTH_LABELS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (month < 0) return null;
  return `20${m[2]}-${pad2(month + 1)}`;
};

export const ymToSheetMonth = (ym: string): string => {
  const [year, month] = ym.split("-").map(Number);
  return `${MONTH_LABELS[month - 1]}-${String(year).slice(-2)}`;
};

export const ymLabel = (ym: string): string => {
  const [year, month] = ym.split("-").map(Number);
  return `${MONTH_LABELS[month - 1]} ${year}`;
};

const addMonths = (ym: string, delta: number): string => {
  const [year, month] = ym.split("-").map(Number);
  const idx = year * 12 + (month - 1) + delta;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${pad2(m)}`;
};

const utcYm = (now: Date): string =>
  `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;

const lastUtcDayOfMonth = (now: Date): number =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

const eventYm = (timestamp: number | null): string | null => {
  if (timestamp == null) return null;
  const d = new Date(timestamp * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
};

const sumAmounts = (rows: BurnPlanAmount[], includeThpl: boolean): number =>
  rows.reduce((sum, row) => {
    if (row.amountUsd == null) return sum;
    if (!includeThpl && isThplItem(row.item)) return sum;
    return sum + row.amountUsd;
  }, 0);

export const plannedMonthlyUsd = (
  plan: BurnPlan,
  ym: string,
  opts: { includeThpl: boolean },
): number => {
  const key = ymToSheetMonth(ym);
  let total = 0;
  for (const line of plan.monthlyBurn) {
    if (!opts.includeThpl && isThplItem(line.name)) continue;
    const value = line.monthlyUsd[key];
    if (value != null) total += value;
  }
  return total;
};

const sheetMonthIds = (plan: BurnPlan): string[] => {
  const ids = new Set<string>();
  for (const line of plan.monthlyBurn) {
    for (const label of Object.keys(line.monthlyUsd)) {
      const ym = sheetMonthToYm(label);
      if (ym) ids.add(ym);
    }
  }
  return [...ids].sort();
};

const trailingMonthIds = (now: Date, count: number): string[] => {
  const includeCurrent = now.getUTCDate() >= lastUtcDayOfMonth(now);
  let cursor = utcYm(now);
  if (!includeCurrent) cursor = addMonths(cursor, -1);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.unshift(cursor);
    cursor = addMonths(cursor, -1);
  }
  return ids;
};

const isSell = (event: BurnEvent): boolean => !event.kind || event.kind === "sell";

const quoteUsd = (event: BurnEvent): number =>
  isSell(event) ? stableQuoteUsd(event.quoteToken, event.quoteAmount) : 0;

const isRetained = (event: BurnEvent): boolean => event.proceedStatus === "retained_in_wallet";

export const buildBurnForecast = ({
  plan,
  events,
  now,
  includeThpl = false,
  trailingMonths = 3,
  horizonMonths = 18,
  associationAddresses = [],
}: {
  plan: BurnPlan;
  events: BurnEvent[];
  now: Date;
  includeThpl?: boolean;
  trailingMonths?: number;
  horizonMonths?: number;
  associationAddresses?: string[];
}): BurnForecast => {
  const internal = new Set(associationAddresses.map((a) => a.trim().toLowerCase()));
  const monthIds = trailingMonthIds(now, trailingMonths);
  const paidUsd = monthIds.map(() => 0);
  const raisedUsd = monthIds.map(() => 0);
  let retainedUsd = 0;

  for (const event of events) {
    const usd = quoteUsd(event);
    if (!usd) continue;
    if (isRetained(event)) retainedUsd += usd;
    const ym = eventYm(event.timestamp);
    const idx = ym ? monthIds.indexOf(ym) : -1;
    if (idx >= 0) {
      raisedUsd[idx] += usd;
      if (!isRetained(event)) {
        const to = event.proceedTo?.trim().toLowerCase() ?? "";
        if (to && !internal.has(to)) paidUsd[idx] += usd;
      }
    }
  }

  const averagePaidUsd = monthIds.length ? paidUsd.reduce((a, b) => a + b, 0) / monthIds.length : 0;
  const averageRaisedUsd = monthIds.length ? raisedUsd.reduce((a, b) => a + b, 0) / monthIds.length : 0;

  const sheetSafesUsd = sumAmounts(plan.safeHoldingsUsd, true);
  const oneOffsUsd = sumAmounts(plan.oneOffCosts, true);
  const authorizedUsd = sumAmounts(plan.authorizedNotYetPulled, true);
  const onHandUsd = sheetSafesUsd + retainedUsd;

  const billItems: OutstandingBill[] = plan.outstandingPayments
    .filter((row) => row.amountUsd != null)
    .map((row) => {
      const amountUsd = row.amountUsd as number;
      const category = classifyOutstandingItem(row.item);
      const settledUsd = settledAgainstInvoice(events, amountUsd, row.period ?? "");
      const stillDueUsd = Math.max(0, amountUsd - settledUsd);
      return {
        item: row.item,
        amountUsd,
        period: row.period ?? "",
        dueDate: row.dueDate ?? "",
        category,
        hitsOperatingUsdc: outstandingHitsOperatingUsdc(row.item),
        settledUsd,
        stillDueUsd,
        note: outstandingNote(row.item, settledUsd),
      };
    });
  const outstandingUsd = billItems.reduce((sum, row) => sum + row.stillDueUsd, 0);
  const holdingsUsd = billItems
    .filter((row) => row.category === "holdings")
    .reduce((sum, row) => sum + row.stillDueUsd, 0);
  const usdcUsd = outstandingUsd - holdingsUsd;
  const settledUsd = billItems.reduce((sum, row) => sum + row.settledUsd, 0);
  const afterBillsUsd = onHandUsd - outstandingUsd;
  const afterUsdcBillsUsd = onHandUsd - usdcUsd;

  const nowYm = utcYm(now);
  const futureSheetIds = sheetMonthIds(plan).filter((ym) => ym > nowYm);
  const nextPlanned = futureSheetIds.length
    ? plannedMonthlyUsd(plan, futureSheetIds[0], { includeThpl })
    : 0;
  const lastScheduled = futureSheetIds.length
    ? plannedMonthlyUsd(plan, futureSheetIds[futureSheetIds.length - 1], { includeThpl })
    : 0;
  const operatingSpendUsd = operatingMonthSpend(averagePaidUsd, nextPlanned || lastScheduled);

  const months: BurnForecastMonth[] = [];
  let opening = afterBillsUsd;
  let cursor = addMonths(nowYm, 1);
  for (let i = 0; i < horizonMonths; i++) {
    const onSheet = futureSheetIds.includes(cursor);
    const scheduledUsd = onSheet
      ? plannedMonthlyUsd(plan, cursor, { includeThpl })
      : lastScheduled;
    const spendUsd = operatingMonthSpend(averagePaidUsd, scheduledUsd);
    const closingUsd = opening - spendUsd;
    months.push({
      id: cursor,
      label: ymLabel(cursor),
      openingUsd: opening,
      burnUsd: averagePaidUsd,
      scheduledUsd,
      spendUsd,
      closingUsd,
    });
    opening = closingUsd;
    cursor = addMonths(cursor, 1);
  }

  let runwayMonths = 0;
  let depletedIn: string | null = null;
  if (afterBillsUsd <= 0) {
    depletedIn = "now";
  } else {
    for (const month of months) {
      if (month.closingUsd >= 0) {
        runwayMonths += 1;
        continue;
      }
      depletedIn = month.id;
      if (month.spendUsd > 0 && month.openingUsd > 0) {
        runwayMonths += month.openingUsd / month.spendUsd;
      }
      break;
    }
  }

  return {
    measured: {
      monthIds,
      paidUsd,
      raisedUsd,
      averagePaidUsd,
      averageRaisedUsd,
    },
    plannedMonthlyUsd: nextPlanned,
    operatingSpendUsd,
    bills: {
      totalUsd: outstandingUsd,
      holdingsUsd,
      usdcUsd,
      settledUsd,
      items: billItems,
    },
    cash: {
      sheetSafesUsd,
      retainedUsd,
      onHandUsd,
      outstandingUsd,
      afterBillsUsd,
      afterUsdcBillsUsd,
      oneOffsUsd,
      authorizedUsd,
    },
    months,
    runwayMonths,
    depletedIn,
  };
};

export type ForecastCashPoint = {
  id: string;
  label: string;
  cashUsd: number;
  spendUsd: number;
  burnUsd: number;
  scheduledUsd: number;
};

const shortYmLabel = (ym: string): string => {
  const [year, month] = ym.split("-").map(Number);
  return `${MONTH_LABELS[month - 1]} '${String(year).slice(-2)}`;
};

/** Cash remaining after bills, then month-end closes through depletion. */
export const cashRunwaySeries = (
  forecast: BurnForecast,
  maxMonths = 12,
): ForecastCashPoint[] => {
  const depleteIdx = forecast.months.findIndex((month) => month.closingUsd < 0);
  const monthCount =
    depleteIdx >= 0
      ? Math.min(maxMonths, depleteIdx + 2)
      : Math.min(maxMonths, forecast.months.length);
  return [
    {
      id: "now",
      label: "Now",
      cashUsd: forecast.cash.afterBillsUsd,
      spendUsd: 0,
      burnUsd: 0,
      scheduledUsd: 0,
    },
    ...forecast.months.slice(0, monthCount).map((month) => ({
      id: month.id,
      label: shortYmLabel(month.id),
      cashUsd: month.closingUsd,
      spendUsd: month.spendUsd,
      burnUsd: month.burnUsd,
      scheduledUsd: month.scheduledUsd,
    })),
  ];
};

export const measuredActualsSeries = (forecast: BurnForecast) =>
  forecast.measured.monthIds.map((id, i) => ({
    id,
    label: shortYmLabel(id),
    raisedUsd: forecast.measured.raisedUsd[i] ?? 0,
    paidUsd: forecast.measured.paidUsd[i] ?? 0,
  }));

export const billMixSeries = (forecast: BurnForecast) => {
  const vendorUsd = forecast.bills.items
    .filter((row) => row.category === "vendor")
    .reduce((sum, row) => sum + row.stillDueUsd, 0);
  const custodyUsd = forecast.bills.items
    .filter((row) => row.category === "custody")
    .reduce((sum, row) => sum + row.stillDueUsd, 0);
  return [
    { key: "holdings" as const, label: "Holdings AP", usd: forecast.bills.holdingsUsd },
    { key: "vendor" as const, label: "Vendor", usd: vendorUsd },
    { key: "custody" as const, label: "Custody", usd: custodyUsd },
  ].filter((row) => row.usd > 0);
};

export const cashBridgeSeries = (forecast: BurnForecast) => [
  { key: "safes", label: "Safes", usd: forecast.cash.sheetSafesUsd },
  { key: "retained", label: "Unswept", usd: forecast.cash.retainedUsd },
  { key: "bills", label: "Bills due", usd: -forecast.cash.outstandingUsd },
  { key: "after", label: "After bills", usd: forecast.cash.afterBillsUsd },
];
