import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, LockOpen, ShieldCheck } from "lucide-react";
import { ForensicsUnlockGate, useForensicsUnlock } from "@/components/ForensicsGate";
import { StatStrip, type Stat } from "@/components/tierflow/StatStrip";
import { fmtInt, fmtTel } from "@/components/tierflow/format";
import { MUTED, NEGATIVE, NEUTRAL, POSITIVE } from "@/components/tierflow/palette";
import { useProject } from "@/hooks/useProject";
import { useUserRole } from "@/hooks/useUserRole";
import { loadBotProceeds, loadProjectLedger } from "@/lib/loadForensics";
import {
  dailyInWindow,
  eventsInWindow,
  flowEdges,
  LEDGER_WINDOWS,
  sellFrequency,
  windowForRange,
  type BotProceedsReport,
  type FlowEdge,
  type LedgerReport,
  type LedgerWindow,
} from "@/lib/projectWallets";
import { SummaryClaims } from "@/components/projectWallets/SummaryClaims";
import { matchFilter, summaryClaims, type TxFilter } from "@/lib/ledgerClaims";
import { AddressLink, TxLink } from "./AddressLink";
import { TxTypeBadge } from "./TxTypeBadge";

/**
 * Gated "Developer wallets" tab: what the project's developer wallets do with
 * the token, how much / how often they sell, where payments go, and repeating
 * patterns. Data: data/<slug>/ledger/{ledger,bot-proceeds}.json via the
 * forensics gate (never public/). Window defaults to 30d, or follows the page
 * range (RANGE_OPTIONS days) when given. See docs/LEDGER.md.
 */
const usd = (v: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
const EDGE_COLOR: Record<FlowEdge["kind"], string> = { sell: NEGATIVE, payment: POSITIVE, move: NEUTRAL, internal: MUTED };

/** Flow map: developer wallets -> destinations, bar width proportional to amount (tierflow palette/format). */
export const FlowMap = ({ edges, ticker }: { edges: FlowEdge[]; ticker: string }) => {
  if (!edges.length) return <p className="text-sm text-muted-foreground">No outflows in this window.</p>;
  const max = Math.max(...edges.map((e) => e.amount));
  return (
    <ul className="space-y-1.5" data-testid="pw-flow-map" aria-label="Where developer-wallet tokens went">
      {edges.map((e) => (
        <li key={e.key} className="grid grid-cols-[9rem_1fr_5rem] items-center gap-2 text-sm" title={e.tip}>
          <span className="truncate text-muted-foreground">{e.label}</span>
          <span className="h-3 rounded-sm bg-muted/50">
            <span className="block h-3 rounded-sm" style={{ width: `${Math.max(2, (100 * e.amount) / max)}%`, background: EDGE_COLOR[e.kind], opacity: e.kind === "internal" ? 0.5 : 0.85 }} />
          </span>
          <span className="text-right tabular-nums">{fmtTel(e.amount)} <span className="text-xs text-muted-foreground">{ticker}</span></span>
        </li>
      ))}
    </ul>
  );
};

/** 1-bar-per-day sell chart for the window. */
const DailyBars = ({ daily }: { daily: LedgerReport["daily"] }) => {
  const max = Math.max(1, ...daily.map((d) => d.devSold));
  return (
    <div className="flex h-16 items-end gap-px" aria-label="Developer selling per day" data-testid="pw-daily">
      {daily.map((d) => (
        <span key={d.date} className="flex-1 rounded-t-sm" title={`${d.date}: ${fmtTel(d.devSold)} sold`} style={{ height: `${(100 * d.devSold) / max}%`, minHeight: d.devSold > 0 ? 2 : 0, background: NEGATIVE }} />
      ))}
    </div>
  );
};

/** Bot cluster: why it is flagged (funding evidence with tx links), its sales, and where the proceeds went. */
export const BotClusterSection = ({ report, proceeds, win }: { report: LedgerReport; proceeds?: BotProceedsReport | null; win: LedgerWindow }) => {
  const b = report.botCluster!;
  const t = report.ticker;
  const ev = proceeds?.evidence;
  const sum = proceeds?.summary;
  return (
    <section id="pw-bot" aria-labelledby="pw-bot-h" className="space-y-3 rounded-lg border border-border/60 p-3 text-sm" data-testid="pw-bot">
      <h4 id="pw-bot-h" className="font-semibold">{b.label} · bot-cluster proceeds</h4>
      <p>{`${Math.round(b.devShare * 1000) / 10}% of its funding came from developer wallets, so that share of its ${fmtTel(b.windows[win]?.sold ?? 0)} ${t} sold in ${win} (${fmtInt(b.windows[win]?.sales ?? 0)} sales) counts as developer selling: ${fmtTel(b.windows[win]?.devShare ?? 0)} ${t}.`}</p>
      {ev && (
        <div data-testid="pw-bot-evidence">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Funding evidence</p>
          <ul className="space-y-1">
            {ev.funding.map((f) => (
              <li key={f.label} className="flex flex-wrap items-center gap-2">
                <span className={`rounded border px-1.5 py-0.5 text-xs ${f.counted ? "border-negative/40 text-negative" : "border-border/60 text-muted-foreground"}`}>{f.counted ? "developer, counted" : "external, not counted"}</span>
                {f.address ? <AddressLink chain={b.chain} address={f.address} label={f.label} /> : <span>{f.label}</span>}
                <span className="tabular-nums">{fmtTel(f.amount)} {t}</span>
                {f.txs.slice(0, 3).map((h) => <TxLink key={h} chain={b.chain} hash={h} />)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {sum && (
        <div data-testid="pw-bot-proceeds">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Proceeds traced ({fmtInt(sum.salesTraced)} sales, {fmtTel(sum.tokenSold)} {t}; developer share {fmtTel(sum.tokenSoldDevShare)})</p>
          <ul className="space-y-1">
            {sum.destinations.slice(0, 8).map((d, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{d.label ?? d.kind ?? "unlabelled"}</span>
                <span className="tabular-nums">{fmtTel(d.amount)} {d.symbol}</span>
                <span className="text-xs text-muted-foreground">dev share {fmtTel(d.devAttributed)} {d.symbol}</span>
                {d.sampleHashes.slice(0, 2).map((h) => <TxLink key={h} chain={b.chain} hash={h} />)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {b.recentSales.length > 0 && (
        <p className="text-xs text-muted-foreground">Latest bot sales: {b.recentSales.slice(0, 3).map((r) => <span key={r.hash} className="mr-2"><TxLink chain={b.chain} hash={r.hash} /> {fmtTel(r.amount)}</span>)}</p>
      )}
    </section>
  );
};

/** No mapped cluster: detection candidates (never counted) from trace-bot-proceeds.js. */
export const BotCandidatesSection = ({ proceeds, ticker }: { proceeds?: BotProceedsReport | null; ticker: string }) => {
  const c = proceeds?.detection?.candidates ?? [];
  return (
    <section id="pw-bot" aria-labelledby="pw-bot-h" className="space-y-2 rounded-lg border border-border/60 p-3 text-sm" data-testid="pw-bot-candidates">
      <h4 id="pw-bot-h" className="font-semibold">Bot cluster · none mapped</h4>
      <p className="text-xs text-muted-foreground">No bot cluster is mapped, so no bot sales count as developer selling. {c.length ? "Wallets the developer wallets keep funding are listed for review; they are not counted." : "No repeatedly funded wallets were detected."}</p>
      {c.length > 0 && (
        <ul className="space-y-1">
          {c.map((x) => (
            <li key={x.chain + x.address} className="flex flex-wrap items-center gap-2">
              <span className="rounded border border-border/60 px-1.5 py-0.5 text-xs text-muted-foreground">candidate, not counted</span>
              <AddressLink chain={x.chain} address={x.address} label={x.label} />
              <span className="text-xs uppercase text-muted-foreground">{x.chain}</span>
              <span className="tabular-nums">{fmtTel(x.amount)} {ticker} · funded {fmtInt(x.fundings)}×</span>
              {x.sampleHashes.slice(0, 3).map((h) => <TxLink key={h} chain={x.chain} hash={h} />)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export const LedgerBody = ({ report, proceeds, initialWindow }: { report: LedgerReport; proceeds?: BotProceedsReport | null; initialWindow: LedgerWindow }) => {
  const windows = LEDGER_WINDOWS.filter((w) => report.windows.includes(w));
  const [win, setWin] = useState<LedgerWindow>(windows.includes(initialWindow) ? initialWindow : report.defaultWindow);
  const s = report.byWindow[win];
  const t = report.ticker;
  const nowSec = Math.floor(Date.parse(report.generated) / 1000);
  const [filter, setFilter] = useState<TxFilter | null>(null);
  const windowEvents = useMemo(() => eventsInWindow(report.events, win, nowSec), [report, win, nowSec]);
  const events = useMemo(() => (filter ? windowEvents.filter((e) => matchFilter(e, filter)) : windowEvents).slice(0, 200), [windowEvents, filter]);
  const claims = useMemo(() => summaryClaims(report, win), [report, win]);
  const applyFilter = (f: TxFilter) => { setFilter(f); requestAnimationFrame(() => document.getElementById("pw-ev")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  const edges = useMemo(() => flowEdges(s, t), [s, t]);
  const sells = useMemo(() => windowEvents.filter((e) => e.headline), [windowEvents]);
  const stats: Stat[] = s
    ? [
        { key: "sold", label: "Developer sold", tip: report.rule, value: `${fmtTel(s.devSold.total)} ${t}`, tone: s.devSold.total > 0 ? "negative" : undefined },
        { key: "freq", label: "Days with selling", tip: "Days in the window with a DEX sale, exchange deposit or bot-cluster sale.", value: sellFrequency(s, win) },
        { key: "paid", label: "Stablecoins paid out", tip: "Stablecoins sent from developer wallets to outside wallets (internal moves excluded).", value: usd(s.payments.stableOut) },
      ]
    : [];
  const stale = Object.entries(report.coverage ?? {}).filter(([, c]) => typeof c?.status === "string" && c.status !== "ok");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Window">
        {windows.map((w) => (
          <button key={w} type="button" role="radio" aria-checked={w === win} onClick={() => { setWin(w); setFilter(null); }}
            className={`h-7 rounded px-2.5 text-xs font-semibold ${w === win ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}>
            {w}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">Generated {new Date(report.generated).toLocaleString()}</span>
      </div>
      {stale.length > 0 && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          Partial data: {stale.map(([k, c]) => `${k} (${c.status})`).join("; ")}.
        </p>
      )}
      <StatStrip stats={stats} testId="pw-stats" />
      {claims.length > 0 ? <SummaryClaims claims={claims} onFilter={applyFilter} /> : (
        <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="pw-headlines">
          {(report.headlines[win] ?? []).map((h) => <li key={h}>{h}</li>)}
        </ul>
      )}

      <section aria-labelledby="pw-flow"><h4 id="pw-flow" className="mb-2 text-sm font-semibold">Where the {t} went</h4><FlowMap edges={edges} ticker={t} /></section>
      <section aria-labelledby="pw-daily-h"><h4 id="pw-daily-h" className="mb-2 text-sm font-semibold">Selling per day</h4><DailyBars daily={dailyInWindow(report.daily, win)} /></section>

      {s && s.payments.topStableRecipients.length > 0 && (
        <section data-testid="pw-pay" aria-labelledby="pw-pay"><h4 id="pw-pay" className="mb-2 text-sm font-semibold">Where payments go</h4>
          <ul className="space-y-1 text-sm">
            {s.payments.topStableRecipients.map((r) => (
              <li key={r.address + r.symbol} className="flex flex-wrap items-center justify-between gap-2">
                <AddressLink chain={report.events.find((e) => e.hash === r.lastHash)?.chain ?? ""} address={r.address} label={r.label} />
                <span className="tabular-nums">{usd(r.amount)} · {r.count}×</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.patterns.length > 0 && (
        <section aria-labelledby="pw-pat"><h4 id="pw-pat" className="mb-2 text-sm font-semibold">Repeating patterns</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="pw-patterns">{report.patterns.map((p, i) => <li key={i}>{p.description}</li>)}</ul>
        </section>
      )}

      <section aria-labelledby="pw-sells" data-testid="pw-sells"><h4 id="pw-sells" className="mb-2 text-sm font-semibold">Sales ({fmtInt(sells.length)})</h4>
        {sells.length === 0 ? <p className="text-sm text-muted-foreground">No developer sales in this window.</p> : (
          <ul className="space-y-1 text-sm">
            {sells.slice(0, 15).map((e) => (
              <li key={e.hash + e.type} className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-xs text-muted-foreground">{e.date}</span>
                <TxTypeBadge type={e.type} types={report.txTypes} reason={e.reason} />
                <span className="font-medium">{e.walletLabel}</span>→<AddressLink chain={e.chain} address={e.counterparty} label={e.counterpartyLabel} />
                <span className="ml-auto tabular-nums">{fmtTel(e.amount)} {e.symbol}</span>
                <TxLink chain={e.chain} hash={e.hash} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section id="pw-wallets" aria-labelledby="pw-wallets-h" data-testid="pw-wallets"><h4 id="pw-wallets-h" className="mb-2 text-sm font-semibold">Developer wallets ({win})</h4>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-2">Wallet</th><th className="pr-2 text-right">Sold</th><th className="pr-2 text-right">Stables out</th><th className="pr-2 text-right">Internal</th><th className="text-right">Txs</th></tr></thead>
          <tbody>
            {[...report.developerWallets].filter((w) => (w.windows[win]?.txs ?? 0) > 0).sort((a, b) => (b.windows[win]?.sold ?? 0) - (a.windows[win]?.sold ?? 0)).slice(0, 25).map((w) => (
              <tr key={w.address} className="border-t border-border/40">
                <td className="py-1 pr-2"><AddressLink chain={w.chains[0] ?? ""} address={w.address} label={w.label} /></td>
                <td className="pr-2 text-right tabular-nums">{fmtTel(w.windows[win]?.sold ?? 0)}</td>
                <td className="pr-2 text-right tabular-nums">{usd(w.windows[win]?.stableOut ?? 0)}</td>
                <td className="pr-2 text-right tabular-nums">{fmtInt(w.windows[win]?.internal ?? 0)}</td>
                <td className="text-right tabular-nums">{fmtInt(w.windows[win]?.txs ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      {report.botCluster && <BotClusterSection report={report} proceeds={proceeds} win={win} />}
      {!report.botCluster && <BotCandidatesSection proceeds={proceeds} ticker={t} />}

      <section aria-labelledby="pw-ev" data-testid="pw-ev"><h4 id="pw-ev" className="mb-2 text-sm font-semibold">Transactions ({fmtInt(events.length)}{events.length === 200 ? "+" : ""})</h4>
        {filter && (
          <p className="mb-2 flex items-center gap-2 text-xs" data-testid="pw-ev-filter">
            <span className="rounded bg-primary/10 px-2 py-0.5 font-semibold text-primary">Showing: {filter.label}</span>
            <button type="button" className="text-muted-foreground hover:underline" onClick={() => setFilter(null)}>Clear filter</button>
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 pr-2">When</th><th className="pr-2">Type</th><th className="pr-2">From</th><th className="pr-2">To</th><th className="pr-2 text-right">Amount</th><th>Tx</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.hash + e.wallet + e.type} className="border-t border-border/40">
                  <td className="whitespace-nowrap py-1 pr-2 text-xs">{e.date}</td>
                  <td className="pr-2"><TxTypeBadge type={e.type} types={report.txTypes} reason={e.reason} /></td>
                  <td className="pr-2">{e.direction === "out" ? e.walletLabel : <AddressLink chain={e.chain} address={e.counterparty} label={e.counterpartyLabel} />}</td>
                  <td className="pr-2">{e.direction === "out" ? <AddressLink chain={e.chain} address={e.counterparty} label={e.counterpartyLabel} /> : e.walletLabel}</td>
                  <td className="whitespace-nowrap pr-2 text-right tabular-nums">{fmtTel(e.amount)} {e.symbol}</td>
                  <td><TxLink chain={e.chain} hash={e.hash} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export const ProjectWalletsView = ({ rangeDays }: { rangeDays?: number }) => {
  const { password, status, unlock } = useForensicsUnlock();
  const { isAdmin } = useUserRole();
  const { slug } = useProject();
  const unlocked = isAdmin || (status === "unlocked" && password !== null);
  const ledger = useQuery({ queryKey: ["project-ledger", slug, password, isAdmin], queryFn: () => loadProjectLedger(password, slug), enabled: unlocked, staleTime: 10 * 60 * 1000, refetchOnWindowFocus: false, retry: false });
  const proceeds = useQuery({ queryKey: ["bot-proceeds", slug, password, isAdmin], queryFn: () => loadBotProceeds(password, slug), enabled: unlocked && !!ledger.data, staleTime: 10 * 60 * 1000, refetchOnWindowFocus: false, retry: false });

  if (!unlocked) {
    return (
      <section className="rounded-2xl border border-border/60 bg-card p-4 sm:p-6" data-testid="project-wallets-locked">
        <div className="mx-auto max-w-xl">
          <h3 className="inline-flex items-center gap-2 text-lg font-semibold"><Lock className="h-4 w-4 text-primary" aria-hidden="true" />Developer wallets</h3>
          <ul className="mt-3 space-y-1.5 text-sm">
            {["How much and how often developer wallets sell (24h, 72h, 30d, 90d)", "Where their payments go, with every transaction linked", "Repeating patterns and the bot cluster's developer-funded share"].map((l) => (
              <li key={l} className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />{l}</li>
            ))}
          </ul>
          <div className="mt-5"><ForensicsUnlockGate status={status} onUnlock={unlock} label="Password" /></div>
        </div>
      </section>
    );
  }
  return (
    <section className="space-y-4" data-testid="project-wallets">
      <h3 className="inline-flex items-center gap-2 text-lg font-semibold"><LockOpen className="h-4 w-4 text-primary" aria-hidden="true" />Developer wallets</h3>
      {ledger.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {ledger.isError && <p className="text-sm text-muted-foreground">Couldn&apos;t load the developer-wallet ledger.</p>}
      {ledger.data === null && <p className="text-sm text-muted-foreground">No developer-wallet ledger has been generated for this project yet.</p>}
      {ledger.data && <LedgerBody report={ledger.data} proceeds={proceeds.data} initialWindow={windowForRange(rangeDays)} />}
    </section>
  );
};

export default ProjectWalletsView;
