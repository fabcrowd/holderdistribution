import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, Lock } from "lucide-react";
import { ForensicsUnlockGate, useForensicsUnlock } from "@/components/ForensicsGate";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUserRole } from "@/hooks/useUserRole";
import { loadWalletFlows } from "@/lib/loadForensics";
import {
  FLOW_WINDOWS,
  addressExplorerUrl,
  type WalletFlowsKnownWallet,
  type WalletFlowsReport,
} from "@/lib/walletFlowsTypes";

/**
 * Gated "Wallet flows" view: supply by entity class, Telcoin-linked wallets and
 * their sell-venue outflows, the bot cluster, and recent large sellers.
 *
 * Nothing in this file is data: the report is fetched from the forensics gate
 * function only after a password (or admin session) unlocks it.
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

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const CHAIN_SHORT: Record<string, string> = { ethereum: "ETH", polygon: "POL", base: "BASE" };

const CLASS_COLOR: Record<string, string> = {
  telcoin: "bg-sky-500",
  locked: "bg-slate-400",
  market: "bg-amber-500",
  other: "bg-zinc-400",
  retail: "bg-emerald-500",
};

const confidenceVariant = (c: string): "default" | "secondary" | "outline" | "destructive" =>
  c === "confirmed" ? "default" : c === "high" ? "secondary" : "outline";

const verdictTone = (v: string) =>
  v.startsWith("selling") ? "text-destructive font-semibold" : v.startsWith("inactive") ? "text-muted-foreground" : "text-foreground";

const AddressLinks = ({ address, chains }: { address: string; chains: string[] }) => {
  const list = chains.length > 0 ? chains : ["ethereum"];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <a
        href={addressExplorerUrl(list[0], address)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-[11px] text-primary hover:underline"
        title={address}
      >
        {shortAddress(address)}
      </a>
      {list.map((c) => (
        <a
          key={c}
          href={addressExplorerUrl(c, address)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border border-border/60 px-1 text-[9px] font-semibold uppercase text-muted-foreground hover:text-foreground"
          aria-label={`${address} on ${c} explorer`}
        >
          {CHAIN_SHORT[c] ?? c}
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
  return (
    <section className="rounded-lg border border-border/50 bg-background/60 p-3" aria-labelledby="wf-distribution">
      <h4 id="wf-distribution" className="text-sm font-semibold text-foreground">
        Supply distribution by entity
      </h4>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {`${formatTel(distribution.counted)} TEL counted${distribution.asOf ? ` · as of ${distribution.asOf}` : ""}. Tracked wallets the public reconciliation leaves in "retail" (staking contract, deposit relays, tracked bots and sellers) are moved to their class.`}
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

const KnownWalletsTable = ({ report }: { report: WalletFlowsReport }) => {
  const [onlySelling, setOnlySelling] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(
    () => (onlySelling ? report.knownWallets.filter((w) => w.sellVenue["90d"] > 0) : report.knownWallets),
    [report, onlySelling],
  );
  return (
    <section className="rounded-lg border border-border/50 bg-background/60 p-3" aria-labelledby="wf-known">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 id="wf-known" className="text-sm font-semibold text-foreground">
            Telcoin-linked wallets
          </h4>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            TEL sent to sell venues (CEX, DEX, bot cluster) per window. Click a row for its source, every outflow type and sample transactions.
          </p>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={onlySelling} onChange={(e) => setOnlySelling(e.target.checked)} />
          Only wallets that reached sell venues
        </label>
      </div>
      <div className="mt-2 overflow-x-auto">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Wallet</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Address</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              {FLOW_WINDOWS.map((w) => (
                <TableHead key={w} className="text-right whitespace-nowrap">
                  Sell venues {w}
                </TableHead>
              ))}
              <TableHead>Verdict</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((w: WalletFlowsKnownWallet) => {
              const expanded = open === w.address;
              return (
                <Fragment key={w.address}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => setOpen(expanded ? null : w.address)}
                    aria-expanded={expanded}
                    data-testid="wf-known-row"
                  >
                    <TableCell className="min-w-[12rem]">
                      <span className="inline-flex items-center gap-1 font-medium text-foreground">
                        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
                        {w.label}
                      </span>
                      <span className="block pl-4 text-[10px] text-muted-foreground">{w.group}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={confidenceVariant(w.confidence)} className="text-[10px]">
                        {w.confidence}
                      </Badge>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <AddressLinks address={w.address} chains={w.chains} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatTel(w.balance)}</TableCell>
                    {FLOW_WINDOWS.map((win) => (
                      <TableCell key={win} className="text-right tabular-nums">
                        {w.sellVenue[win] > 0 ? formatTel(w.sellVenue[win]) : "—"}
                      </TableCell>
                    ))}
                    <TableCell className={`min-w-[9rem] ${verdictTone(w.verdict)}`}>{w.verdict}</TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={8} className="space-y-1.5 text-[11px]">
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
                                <ExternalLink className="h-3 w-3" />
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
  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-lg border border-border/50 bg-background/60 p-3" aria-labelledby="wf-bot">
        <h4 id="wf-bot" className="text-sm font-semibold text-foreground">
          {bot.label}
        </h4>
        {bot.note && <p className="mt-0.5 text-[11px] text-muted-foreground">{bot.note}</p>}
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
      <div className="rounded-lg border border-border/50 bg-background/60 p-3" aria-labelledby="wf-funding">
        <h4 id="wf-funding" className="text-sm font-semibold text-foreground">
          Funding links
        </h4>
        <ul className="mt-2 space-y-2 text-[11px]">
          {report.fundingLinks.map((f, i) => (
            <li key={i}>
              <p className="text-foreground">
                <span className="font-medium">{f.from}</span> → <span className="font-medium">{f.to}</span>
                {f.tel ? ` · ${formatTel(f.tel)} TEL` : ""}
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

const LargeSellers = ({ report }: { report: WalletFlowsReport }) => (
  <section className="rounded-lg border border-border/50 bg-background/60 p-3" aria-labelledby="wf-sellers">
    <h4 id="wf-sellers" className="text-sm font-semibold text-foreground">
      Recent large sellers ({report.largeSellersWindow ?? "last 72h"})
    </h4>
    <p className="mt-0.5 text-[11px] text-muted-foreground">
      Net TEL sent to exchanges and DEXs. Upgrades, bridges and arbitrage bots that bought as much as they sold are excluded.
    </p>
    <div className="mt-2 overflow-x-auto">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Seller</TableHead>
            <TableHead>Addresses</TableHead>
            <TableHead>Destination</TableHead>
            <TableHead className="text-right">TEL</TableHead>
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
                    <span className="text-[10px] text-muted-foreground">+{s.addresses.length - 3} more (see bot cluster)</span>
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

const Summary = ({ report }: { report: WalletFlowsReport }) => (
  <div className="rounded-lg border border-border/50 bg-background/60 p-3">
    <p className="text-sm font-medium text-foreground">Telcoin-linked wallets → sell venues (unique TEL, relays not double counted)</p>
    <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
      {FLOW_WINDOWS.map((w) => (
        <div key={w}>
          <dt className="text-muted-foreground">{w}</dt>
          <dd className="font-semibold tabular-nums">
            {formatTel(report.telcoinTotals[w]?.total ?? 0)} TEL
            <span className="block font-normal text-muted-foreground">{formatUsd(report.telcoinTotals[w]?.usd ?? 0)}</span>
          </dd>
        </div>
      ))}
    </dl>
    <p className="mt-2 text-[11px] text-muted-foreground">
      {`Generated ${new Date(report.generated).toLocaleString()} · price $${report.priceUsd} (${report.priceSource}) · chains: ${report.chains.join(", ")}`}
    </p>
  </div>
);

export const WalletFlowsPanel = () => {
  const { password, status, unlock } = useForensicsUnlock();
  const { isAdmin } = useUserRole();
  const unlocked = isAdmin || (status === "unlocked" && password !== null);
  const { data: report, isLoading, isError } = useQuery({
    queryKey: ["wallet-flows", password, isAdmin],
    queryFn: () => loadWalletFlows(password),
    enabled: unlocked,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <section className="rounded-xl border border-border/60 bg-muted/10 p-3 sm:p-4" aria-labelledby="wf-title">
      <header className="flex items-start gap-2">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h3 id="wf-title" className="text-sm font-semibold text-foreground">
            Wallet flows
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Supply by entity, Telcoin-linked wallets and their exchange/DEX outflows, and recent large sellers.
            {!unlocked && " Password required."}
          </p>
        </div>
      </header>

      {!unlocked ? (
        <div className="mt-3">
          <ForensicsUnlockGate status={status} onUnlock={unlock} />
        </div>
      ) : isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading wallet flows…</p>
      ) : isError || !report ? (
        <p className="mt-3 text-xs text-destructive">Could not load wallet flows.</p>
      ) : (
        <div className="mt-3 space-y-4" data-testid="wallet-flows-report">
          <Summary report={report} />
          <DistributionBars report={report} />
          <KnownWalletsTable report={report} />
          <BotAndFunding report={report} />
          <LargeSellers report={report} />
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
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
