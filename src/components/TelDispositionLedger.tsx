import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Lock, ChevronDown } from "lucide-react";
import {
  ForensicsUnlockGate,
  useForensicsUnlock,
} from "@/components/ForensicsGate";
import { BurnForecastView } from "@/components/BurnForecastView";
import { DispositionPnlView } from "@/components/DispositionPnlView";
import { SubPanelTabs } from "@/components/SubPanelTabs";
import { InfoTooltip } from "@/components/InfoTooltip";
import { Badge } from "@/components/ui/badge";
import { TabsContent } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BurnPlan } from "@/lib/burnForecast";
import {
  buildDispositionPnl,
  buildWhereStablecoinWent,
  buildWhereTelWent,
  classificationLabel,
  explorerAddress,
  stableQuoteUsd,
  stablecoinProceedLabel,
  type PnlEvent,
  type PnlWallet,
  type WhereStablecoinWentBucket,
  type WhereTelWentBucket,
} from "@/lib/dispositionPnl";
import { stablecoinPayeeLabel } from "@/lib/stablecoinPayeeLabels";
import {
  nextSalesJournalSort,
  sortSalesJournal,
  type SalesJournalColumn,
  type SalesJournalSort,
} from "@/lib/salesJournalSort";
import {
  buildDispositionPeriods,
  filterByPeriod,
  type DispositionPeriod,
  type PeriodGroup,
} from "@/lib/dispositionPeriod";
import { cn } from "@/lib/utils";
import { loadDispositionLedger } from "@/lib/loadForensics";

const LEDGER_VIEWS = [
  { id: "ledger", label: "Sales journal" },
  { id: "pnl", label: "P&L" },
  { id: "burn", label: "Burn forecast" },
];

const PERIOD_GROUPS: Array<{ group: PeriodGroup; label: string }> = [
  { group: "summary", label: "Reporting period" },
  { group: "quarter", label: "Quarters" },
  { group: "month", label: "Months" },
];

export type TelDispositionSell = {
  id: string;
  txHash: string;
  block: number;
  timestamp: number | null;
  chain: string;
  fromWallet: string;
  fromName: string;
  telAmount: number;
  venue: string | null;
  quoteToken: string | null;
  quoteAmount: number | null;
  impliedPriceUsd: number | null;
  quoteMatch: string | null;
  quoteNote: string | null;
  proceedTo: string | null;
  proceedChain: string | null;
  proceedToken: string | null;
  proceedAmount: number | null;
  proceedStatus: string | null;
  proceedClassification: string | null;
  proceedMatch: string | null;
  viaCctp: boolean;
};

export type TelDispositionLedgerReport = {
  key: string;
  title: string;
  generated: string;
  window: { start: string; end: string };
  walletCount: number;
  coverage: string;
  headline: string;
  summary: {
    totalTelOutbound: number;
    totalTelSold: number;
    totalTelTransferred: number;
    totalQuoteProceedsUsd: number;
    sellCount: number;
    sellsWithQuote: number;
    sellsWithProceed: number;
    sellsWithoutQuote: number;
    sellsWithoutProceed: number;
    sellsRetained: number;
    eventCount: number;
  };
  telByClassification: Array<{ cls: string; tel: number }>;
  topProceedPayees: Array<{ usd: number; token: string; chain: string; to: string }>;
  topTransferDestinations: Array<{ to: string; tel: number; classification: string }>;
  polygon: {
    stableOutUsd: number;
    telSold: number;
    sellCount: number;
    sellsWithProceed: number;
    topPayees: Array<{ usd: number; token: string; to: string }>;
  };
  ethereum: {
    stableOutUsd: number;
    telSold: number;
    sellCount: number;
    sellsWithProceed: number;
    topPayees: Array<{ usd: number; token: string; to: string }>;
  };
  sells: TelDispositionSell[];
  wallets?: PnlWallet[];
  events?: PnlEvent[];
  burnPlan?: BurnPlan | null;
};

const useTelDispositionLedger = (password: string | null, unlocked: boolean) =>
  useQuery({
    queryKey: ["tel-disposition-ledger", password, "local"],
    queryFn: () => loadDispositionLedger(password),
    enabled: unlocked && password !== null,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

const formatCompactTEL = (value: number) => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
};

const formatUsd = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const explorerTx = (chain: string, hash: string) =>
  chain === "polygon"
    ? `https://polygonscan.com/tx/${hash}`
    : `https://etherscan.io/tx/${hash}`;

const summarizeSells = (sells: TelDispositionSell[]) => {
  let totalTelSold = 0;
  let totalQuoteProceedsUsd = 0;
  let sellsWithQuote = 0;
  let sellsWithProceed = 0;
  let sellsWithoutQuote = 0;
  let sellsWithoutProceed = 0;
  let sellsRetained = 0;
  for (const s of sells) {
    totalTelSold += s.telAmount;
    if (s.quoteAmount != null) {
      const stableUsd = stableQuoteUsd(s.quoteToken, s.quoteAmount);
      if (stableUsd) {
        totalQuoteProceedsUsd += stableUsd;
        sellsWithQuote += 1;
      } else {
        sellsWithoutQuote += 1;
      }
    } else {
      sellsWithoutQuote += 1;
    }
    if (s.proceedStatus === "retained_in_wallet" || s.proceedTo) {
      sellsWithProceed += 1;
      if (s.proceedStatus === "retained_in_wallet") sellsRetained += 1;
    } else {
      sellsWithoutProceed += 1;
    }
  }
  return {
    totalTelSold,
    totalQuoteProceedsUsd,
    sellCount: sells.length,
    sellsWithQuote,
    sellsWithProceed,
    sellsWithoutQuote,
    sellsWithoutProceed,
    sellsRetained,
  };
};

const railFromSells = (sells: TelDispositionSell[]): TelDispositionLedgerReport["polygon"] => {
  const sellCount = sells.length;
  const sellsWithProceed = sells.filter((s) => s.proceedStatus === "retained_in_wallet" || s.proceedTo).length;
  const telSold = sells.reduce((sum, s) => sum + s.telAmount, 0);
  const stableOutUsd = sells.reduce((sum, s) => sum + stableQuoteUsd(s.quoteToken, s.quoteAmount), 0);
  const payees = new Map<string, { usd: number; token: string; to: string }>();
  for (const s of sells) {
    const stableUsd = stableQuoteUsd(s.quoteToken, s.quoteAmount);
    if (!s.proceedTo || !stableUsd) continue;
    const token = s.proceedToken ?? s.quoteToken ?? "USD";
    const key = `${s.proceedTo}:${token}`;
    const existing = payees.get(key);
    if (existing) existing.usd += stableUsd;
    else payees.set(key, { usd: stableUsd, token, to: s.proceedTo });
  }
  return {
    stableOutUsd,
    telSold,
    sellCount,
    sellsWithProceed,
    topPayees: [...payees.values()].sort((a, b) => b.usd - a.usd).slice(0, 10),
  };
};

const HowToRead = () => (
  <Collapsible defaultOpen className="rounded-lg border border-border/50 bg-background/60">
    <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/40">
      How to read this
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
    <CollapsibleContent className="space-y-2 border-t border-border/50 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
      <p>
        The Telcoin Association holds TEL in several wallets — one per council, plus a few
        operating wallets that sell TEL. Treat each wallet as a cost center.
      </p>
      <ul className="list-disc space-y-1 pl-4">
        <li>
          <span className="font-medium text-foreground">Where stablecoin went</span> — after TEL was sold,
          whether USDC/USDT stayed in the selling wallet or was paid to vendors, payroll, exchanges, etc.
        </li>
        <li>
          <span className="font-medium text-foreground">Where TEL went</span> — all TEL that left Association
          wallets (sold, transferred, bridged).
        </li>
        <li>
          <span className="font-medium text-foreground">P&amp;L</span> — the same activity rolled
          up by wallet. Stablecoin from sales is income. TEL that left a wallet is listed by what
          happened to it. Sending TEL to another Association wallet is a transfer, not a cost.
        </li>
        <li>
          <span className="font-medium text-foreground">Burn forecast</span> — current monthly
          payout rate from the last few months of sales, expected spend from the TAO sheet, and
          how long current safes plus unswept sale proceeds last. TEL still held is inventory, not
          operating stablecoin.
        </li>
      </ul>
      <p>
        Pick a reporting period, then expand a line to open the on-chain receipts. Bridging TEL
        to Polygon or Base is a hop, not a destination — the landing (and what that wallet did
        next) is what these tables show. This records TEL and stablecoin when they move, not a
        GAAP income statement.
      </p>
    </CollapsibleContent>
  </Collapsible>
);

const PeriodFilter = ({
  periods,
  value,
  onChange,
}: {
  periods: DispositionPeriod[];
  value: string;
  onChange: (id: string) => void;
}) => {
  const selected = periods.find((p) => p.id === value) ?? periods[0];
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Reporting period</span>
        {selected ? ` · ${selected.start} – ${selected.end}` : null}
      </p>
      <select
        aria-label="Reporting period"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-md border border-border/60 bg-background px-2 text-[11px] text-foreground"
      >
        {PERIOD_GROUPS.map(({ group, label }) => (
          <optgroup key={group} label={label}>
            {periods
              .filter((p) => p.group === group)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
};

const MetricTile = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) => (
  <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-2">
    <p className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      {label}
      {hint ? <InfoTooltip text={hint} /> : null}
    </p>
    <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</p>
  </div>
);

const WhereStablecoinWentBuckets = ({ buckets }: { buckets: WhereStablecoinWentBucket[] }) => (
  <article className="space-y-2">
    <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">Where stablecoin went</h4>
    <p className="text-[10px] text-muted-foreground">
      USDC and USDT received from TEL sales in this period — whether it stayed in the selling wallet or was
      paid out. Expand a line for payees, transaction count, and dollar totals.
    </p>
    {buckets.length === 0 ? (
      <p className="text-[10px] text-muted-foreground">No stablecoin proceeds in this period.</p>
    ) : (
      <div className="divide-y divide-border/40 rounded-lg border border-border/40 bg-background/40">
        {buckets.map((bucket) => (
          <Collapsible key={bucket.cls}>
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left hover:bg-muted/40">
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {stablecoinProceedLabel(bucket.cls)}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-[11px] font-semibold tabular-nums text-foreground">
                {formatUsd(bucket.usd)}
                <span className="font-normal text-muted-foreground">
                  {bucket.txCount} {bucket.txCount === 1 ? "sale" : "sales"}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="px-2 pb-2">
              <div className="max-h-64 overflow-auto rounded-md border border-border/40">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px]">Payee</TableHead>
                      <TableHead className="text-[10px] text-right">Sales</TableHead>
                      <TableHead className="text-[10px] text-right">Stablecoin</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bucket.destinations.map((dest) => {
                      const label = dest.toLabel ?? stablecoinPayeeLabel(dest.to);
                      return (
                        <TableRow key={`${dest.chain}-${dest.to}-${dest.token}`}>
                          <TableCell className="max-w-[14rem] text-[10px]">
                            <a
                              href={explorerAddress(dest.chain, dest.to)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-foreground hover:underline"
                            >
                              <span className="truncate">{label ?? shortAddr(dest.to)}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                            </a>
                            {label && (
                              <div className="truncate font-mono text-[9px] text-muted-foreground">{shortAddr(dest.to)}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-right text-[10px] tabular-nums">{dest.txCount}</TableCell>
                          <TableCell className="text-right text-[10px] font-medium tabular-nums">
                            {formatUsd(dest.usd)}
                            {dest.token ? (
                              <span className="ml-0.5 font-normal text-muted-foreground">{dest.token}</span>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    )}
  </article>
);

const WhereTelWentBuckets = ({ buckets }: { buckets: WhereTelWentBucket[] }) => (
  <article className="space-y-2">
    <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">Where TEL went</h4>
    <p className="text-[10px] text-muted-foreground">
      All TEL that left Association wallets in this period — sold for stablecoin or transferred.
      Expand a line for destinations, transaction count, and totals.
      Chain hops are followed to the wallet or venue on the other chain — not listed as
      “Moved between blockchains”.
    </p>
    <div className="divide-y divide-border/40 rounded-lg border border-border/40 bg-background/40">
      {buckets.map((bucket) => (
        <Collapsible key={bucket.cls}>
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left hover:bg-muted/40">
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {classificationLabel(bucket.cls)}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-[11px] font-semibold tabular-nums text-foreground">
              {formatCompactTEL(bucket.tel)} TEL
              <span className="font-normal text-muted-foreground">
                {bucket.txCount} {bucket.txCount === 1 ? "tx" : "txs"}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="px-2 pb-2">
            <div className="max-h-64 overflow-auto rounded-md border border-border/40">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[10px]">Destination</TableHead>
                    <TableHead className="text-[10px] text-right">Transactions</TableHead>
                    <TableHead className="text-[10px] text-right">TEL</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bucket.destinations.map((dest) => (
                    <TableRow key={`${dest.chain}-${dest.to}`}>
                      <TableCell className="max-w-[14rem] truncate text-[10px]">
                        {dest.to ? (
                          <a
                            href={explorerAddress(dest.chain, dest.to)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-foreground hover:underline"
                          >
                            {dest.toLabel || shortAddr(dest.to)}
                            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-right text-[10px] tabular-nums">{dest.txCount}</TableCell>
                      <TableCell className="text-right text-[10px] font-medium tabular-nums">
                        {formatCompactTEL(dest.tel)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  </article>
);

const ChainRail = ({
  title,
  data,
}: {
  title: string;
  data: TelDispositionLedgerReport["polygon"];
}) => (
  <article className="space-y-2 rounded-lg border border-border/40 bg-background/40 p-3">
    <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">{title}</h4>
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
      <div className="flex justify-between gap-2">
        <dt className="text-muted-foreground">Stablecoin received</dt>
        <dd className="font-semibold tabular-nums">{formatUsd(data.stableOutUsd)}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-muted-foreground">TEL sold</dt>
        <dd className="font-semibold tabular-nums">{formatCompactTEL(data.telSold)}</dd>
      </div>
      <div className="flex justify-between gap-2">
        <dt className="text-muted-foreground">Stablecoin destination known</dt>
        <dd className="font-semibold tabular-nums">
          {data.sellsWithProceed} / {data.sellCount}
        </dd>
      </div>
    </dl>
    {data.topPayees.length > 0 && (
      <div className="pt-1">
        <p className="mb-1 text-[10px] text-muted-foreground">Largest stablecoin recipients</p>
        <ul className="space-y-0.5">
          {data.topPayees.slice(0, 5).map((p) => (
            <li key={`${p.to}-${p.token}`} className="flex justify-between gap-2 text-[11px]">
              <span className="truncate font-mono text-muted-foreground">{shortAddr(p.to)}</span>
              <span className="shrink-0 tabular-nums font-medium">{formatUsd(p.usd)}</span>
            </li>
          ))}
        </ul>
      </div>
    )}
  </article>
);

const SortHead = ({
  column,
  label,
  align = "left",
  sort,
  onSort,
}: {
  column: SalesJournalColumn;
  label: string;
  align?: "left" | "right";
  sort: SalesJournalSort | null;
  onSort: (column: SalesJournalColumn) => void;
}) => {
  const active = sort?.column === column;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("text-[10px]", align === "right" && "text-right")}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-0.5 hover:text-foreground",
          align === "right" && "w-full justify-end",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            !active && "opacity-40",
            active && sort.dir === "asc" && "rotate-180",
          )}
        />
      </button>
    </TableHead>
  );
};

export const TelDispositionLedger = () => {
  const { password, status, unlock } = useForensicsUnlock();
  const unlocked = status === "unlocked" && password !== null;
  const { data: report, isLoading, isError } = useTelDispositionLedger(password, unlocked);
  const [walletFilter, setWalletFilter] = useState<string>("all");
  const [view, setView] = useState("ledger");
  const [periodId, setPeriodId] = useState("all");
  const [journalSort, setJournalSort] = useState<SalesJournalSort | null>(null);
  const [includeThpl, setIncludeThpl] = useState(false);

  const walletOptions = useMemo(() => {
    if (!report) return [];
    const names = new Map<string, string>();
    for (const s of report.sells) names.set(s.fromWallet, s.fromName);
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [report]);

  const periods = useMemo(
    () => (report ? buildDispositionPeriods(report.window) : []),
    [report],
  );
  const period = periods.find((p) => p.id === periodId) ?? periods[0];

  const periodSells = useMemo(() => {
    if (!report || !period) return [];
    return filterByPeriod(report.sells, period);
  }, [report, period]);

  const periodEvents = useMemo(() => {
    if (!report || !period) return [];
    return filterByPeriod(report.events ?? [], period);
  }, [report, period]);

  const filteredSells = useMemo(() => {
    if (walletFilter === "all") return periodSells;
    return periodSells.filter((s) => s.fromWallet === walletFilter);
  }, [periodSells, walletFilter]);

  const journalRows = useMemo(
    () =>
      journalSort
        ? sortSalesJournal(filteredSells, journalSort.column, journalSort.dir)
        : filteredSells,
    [filteredSells, journalSort],
  );
  const onJournalSort = (column: SalesJournalColumn) =>
    setJournalSort((current) => nextSalesJournalSort(current, column));

  const periodSummary = useMemo(() => summarizeSells(periodSells), [periodSells]);

  const pnl = useMemo(() => {
    if (!report) return null;
    return buildDispositionPnl({
      wallets: report.wallets ?? [],
      events: periodEvents,
    });
  }, [report, periodEvents]);

  const whereTelWent = useMemo(() => buildWhereTelWent(periodEvents), [periodEvents]);

  const whereStablecoinWent = useMemo(() => buildWhereStablecoinWent(periodSells), [periodSells]);

  const polygonRail = railFromSells(periodSells.filter((s) => s.chain === "polygon"));
  const ethereumRail = railFromSells(periodSells.filter((s) => s.chain === "ethereum"));

  return (
    <section className="mt-5 rounded-xl border border-border/60 bg-muted/10 p-3 sm:p-4">
      <header className="flex items-start gap-2">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Association treasury ledger</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {unlocked
              ? "Sales of TEL for stablecoin, and where that stablecoin went — by council wallet."
              : "Sales of TEL for stablecoin, and where that stablecoin went — by council wallet. Password required."}
          </p>
        </div>
      </header>

      {!unlocked ? (
        <div className="mt-3">
          <ForensicsUnlockGate status={status} onUnlock={unlock} />
        </div>
      ) : isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading ledger…</p>
      ) : isError ? (
        <p className="mt-3 text-xs text-destructive">Could not load ledger.</p>
      ) : !report ? (
        <p className="mt-3 text-xs text-muted-foreground">Ledger unavailable.</p>
      ) : (
        <div className="mt-3 space-y-4">
          <HowToRead />

          <div className="rounded-lg border border-border/50 bg-background/60 p-3">
            <p className="text-sm font-medium text-foreground">
              {`In this period, Association wallets sold ${formatCompactTEL(periodSummary.totalTelSold)} TEL for ${formatUsd(periodSummary.totalQuoteProceedsUsd)} in stablecoin${
                periodSummary.sellsRetained > 0
                  ? `. ${periodSummary.sellsRetained} of those sales still have the stablecoin sitting in the selling wallet.`
                  : "."
              }`}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {`On-chain records from Ethereum and Polygon${period ? ` · ${period.start} – ${period.end}` : ""}. Updated ${new Date(report.generated).toLocaleString()}.`}
            </p>
          </div>

          {period && view !== "burn" && <PeriodFilter periods={periods} value={period.id} onChange={setPeriodId} />}

          <SubPanelTabs panels={LEDGER_VIEWS} value={view} onValueChange={setView}>
            <TabsContent value="ledger" className="mt-3 space-y-4 focus-visible:outline-none">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetricTile
              label="TEL sold"
              value={`${formatCompactTEL(periodSummary.totalTelSold)} TEL`}
              hint="How many TEL tokens were converted into stablecoin in this period."
            />
            <MetricTile
              label="Stablecoin received"
              value={formatUsd(periodSummary.totalQuoteProceedsUsd)}
              hint="USDC or USDT received when those TEL tokens were sold."
            />
            <MetricTile
              label="Sales recorded"
              value={`${periodSummary.sellCount}`}
              hint="Number of on-chain sales in this period. Each row in the journal below is one sale."
            />
            <MetricTile
              label="Stablecoin destination known"
              value={`${periodSummary.sellsWithProceed} / ${periodSummary.sellCount}`}
              hint="How many sales we can follow through to the wallet that received the stablecoin."
            />
          </div>

          {(periodSummary.sellsWithoutQuote > 0 ||
            periodSummary.sellsWithoutProceed > 0 ||
            periodSummary.sellsRetained > 0) && (
            <div className="flex flex-wrap gap-2">
              {periodSummary.sellsWithoutQuote > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  {periodSummary.sellsWithoutQuote} sales missing a stablecoin amount
                </Badge>
              )}
              {periodSummary.sellsWithoutProceed > 0 && (
                <Badge variant="outline" className="text-[10px]">
                  {periodSummary.sellsWithoutProceed} sales with unknown stablecoin destination
                </Badge>
              )}
              {periodSummary.sellsRetained > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {periodSummary.sellsRetained} stablecoin still in the selling wallet
                </Badge>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {polygonRail && <ChainRail title="Sold on Polygon" data={polygonRail} />}
            {ethereumRail && <ChainRail title="Sold on Ethereum" data={ethereumRail} />}
          </div>

          <WhereStablecoinWentBuckets buckets={whereStablecoinWent} />

          <WhereTelWentBuckets buckets={whereTelWent} />

          <article className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">
                Sales journal ({filteredSells.length})
              </h4>
              <select
                aria-label="Sold from"
                value={walletFilter}
                onChange={(e) => setWalletFilter(e.target.value)}
                className="h-7 rounded-md border border-border/60 bg-background px-2 text-[11px] text-foreground"
              >
                <option value="all">All wallets</option>
                {walletOptions.map(([addr, name]) => (
                  <option key={addr} value={addr}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="max-h-80 overflow-auto rounded-lg border border-border/40">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead column="date" label="Date" sort={journalSort} onSort={onJournalSort} />
                    <SortHead column="from" label="Sold from" sort={journalSort} onSort={onJournalSort} />
                    <SortHead
                      column="tel"
                      label="TEL sold"
                      align="right"
                      sort={journalSort}
                      onSort={onJournalSort}
                    />
                    <SortHead
                      column="stablecoin"
                      label="Stablecoin received"
                      align="right"
                      sort={journalSort}
                      onSort={onJournalSort}
                    />
                    <SortHead
                      column="payee"
                      label="Stablecoin went to"
                      sort={journalSort}
                      onSort={onJournalSort}
                    />
                    <TableHead className="w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {journalRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-[11px] text-muted-foreground">
                        No TEL sales in this period.
                      </TableCell>
                    </TableRow>
                  ) : (
                    journalRows.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                        {s.timestamp
                          ? new Date(s.timestamp * 1000).toLocaleDateString()
                          : `#${s.block}`}
                      </TableCell>
                      <TableCell className="max-w-[7rem] truncate text-[10px]">{s.fromName}</TableCell>
                      <TableCell className="text-right text-[10px] tabular-nums">
                        {formatCompactTEL(s.telAmount)}
                      </TableCell>
                      <TableCell className="text-right text-[10px] tabular-nums">
                        {stableQuoteUsd(s.quoteToken, s.quoteAmount) ? (
                          <>
                            {formatUsd(stableQuoteUsd(s.quoteToken, s.quoteAmount))}
                            {s.quoteMatch === "neighbor_imputed" && (
                              <span className="ml-1 text-muted-foreground">*</span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="max-w-[8rem] truncate text-[10px]">
                        {s.proceedStatus === "retained_in_wallet" ? (
                          <span className="text-muted-foreground">still in {s.fromName}</span>
                        ) : s.proceedTo ? (
                          <span>
                            <span className="block truncate">
                              {stablecoinPayeeLabel(s.proceedTo) ?? shortAddr(s.proceedTo)}
                            </span>
                            {stablecoinPayeeLabel(s.proceedTo) ? (
                              <span className="font-mono text-[9px] text-muted-foreground">{shortAddr(s.proceedTo)}</span>
                            ) : null}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="p-1">
                        <a
                          href={explorerTx(s.chain, s.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                          aria-label="View on-chain receipt"
                        >
                          Receipt
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </TableCell>
                    </TableRow>
                  ))
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="text-[10px] text-muted-foreground">
              * Stablecoin amount estimated from nearby sales of the same wallet (the trade settled in a
              way that did not leave a clean stablecoin amount on the same transaction).
            </p>
          </article>
            </TabsContent>
            <TabsContent value="pnl" className="mt-3 focus-visible:outline-none">
              {pnl && period ? (
                <DispositionPnlView
                  pnl={pnl}
                  period={{ start: period.start, end: period.end }}
                  periodLabel={period.label}
                />
              ) : (
                <p className="text-xs text-muted-foreground">P&amp;L is not available for this period.</p>
              )}
            </TabsContent>
            <TabsContent value="burn" className="mt-3 focus-visible:outline-none">
              {report.burnPlan ? (
                <BurnForecastView
                  plan={report.burnPlan}
                  events={report.sells}
                  associationAddresses={(report.wallets ?? []).map((w) => w.address)}
                  includeThpl={includeThpl}
                  onIncludeThpl={setIncludeThpl}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Burn forecast is not in this ledger snapshot yet.
                </p>
              )}
            </TabsContent>
          </SubPanelTabs>
        </div>
      )}
    </section>
  );
};
