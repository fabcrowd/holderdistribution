/**
 * Build the derived developer-wallet ledger report (data/<slug>/ledger/ledger.json)
 * from classified events + bot sales. Pure: no I/O, so tests can pin every number.
 *
 * Headline rule (owner decision 2026-11-03):
 *   developer selling = DEX sales + exchange deposits by developer wallets
 *                     + bot-cluster sales x developer share of the bot's funding (pro-rata).
 * Internal shuffles (developer -> developer) are counted and shown, never in a headline.
 */
import { addr, LEDGER_WINDOWS, LEDGER_WINDOW_SECONDS } from "./config.js";
import { detectPatterns } from "../patterns.js";

export const LEDGER_REPORT_VERSION = 1;
export const MAX_REPORT_EVENTS = 2500;
const DAY = 86400;
const r0 = (n) => Math.round(n);

const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);
const usd = (n) => `$${fmt(n)}`;

const DAILY_FIELDS = {
  dex_sell: "dexSell",
  cex_deposit: "cexDeposit",
  internal_shuffle: "internal",
  bot_funding: "botFunding",
  bridge: "bridge",
  custody: "custody",
  staking: "staking",
  burn: "burn",
  transfer_out: "transferOut",
  receive: "receive",
  stable_in: "stableIn",
  stable_out: "stableOut",
  stable_internal: "stableInternal",
};
const emptyDay = (date) => ({ date, devSold: 0, botSold: 0, botDevShare: 0, ...Object.fromEntries(Object.values(DAILY_FIELDS).map((f) => [f, 0])) });

/** One window's summary. */
export function summarizeWindow(events, botSales, { fromSec, toSec, devShare }) {
  const evs = events.filter((e) => e.time >= fromSec && e.time <= toSec);
  const bots = botSales.filter((s) => s.time >= fromSec && s.time <= toSec);
  const sum = (xs) => xs.reduce((s, e) => s + (e.amount || 0), 0);
  const ofType = (t) => evs.filter((e) => e.type === t);

  const dex = sum(ofType("dex_sell"));
  const cex = sum(ofType("cex_deposit"));
  const botTotal = sum(bots);
  const botDev = botTotal * devShare;
  const sells = [...ofType("dex_sell"), ...ofType("cex_deposit")];
  const sellDays = new Set([...sells.map((e) => e.date), ...bots.map((s) => s.date)]).size;

  const byType = {};
  for (const e of evs) {
    const b = (byType[e.type] ??= { count: 0, amount: 0 });
    b.count++;
    b.amount += e.amount || 0;
  }
  for (const b of Object.values(byType)) b.amount = r0(b.amount);

  const stableOut = ofType("stable_out");
  const stableIn = ofType("stable_in");
  const bySymbol = {};
  for (const e of stableOut) bySymbol[e.symbol] = r0((bySymbol[e.symbol] ?? 0) + e.amount);
  const recipients = new Map();
  for (const e of [...stableOut, ...ofType("transfer_out"), ...ofType("cex_deposit"), ...ofType("dex_sell"), ...ofType("bridge"), ...ofType("custody")]) {
    const k = `${e.asset}|${e.counterparty}`;
    const cur = recipients.get(k) ?? {
      address: e.counterparty,
      label: e.counterpartyLabel,
      asset: e.asset,
      symbol: e.symbol,
      type: e.type,
      count: 0,
      amount: 0,
      lastHash: null,
      lastTime: 0,
    };
    cur.count++;
    cur.amount += e.amount;
    if (e.time >= cur.lastTime) {
      cur.lastTime = e.time;
      cur.lastHash = e.hash;
    }
    recipients.set(k, cur);
  }
  const top = (asset) =>
    [...recipients.values()]
      .filter((x) => x.asset === asset)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10)
      .map((x) => ({ ...x, amount: r0(x.amount) }));

  const internal = ofType("internal_shuffle");
  return {
    from: new Date(fromSec * 1000).toISOString(),
    to: new Date(toSec * 1000).toISOString(),
    devSold: { dex: r0(dex), cex: r0(cex), botDevShare: r0(botDev), total: r0(dex + cex + botDev) },
    sellCount: sells.length,
    botSaleCount: bots.length,
    botSold: r0(botTotal),
    sellDays,
    internal: { count: internal.length, amount: r0(sum(internal)) },
    received: r0(sum(ofType("receive"))),
    payments: {
      stableOut: r0(sum(stableOut)),
      stableOutCount: stableOut.length,
      stableIn: r0(sum(stableIn)),
      stableInCount: stableIn.length,
      bySymbol,
      topStableRecipients: top("stable"),
      topTokenDestinations: top("token"),
    },
    byType,
  };
}

/** Plain-English answers for one window (shown verbatim in the UI). */
export function windowHeadlines(win, s, { ticker, botLabel, devShare }) {
  const lines = [];
  const days = { "24h": 1, "72h": 3, "30d": 30, "90d": 90 }[win] ?? 1;
  if (s.devSold.total > 0) {
    const parts = [];
    if (s.devSold.dex) parts.push(`${fmt(s.devSold.dex)} on DEXs`);
    if (s.devSold.cex) parts.push(`${fmt(s.devSold.cex)} sent to exchanges`);
    if (s.devSold.botDevShare) parts.push(`${fmt(s.devSold.botDevShare)} via the bot cluster (developer-funded ${Math.round(devShare * 100)}% of its ${fmt(s.botSold)} sold)`);
    lines.push(`Developer wallets sold ${fmt(s.devSold.total)} ${ticker} in the last ${win}: ${parts.join(", ")}.`);
    lines.push(`Selling happened on ${s.sellDays} of ${days} day${days === 1 ? "" : "s"} (${s.sellCount} direct sale/deposit transaction${s.sellCount === 1 ? "" : "s"}${s.botSaleCount ? `, ${s.botSaleCount} bot sale${s.botSaleCount === 1 ? "" : "s"}` : ""}).`);
  } else {
    lines.push(`No developer selling found in the last ${win}.`);
  }
  if (s.payments.stableOut > 0) {
    const topR = s.payments.topStableRecipients[0];
    lines.push(`They paid out ${usd(s.payments.stableOut)} in stablecoins (${s.payments.stableOutCount} payment${s.payments.stableOutCount === 1 ? "" : "s"})${topR ? `; the largest recipient was ${topR.label ?? topR.address} (${usd(topR.amount)})` : ""}.`);
  }
  if (s.payments.stableIn > 0) lines.push(`They received ${usd(s.payments.stableIn)} in stablecoins (${s.payments.stableInCount} transfer${s.payments.stableInCount === 1 ? "" : "s"}).`);
  const topT = s.payments.topTokenDestinations[0];
  if (topT) lines.push(`Largest ${ticker} destination: ${topT.label ?? topT.address} (${fmt(topT.amount)} ${ticker}, ${topT.count} transfer${topT.count === 1 ? "" : "s"}).`);
  if (s.internal.count > 0) lines.push(`${s.internal.count} internal shuffle${s.internal.count === 1 ? "" : "s"} between developer wallets (${fmt(s.internal.amount)} ${ticker}) are noted but not counted as selling.`);
  if (botLabel && s.botSold > 0 && !s.devSold.botDevShare) lines.push(`${botLabel} sold ${fmt(s.botSold)} ${ticker}.`);
  return lines;
}

/** Daily series covering `days` days ending at nowSec (UTC dates, oldest first). */
export function dailySeries(events, botSales, { nowSec, days, devShare }) {
  const out = new Map();
  const end = Math.floor(nowSec / DAY) * DAY;
  for (let d = days - 1; d >= 0; d--) {
    const date = new Date((end - d * DAY) * 1000).toISOString().slice(0, 10);
    out.set(date, emptyDay(date));
  }
  for (const e of events) {
    const row = out.get(e.date);
    if (!row) continue;
    const f = DAILY_FIELDS[e.type];
    if (f) row[f] += e.amount || 0;
    if (e.headline) row.devSold += e.amount || 0;
  }
  for (const s of botSales) {
    const row = out.get(s.date);
    if (!row) continue;
    row.botSold += s.amount || 0;
    row.botDevShare += (s.amount || 0) * devShare;
    row.devSold += (s.amount || 0) * devShare;
  }
  return [...out.values()].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? r0(v) : v])));
}

/**
 * @param {object} p
 * @param {object} p.cfg            ledger config
 * @param {object[]} p.events       classified developer events (any age; trimmed to historyDays)
 * @param {object[]} p.botSales     classifyBotTransfer rows
 * @param {number} p.nowSec
 * @param {object} p.txTypes        config/ledger-tx-types.json
 * @param {object} [p.coverage]     per-chain scan status
 * @param {object} [p.crossCheck]   Etherscan cross-check summary
 * @param {{name?:string, ticker?:string}} [p.project]
 */
export function buildLedgerReport({ cfg, events, botSales = [], nowSec, txTypes, coverage = {}, crossCheck = null, project = {}, devShare = 0 }) {
  const windows = (cfg.windows ?? LEDGER_WINDOWS).filter((w) => LEDGER_WINDOW_SECONDS[w]);
  const historyDays = cfg.historyDays ?? 90;
  const since = nowSec - historyDays * DAY;
  const evs = events.filter((e) => e.time >= since).sort((a, b) => b.time - a.time || (a.hash < b.hash ? -1 : 1));
  const bots = botSales.filter((s) => s.time >= since);
  const ticker = project.ticker ?? cfg.slug.toUpperCase();
  const botLabel = cfg.botCluster?.label ?? null;

  const byWindow = {};
  const headlines = {};
  for (const w of windows) {
    byWindow[w] = summarizeWindow(evs, bots, { fromSec: nowSec - LEDGER_WINDOW_SECONDS[w], toSec: nowSec, devShare });
    headlines[w] = windowHeadlines(w, byWindow[w], { ticker, botLabel, devShare });
  }

  const wallets = (cfg.developerWallets ?? []).map((w) => {
    const mine = evs.filter((e) => e.wallet === addr(w.address));
    const per = {};
    for (const win of windows) {
      const from = nowSec - LEDGER_WINDOW_SECONDS[win];
      const inWin = mine.filter((e) => e.time >= from);
      per[win] = {
        sold: r0(inWin.filter((e) => e.headline).reduce((s, e) => s + e.amount, 0)),
        stableOut: r0(inWin.filter((e) => e.type === "stable_out").reduce((s, e) => s + e.amount, 0)),
        internal: inWin.filter((e) => e.internal).length,
        txs: inWin.length,
      };
    }
    return { address: w.address, label: w.label, group: w.group ?? null, entityClass: w.entityClass ?? null, chains: w.chains ?? [], confidence: w.confidence ?? null, windows: per, lastActivity: mine[0]?.time ? new Date(mine[0].time * 1000).toISOString() : null };
  });

  return {
    version: LEDGER_REPORT_VERSION,
    slug: cfg.slug,
    name: project.name ?? cfg.slug,
    ticker,
    generated: new Date(nowSec * 1000).toISOString(),
    windows,
    defaultWindow: windows.includes("30d") ? "30d" : windows[windows.length - 1],
    historyDays,
    rule: "Developer selling = developer-wallet DEX sales + exchange deposits + the developer-funded share of bot-cluster sales (pro-rata by funding). Moves between developer wallets are internal shuffles: shown, never counted.",
    txTypes: txTypes?.types ?? {},
    coverage,
    crossCheck,
    botCluster: cfg.botCluster
      ? {
          label: cfg.botCluster.label,
          chain: cfg.botCluster.chain,
          addresses: cfg.botCluster.addresses,
          devShare: Number(devShare.toFixed(4)),
          funding: cfg.botCluster.funding,
          evidence: cfg.botCluster.evidence ?? [],
          windows: Object.fromEntries(windows.map((w) => [w, { sold: byWindow[w].botSold, sales: byWindow[w].botSaleCount, devShare: byWindow[w].devSold.botDevShare }])),
          recentSales: bots.sort((a, b) => b.time - a.time).slice(0, 50),
        }
      : null,
    byWindow,
    headlines,
    developerWallets: wallets,
    daily: dailySeries(evs, bots, { nowSec, days: historyDays, devShare }),
    patterns: detectPatterns(evs, { botSales: bots, ticker }),
    events: evs.slice(0, MAX_REPORT_EVENTS),
    eventsTruncated: evs.length > MAX_REPORT_EVENTS,
  };
}

/** Schema check run before the file is written, and by tests / the gate fixture. */
export function validateLedgerReport(r) {
  const errors = [];
  if (!r || typeof r !== "object") return ["report is not an object"];
  if (r.version !== LEDGER_REPORT_VERSION) errors.push("version must be 1");
  if (!r.slug) errors.push("slug missing");
  if (Number.isNaN(Date.parse(r.generated))) errors.push("generated must be ISO");
  if (!Array.isArray(r.windows) || r.windows.some((w) => !LEDGER_WINDOWS.includes(w))) errors.push("windows invalid");
  for (const w of r.windows ?? []) {
    if (!r.byWindow?.[w]) errors.push(`byWindow.${w} missing`);
    if (!Array.isArray(r.headlines?.[w])) errors.push(`headlines.${w} missing`);
  }
  if (!Array.isArray(r.daily)) errors.push("daily missing");
  if (!Array.isArray(r.events)) errors.push("events missing");
  for (const e of r.events ?? []) {
    if (!e.hash) errors.push(`event without hash (${e.type})`);
    if (!r.txTypes?.[e.type]) errors.push(`event type ${e.type} not in txTypes`);
    if (!e.reason) errors.push(`event ${e.hash} has no reason`);
    if (errors.length > 20) break;
  }
  return errors;
}
