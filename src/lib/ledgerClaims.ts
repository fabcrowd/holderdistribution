/**
 * Summary bullets for the Developer wallets view, built from the ledger report
 * so every figure links to its source: a filter over the page's transaction
 * list (type + window), an explorer address for a named entity, or a single
 * explorer tx when one transaction backs the claim. Pure; see ledgerClaims.test.ts.
 */
import { COMPACT_CLAIM, formatCompact } from "@/lib/format";
import { eventsInWindow, windowDays, type LedgerEvent, type LedgerReport, type LedgerWindow } from "@/lib/projectWallets";

export type TxFilter = { label: string; types?: string[]; headline?: boolean; counterparty?: string; internal?: boolean };
export type TxRef = { chain: string; hash: string };
export type ClaimSeg =
  | string
  | { kind: "filter"; text: string; filter: TxFilter; count: number; txs: TxRef[] }
  | { kind: "address"; text: string; chain: string; address: string }
  | { kind: "tx"; text: string; chain: string; hash: string }
  | { kind: "section"; text: string; target: string; txs: TxRef[]; count: number };
export type Claim = { key: string; segs: ClaimSeg[] };

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const compact = (n: number) => formatCompact(n, COMPACT_CLAIM);
const usd = (n: number) => `$${compact(n).replace(/^(\d+)$/, (m) => Number(m).toLocaleString("en-US"))}`;

export const matchFilter = (e: LedgerEvent, f: TxFilter): boolean =>
  (!f.types || f.types.includes(e.type)) &&
  (f.headline === undefined || !!e.headline === f.headline) &&
  (f.internal === undefined || (!!e.internal || e.type === "internal_shuffle") === f.internal) &&
  (!f.counterparty || e.counterparty.toLowerCase() === f.counterparty.toLowerCase());

/** Biggest first, then newest: the "top" transactions shown as proof. */
export const proofTxs = (events: LedgerEvent[], n = 5): TxRef[] =>
  [...events].sort((a, b) => b.amount - a.amount || b.time - a.time).slice(0, n).map((e) => ({ chain: e.chain, hash: e.hash }));

export function summaryClaims(report: LedgerReport, win: LedgerWindow): Claim[] {
  const s = report.byWindow[win];
  if (!s) return [];
  const t = report.ticker;
  const nowSec = Math.floor(Date.parse(report.generated) / 1000);
  const evs = eventsInWindow(report.events, win, nowSec);
  const days = windowDays(win);
  const bot = report.botCluster;
  const chainOf = (addr: string) => evs.find((e) => e.counterparty.toLowerCase() === addr.toLowerCase())?.chain ?? report.developerWallets[0]?.chains[0] ?? "";
  const fil = (text: string, filter: TxFilter): ClaimSeg => {
    const m = evs.filter((e) => matchFilter(e, filter));
    if (m.length === 1) return { kind: "tx", text, chain: m[0].chain, hash: m[0].hash };
    return { kind: "filter", text, filter, count: m.length, txs: proofTxs(m) };
  };
  const botSales = bot ? bot.recentSales.map((r) => ({ chain: bot.chain, hash: r.hash })) : [];
  const botSeg = (text: string): ClaimSeg => ({ kind: "section", text, target: "pw-bot", txs: botSales.slice(0, 5), count: bot?.windows[win]?.sales ?? 0 });
  const botName = (): ClaimSeg => (bot?.addresses[0] ? { kind: "address", text: "the bot cluster", chain: bot.chain, address: bot.addresses[0] } : "the bot cluster");
  const devWallets: ClaimSeg = { kind: "section", text: "Developer wallets", target: "pw-wallets", txs: [], count: report.developerWallets.length };
  const out: Claim[] = [];

  if (s.devSold.total > 0) {
    const segs: ClaimSeg[] = [devWallets, ` sold ${compact(s.devSold.total)} ${t} in the last ${win}: `];
    const parts: ClaimSeg[][] = [];
    if (s.devSold.dex) parts.push([fil(`${compact(s.devSold.dex)} on DEXs`, { label: `DEX sales (${win})`, types: ["dex_sell"] })]);
    if (s.devSold.cex) parts.push([fil(`${compact(s.devSold.cex)} sent to exchanges`, { label: `Exchange deposits (${win})`, types: ["cex_deposit"] })]);
    if (s.devSold.botDevShare && bot) parts.push([botSeg(`${compact(s.devSold.botDevShare)} via`), " ", botName(), ` (developer-funded ${Math.round(bot.devShare * 100)}% of its ${compact(s.botSold)} sold)`]);
    parts.forEach((p, i) => { if (i) segs.push(", "); segs.push(...p); });
    segs.push(".");
    out.push({ key: "sold", segs });
    const sold: ClaimSeg[] = [`Selling happened on ${s.sellDays} of ${plural(days, "day")} (`, fil(plural(s.sellCount, "direct sale/deposit transaction"), { label: `Developer sales (${win})`, headline: true })];
    if (s.botSaleCount) sold.push(", ", botSeg(plural(s.botSaleCount, "bot sale")));
    sold.push(").");
    out.push({ key: "freq", segs: sold });
  } else {
    out.push({ key: "sold", segs: [`No developer selling found in the last ${win}.`] });
  }
  if (s.payments.stableOut > 0) {
    const segs: ClaimSeg[] = [`They paid out ${usd(s.payments.stableOut)} in stablecoins (`, fil(plural(s.payments.stableOutCount, "payment"), { label: `Stablecoin payments (${win})`, types: ["stable_out"] }), ")"];
    const r = s.payments.topStableRecipients[0];
    if (r) {
      const c = chainOf(r.address);
      segs.push("; the largest recipient was ", { kind: "address", text: r.label ?? r.address, chain: c, address: r.address }, " (",
        fil(usd(r.amount), { label: `Payments to ${r.label ?? r.address} (${win})`, types: ["stable_out"], counterparty: r.address }), ")");
    }
    segs.push(".");
    out.push({ key: "paid", segs });
  }
  if (s.payments.stableIn > 0) out.push({ key: "recv", segs: [`They received ${usd(s.payments.stableIn)} in stablecoins (`, fil(plural(s.payments.stableInCount, "transfer"), { label: `Stablecoins received (${win})`, types: ["stable_in"] }), ")."] });
  const d = s.payments.topTokenDestinations[0];
  if (d) {
    const c = chainOf(d.address);
    const xfer: ClaimSeg = d.count === 1 && d.lastHash ? { kind: "tx", text: plural(1, "transfer"), chain: c, hash: d.lastHash } : fil(plural(d.count, "transfer"), { label: `${t} to ${d.label ?? d.address} (${win})`, counterparty: d.address, types: [d.type] });
    out.push({ key: "dest", segs: [`Largest ${t} destination: `, { kind: "address", text: d.label ?? d.address, chain: c, address: d.address }, ` (${compact(d.amount)} ${t}, `, xfer, ")."] });
  }
  if (s.internal.count > 0) out.push({ key: "internal", segs: [fil(plural(s.internal.count, "internal shuffle"), { label: `Internal shuffles (${win})`, internal: true }), ` between developer wallets (${compact(s.internal.amount)} ${t}) are noted but not counted as selling.`] });
  if (bot && s.botSold > 0 && !s.devSold.botDevShare) out.push({ key: "bot", segs: [botName(), " ", botSeg(`sold ${compact(s.botSold)} ${t}`), "."] });
  return out;
}

/** Plain text of a claim (tests, aria, copy). */
export const claimText = (c: Claim) => c.segs.map((x) => (typeof x === "string" ? x : x.text)).join("");
