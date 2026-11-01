import { Fragment, useMemo, useState } from "react";
import { AsOfBadge } from "@/components/AsOfBadge";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ExternalLink, Lock, LockOpen, Search, ShieldCheck } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_WALLET_SORT,
  filterWallets,
  nextSort,
  shortAddress,
  sortWallets,
  verdictTone as toneOf,
  type WalletSortKey,
} from "@/lib/walletFlowsTable";
import { ForensicsUnlockGate, useForensicsUnlock } from "@/components/ForensicsGate";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUserRole } from "@/hooks/useUserRole";
import { useProject } from "@/hooks/useProject";
import { useProjectCopy } from "@/hooks/useProjectCopy";
import { loadWalletFlows } from "@/lib/loadForensics";
import {
  FLOW_WINDOWS,
  addressExplorerUrl,
  type WalletFlowsKnownWallet,
  type WalletFlowsReport,
} from "@/lib/walletFlowsTypes";
import { explorerTemplates, resolveChainVm } from "@/lib/explorerLinks";

/**
 * Gated "Wallet flows" view: supply by entity class, project-linked wallets and
 * their sell-venue outflows, the bot cluster, and recent large sellers.
 *
 * Nothing in this file is data: the active project's report is fetched from the
 * forensics gate function only after a password (or admin session) unlocks it
 * (paywall later). Same panels for every project; a project with no report yet
 * gets an empty state. Copy is templated ({ticker}/{name}); TEL's exact wording
 * comes out of the same templates or its config overrides.
 */
const formatTel = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat().format(Math.round(value));
};

const formatUsd = (value: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);


const CLASS_COLOR: Record<string, string> = {
  telcoin: "bg-sky-500",
  locked: "bg-slate-400",
  market: "bg-amber-500",
  other: "bg-zinc-400",
  retail: "bg-emerald-500",
};

const confidenceVariant = (c: string): "default" | "secondary" | "outline" | "destructive" =>
  c === "confirmed" ? "default" : c === "high" ? "secondary" : "outline";

const VERDICT_CLASS = {
  selling: "border-negative/40 bg-negative-tint text-negative",
  inactive: "border-border/60 bg-muted/40 text-muted-foreground",
  neutral: "border-brand/30 bg-brand-tint text-brand",
} as const;

const VerdictBadge = ({ verdict }: { verdict: string }) => (
  <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium leading-snug ${VERDICT_CLASS[toneOf(verdict)]}`}>
    {verdict}
  </span>
);

const AddressLinks = ({ address, chains }: { address: string; chains: string[] }) => {
  const { project } = useProject();
  const explorers = useMemo(
    // EVM: explorer root; Solana: the address template (Solscan /account/{address}).
    () =>
      Object.fromEntries(
        (project.chains ?? []).map((c) => [c.key, resolveChainVm(c) === "solana" ? explorerTemplates(c).address : c.explorer ?? ""]),
      ),
    [project],
  );
  const list = chains.length > 0 ? chains : [project.chains?.[0]?.key ?? ""];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <a
        href={addressExplorerUrl(list[0], address, explorers)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-xs text-primary hover:underline"
        title={address}
      >
        {shortAddress(address)}
      </a>
      <CopyButton value={address} label={`address ${address}`} />
      {list.filter(Boolean).map((c) => (
        <a
          key={c}
          href={addressExplorerUrl(c, address, explorers)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border border-border/60 px-1.5 py-0.5 text-xs font-semibold uppercase text-muted-foreground hover:border-primary/50 hover:text-foreground"
          aria-label={`${address} on ${c} explorer`}
        >
          {project.chains?.find((pc) => pc.key === c)?.shortName ?? c.toUpperCase()}
        </a>
      ))}
    </span>
  );
};

const Breakdown = ({ values }: { values: Record<string, number> }) => {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <span>
      {entries.map(([k, v], i) => (
        <Fragment key={k}>
          {i > 0 && " · "}
          {k} {formatTel(v)}
        </Fragment>
      ))}
    </span>
  );
};

const DistributionBars = ({ report }: { report: WalletFlowsReport }) => {
  const { distribution } = report;
  const { ticker } = useProjectCopy();
  return (
    <section className="rounded-xl border border-border/50 bg-card p-3 sm:p-4" aria-labelledby="wf-distribution">
      <h4 id="wf-distribution" className="text-base font-semibold text-foreground">
        Supply distribution by entity
      </h4>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {`${formatTel(distribution.counted)} ${ticker} counted${distribution.asOf ? ` · as of ${distribution.asOf}` : ""}. Tracked wallets the public reconciliation leaves in "retail" (staking contract, deposit relays, tracked bots and sellers) are moved to their class.`}
      </p>
      <ul className="mt-3 space-y-2">
        {distribution.classes.map((c) => (
          <li key={c.key} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-foreground">{c.label}</span>
              <span className="shrink-0 tabular-nums font-medium">
                {formatTel(c.tel)} <span className="text-muted-foreground font-normal">{(c.share * 100).toFixed(2)}%</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
              <div
                className={`h-1.5 rounded-full ${CLASS_COLOR[c.group] ?? "bg-primary"}`}
                style={{ width: `${Math.max(c.share * 100, c.tel > 0 ? 0.4 : 0)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};

const SortHeader = ({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: WalletSortKey;
  sort: { key: WalletSortKey; dir: "asc" | "desc" };
  onSort: (k: WalletSortKey) => void;
  align?: "left" | "right";
}) => {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`whitespace-nowrap ${align === "right" ? "text-right" : ""}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 rounded px-1 py-1 -mx-1 font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          active ? "text-foreground" : ""
        }`}
      >
        {label}
        <Icon aria-hidden="true" className={`h-3 w-3 ${active ? "" : "opacity-40"}`} />
      </button>
    </TableHead>
  );
};

const KnownWalletsTable = ({ report }: { report: WalletFlowsReport }) => {
  const [onlySelling, setOnlySelling] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(DEFAULT_WALLET_SORT);
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(
    () => sortWallets(filterWallets(report.knownWallets, { query, onlySelling }), sort.key, sort.dir),
    [report, query, onlySelling, sort],
  );
  const onSort = (k: WalletSortKey) => setSort((cur) => nextSort(cur, k));
  const { t } = useProjectCopy();
  return (
    <section className="rounded-xl border border-border/50 bg-card p-3 sm:p-4" aria-labelledby="wf-known">
      <div>
        <h4 id="wf-known" className="text-base font-semibold text-foreground">
          {t("{name}-linked wallets")}
        </h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("{ticker}")} sent to sell venues (exchanges, DEXs, the bot cluster) in each window. Expand a row for its label source, every outflow type and sample transactions.
        </p>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, group or address"
            aria-label={t("Search {name}-linked wallets")}
            className="h-10 pl-9 text-sm"
          />
        </div>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <label className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[hsl(var(--primary))]"
              checked={onlySelling}
              onChange={(e) => setOnlySelling(e.target.checked)}
            />
            Only wallets that reached sell venues
          </label>
          <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {rows.length} of {report.knownWallets.length}
          </span>
        </div>
      </div>
      <div className="mt-2 overflow-x-auto rounded-lg border border-border/40">
        <Table className="text-xs">
          <TableHeader className="bg-muted/40">
            <TableRow>
              <SortHeader label="Wallet" sortKey="label" sort={sort} onSort={onSort} />
              <TableHead>Confidence</TableHead>
              <TableHead>Address</TableHead>
              <SortHeader label="Balance" sortKey="balance" sort={sort} onSort={onSort} align="right" />
              {FLOW_WINDOWS.map((w) => (
                <SortHeader key={w} label={`Sold ${w}`} sortKey={w} sort={sort} onSort={onSort} align="right" />
              ))}
              <TableHead>Verdict</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                  No wallets match{query ? ` "${query}"` : ""}.
                </TableCell>
              </TableRow>
            )}
            {rows.map((w: WalletFlowsKnownWallet) => {
              const expanded = open === w.address;
              const detailId = `wf-detail-${w.address}`;
              return (
                <Fragment key={w.address}>
                  <TableRow data-testid="wf-known-row" className={expanded ? "bg-muted/20" : undefined}>
                    <TableCell className="min-w-[13rem]">
                      <button
                        type="button"
                        onClick={() => setOpen(expanded ? null : w.address)}
                        aria-expanded={expanded}
                        aria-controls={expanded ? detailId : undefined}
                        className="inline-flex items-start gap-1.5 rounded text-left font-medium text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ChevronDown aria-hidden="true" className={`mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
                        <span>
                          {w.label}
                          <span className="block text-xs font-normal text-muted-foreground">{w.group}</span>
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge variant={confidenceVariant(w.confidence)} className="text-xs capitalize">
                        {w.confidence}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <AddressLinks address={w.address} chains={w.chains} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatTel(w.balance)}</TableCell>
                    {FLOW_WINDOWS.map((win) => (
                      <TableCell key={win} className={`text-right tabular-nums ${w.sellVenue[win] > 0 ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                        {w.sellVenue[win] > 0 ? formatTel(w.sellVenue[win]) : "—"}
                      </TableCell>
                    ))}
                    <TableCell className="min-w-[10rem]">
                      <VerdictBadge verdict={w.verdict} />
                    </TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow id={detailId} className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={8} className="space-y-1.5 text-xs">
                        <p>
                          <span className="font-semibold">Label source:</span> {w.source}
                        </p>
                        <p>
                          <span className="font-semibold">Full address:</span>{" "}
                          <span className="font-mono break-all">{w.address}</span>
                          {Object.keys(w.balanceDetail).length > 0 && (
                            <span className="text-muted-foreground">
                              {" "}
                              · balance by chain/token: <Breakdown values={w.balanceDetail} />
                            </span>
                          )}
                        </p>
                        {FLOW_WINDOWS.map((win) => (
                          <p key={win}>
                            <span className="font-semibold">All outflows {win}:</span> <Breakdown values={w.outflows[win]} />
                          </p>
                        ))}
                        {w.sellVenueUsd90d > 0 && <p>≈ {formatUsd(w.sellVenueUsd90d)} to sell venues in 90d</p>}
                        {w.sampleTxs.length > 0 && (
                          <p className="flex flex-wrap gap-2">
                            <span className="font-semibold">Sample transactions:</span>
                            {w.sampleTxs.map((url) => (
                              <a
                                key={url}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 font-mono text-primary hover:underline"
                              >
                                {url.split("/tx/")[1]?.slice(0, 10)}…
                                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                              </a>
                            ))}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
};

const BotAndFunding = ({ report }: { report: WalletFlowsReport }) => {
  const bot = report.botCluster;
  const { ticker } = useProjectCopy();
  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-xl border border-border/50 bg-card p-3 sm:p-4" aria-labelledby="wf-bot">
        <h4 id="wf-bot" className="text-base font-semibold text-foreground">
          {bot.label}
        </h4>
        {bot.note && <p className="mt-0.5 text-xs text-muted-foreground">{bot.note}</p>}
        <dl className="mt-2 grid grid-cols-4 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Holds</dt>
            <dd className="font-semibold tabular-nums">{formatTel(bot.balance)}</dd>
          </div>
          {FLOW_WINDOWS.map((w) => (
            <div key={w}>
              <dt className="text-muted-foreground">DEX sales {w}</dt>
              <dd className="font-semibold tabular-nums">{formatTel(bot.dexSales[w] ?? 0)}</dd>
            </div>
          ))}
        </dl>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {bot.addresses.map((a) => (
            <li key={a}>
              <AddressLinks address={a} chains={[bot.chain]} />
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-xl border border-border/50 bg-card p-3 sm:p-4" aria-labelledby="wf-funding">
        <h4 id="wf-funding" className="text-base font-semibold text-foreground">
          Funding links
        </h4>
        <ul className="mt-2 space-y-2 text-xs">
          {report.fundingLinks.map((f, i) => (
            <li key={i}>
              <p className="text-foreground">
                <span className="font-medium">{f.from}</span> → <span className="font-medium">{f.to}</span>
                {f.tel ? ` · ${formatTel(f.tel)} ${ticker}` : ""}
                {f.when ? ` · ${f.when}` : ""}
              </p>
              <p className="text-muted-foreground">
                Confidence: {f.confidence}
                {f.note ? ` · ${f.note}` : ""}
                {f.onward ? ` · onward: ${f.onward}` : ""}
              </p>
              {f.sampleTxs?.map((url) => (
                <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="mr-2 font-mono text-primary hover:underline">
                  {url.split("/tx/")[1]?.slice(0, 10)}…
                </a>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};

const LargeSellers = ({ report }: { report: WalletFlowsReport }) => {
  const { ticker } = useProjectCopy();
  return (
  <section className="rounded-xl border border-border/50 bg-card p-3 sm:p-4" aria-labelledby="wf-sellers">
    <h4 id="wf-sellers" className="text-base font-semibold text-foreground">
      Recent large sellers ({report.largeSellersWindow ?? "last 72h"})
    </h4>
    <p className="mt-0.5 text-xs text-muted-foreground">
      Net {ticker} sent to exchanges and DEXs. Upgrades, bridges and arbitrage bots that bought as much as they sold are excluded.
    </p>
    <div className="mt-2 overflow-x-auto">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Seller</TableHead>
            <TableHead>Addresses</TableHead>
            <TableHead>Destination</TableHead>
            <TableHead className="text-right">{ticker}</TableHead>
            <TableHead className="text-right">≈ USD</TableHead>
            <TableHead>Sample</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.largeSellers.map((s) => (
            <TableRow key={`${s.rank}-${s.entity}`} data-testid="wf-seller-row">
              <TableCell>{s.rank}</TableCell>
              <TableCell className="min-w-[10rem] font-medium">{s.entity}</TableCell>
              <TableCell className="min-w-[10rem]">
                <span className="flex flex-col gap-0.5">
                  {s.addresses.slice(0, 3).map((a) => (
                    <AddressLinks key={a} address={a} chains={s.chains} />
                  ))}
                  {s.addresses.length > 3 && (
                    <span className="text-xs text-muted-foreground">+{s.addresses.length - 3} more (see bot cluster)</span>
                  )}
                </span>
              </TableCell>
              <TableCell className="min-w-[10rem]">{s.destination}</TableCell>
              <TableCell className="text-right tabular-nums">{formatTel(s.tel)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatUsd(s.usd)}</TableCell>
              <TableCell>
                {s.sampleTx ? (
                  <a href={s.sampleTx} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                    tx <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  "—"
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </section>
  );
};

const Summary = ({ report }: { report: WalletFlowsReport }) => {
  const { t, ticker } = useProjectCopy();
  return (
  <section aria-labelledby="wf-summary" className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <h4 id="wf-summary" className="text-base font-semibold text-foreground">
        {t("{name}-linked {ticker} sent to sell venues")}
      </h4>
      <AsOfBadge iso={report.generated} testId="wallet-flows-asof" />
    </div>
    <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
      {FLOW_WINDOWS.map((w) => (
        <div key={w} className="rounded-xl border border-border/50 bg-card p-3 sm:p-4">
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last {w}</dt>
          <dd className="mt-1">
            <span className="text-2xl font-extrabold tracking-tight tabular-nums text-foreground">
              {formatTel(report.telcoinTotals[w]?.total ?? 0)}
            </span>{" "}
            <span className="text-sm font-medium text-muted-foreground">{ticker}</span>
            <span className="block text-xs tabular-nums text-muted-foreground">≈ {formatUsd(report.telcoinTotals[w]?.usd ?? 0)}</span>
          </dd>
        </div>
      ))}
    </dl>
    <p className="text-xs text-muted-foreground">
      {`Unique ${ticker} (relays not double counted). Report generated ${new Date(report.generated).toLocaleString()} · price $${report.priceUsd} (${report.priceSource}) · chains: ${report.chains.join(", ")}`}
    </p>
  </section>
  );
};

/** What the locked panel promises. Ids are copy.text keys (TEL overrides the supply line). */
const LOCKED_CONTENTS: ReadonlyArray<readonly [string, string]> = [
  ["walletFlows.locked.supply", "Supply split by entity: {name} treasury, team and foundation wallets, escrow, exchanges, DEX pools and retail"],
  ["walletFlows.locked.wallets", "Every {name}-linked wallet with address, balance and {ticker} sent to exchanges or DEXs over 72h, 30d and 90d"],
  ["walletFlows.locked.sellers", "Recent large sellers and how the wallets behind them were funded"],
];

export const WalletFlowsPanel = () => {
  const { password, status, unlock, lock } = useForensicsUnlock();
  const { isAdmin } = useUserRole();
  const { slug } = useProject();
  const { t, text, name } = useProjectCopy();
  const unlocked = isAdmin || (status === "unlocked" && password !== null);
  const { data: report, isLoading, isError, refetch } = useQuery({
    // Keyed by project: switching tokens loads that project's gated report.
    queryKey: ["wallet-flows", slug, password, isAdmin],
    queryFn: () => loadWalletFlows(password, slug),
    enabled: unlocked,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!unlocked) {
    return (
      <section className="rounded-2xl border border-border/60 bg-card p-4 sm:p-6" aria-labelledby="wf-title" data-testid="wallet-flows-locked">
        <div className="mx-auto max-w-xl">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Lock className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h3 id="wf-title" className="text-lg font-semibold text-foreground">
                Wallet flows
              </h3>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Restricted analysis. Wallet-level data is only sent to your browser after the password is checked on the server.
              </p>
            </div>
          </div>
          <ul className="mt-4 space-y-1.5 text-sm text-foreground/90">
            {LOCKED_CONTENTS.map(([id, tpl]) => (
              <li key={id} className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span>{text(id, tpl)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5">
            <ForensicsUnlockGate status={status} onUnlock={unlock} label="Password" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="wf-title">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="wf-title" className="inline-flex items-center gap-2 text-lg font-semibold text-foreground">
            <LockOpen className="h-4 w-4 text-primary" aria-hidden="true" />
            Wallet flows
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("Supply by entity, {name}-linked wallets and their exchange/DEX outflows, and recent large sellers.")}
          </p>
        </div>
        {!isAdmin && (
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={lock}>
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            Lock
          </Button>
        )}
      </header>

      {isLoading ? (
        <div role="status" className="space-y-3" aria-label="Loading wallet flows">
          <div className="grid gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 rounded-xl bg-muted/60 animate-pulse" />
            ))}
          </div>
          <div className="h-64 rounded-xl bg-muted/50 animate-pulse" />
          <span className="sr-only">Loading wallet flows…</span>
        </div>
      ) : isError ? (
        <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">Could not load wallet flows.</p>
          <p className="mt-1 text-muted-foreground">The server may be busy. Try again in a moment.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : !report ? (
        <div className="rounded-xl border border-border/50 bg-card p-4 text-sm" data-testid="wallet-flows-empty">
          <p className="font-medium text-foreground">No wallet-flows report for {name} yet.</p>
          <p className="mt-1 text-muted-foreground">
            This project has no wallet-level forensics mapped yet. The panels appear here once its report is generated.
          </p>
        </div>
      ) : (
        <div className="space-y-4" data-testid="wallet-flows-report">
          <Summary report={report} />
          <DistributionBars report={report} />
          <KnownWalletsTable report={report} />
          <BotAndFunding report={report} />
          <LargeSellers report={report} />
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};

export default WalletFlowsPanel;
