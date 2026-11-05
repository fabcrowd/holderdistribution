/**
 * Repeating-pattern detection over ledger events (developer-wallet ledger,
 * scripts/build-ledger.js). Pure.
 *
 * Patterns found:
 *   recurring_payment  same wallet -> same counterparty, similar amount (±10%), >= minRepeats times
 *   regular_cadence    one wallet's sells (or payments) at a steady interval (CV of gaps <= 0.5)
 *   fixed_size         many sells of nearly the same size (typical of an automated seller)
 *   time_of_day        most of a wallet's sells in the same 3-hour UTC slot
 * Every pattern carries sample tx hashes so the claim can be checked.
 */

const DAY = 86400;
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const cv = (xs) => {
  const m = mean(xs);
  if (!m) return Infinity;
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m;
};
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0));
const dayWord = (d) => (d < 1.5 ? "day" : `${Math.round(d)} days`);

/** Group amounts that are within `tol` of each other (greedy, sorted). */
function amountBuckets(items, tol = 0.1) {
  const sorted = [...items].sort((a, b) => a.amount - b.amount);
  const buckets = [];
  for (const it of sorted) {
    const b = buckets[buckets.length - 1];
    if (b && it.amount <= b.base * (1 + tol)) b.items.push(it);
    else buckets.push({ base: it.amount, items: [it] });
  }
  return buckets;
}

const SELL_TYPES = new Set(["dex_sell", "cex_deposit"]);
const PAY_TYPES = new Set(["stable_out", "transfer_out"]);

/**
 * @param {object[]} events classified ledger events (internal shuffles are ignored)
 * @param {{minRepeats?: number, botSales?: object[], ticker?: string}} opts
 */
export function detectPatterns(events, { minRepeats = 3, botSales = [], ticker = "tokens" } = {}) {
  const out = [];
  const external = events.filter((e) => !e.internal && e.amount > 0 && e.time);

  // recurring_payment: wallet -> counterparty pairs
  const pairs = new Map();
  for (const e of external) {
    if (!SELL_TYPES.has(e.type) && !PAY_TYPES.has(e.type) && e.type !== "bot_funding") continue;
    const k = `${e.wallet}|${e.counterparty}|${e.asset}`;
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k).push(e);
  }
  for (const list of pairs.values()) {
    if (list.length < minRepeats) continue;
    for (const b of amountBuckets(list)) {
      if (b.items.length < minRepeats) continue;
      const items = b.items.sort((a, c) => a.time - c.time);
      const gaps = items.slice(1).map((e, i) => (e.time - items[i].time) / DAY);
      const first = items[0];
      const unit = first.asset === "stable" ? first.symbol : ticker;
      const every = gaps.length ? median(gaps) : 0;
      out.push({
        kind: "recurring_payment",
        wallet: first.wallet,
        walletLabel: first.walletLabel,
        counterparty: first.counterparty,
        counterpartyLabel: first.counterpartyLabel,
        type: first.type,
        count: items.length,
        typicalAmount: Math.round(median(items.map((e) => e.amount))),
        total: Math.round(items.reduce((s, e) => s + e.amount, 0)),
        intervalDays: Number(every.toFixed(2)),
        description: `${first.walletLabel} sent about ${fmt(median(items.map((e) => e.amount)))} ${unit} to ${first.counterpartyLabel ?? "the same wallet"} ${items.length} times${every > 0 ? `, roughly every ${dayWord(every)}` : ""}.`,
        sampleHashes: items.slice(-5).map((e) => e.hash),
      });
    }
  }

  // regular_cadence and time_of_day: per wallet, sells only
  const byWallet = new Map();
  for (const e of external) {
    if (!SELL_TYPES.has(e.type)) continue;
    if (!byWallet.has(e.wallet)) byWallet.set(e.wallet, []);
    byWallet.get(e.wallet).push(e);
  }
  for (const list of byWallet.values()) {
    if (list.length < Math.max(4, minRepeats)) continue;
    const items = [...list].sort((a, b) => a.time - b.time);
    const gaps = items.slice(1).map((e, i) => (e.time - items[i].time) / DAY).filter((g) => g > 0);
    if (gaps.length >= 3 && cv(gaps) <= 0.5) {
      const every = median(gaps);
      out.push({
        kind: "regular_cadence",
        wallet: items[0].wallet,
        walletLabel: items[0].walletLabel,
        count: items.length,
        intervalDays: Number(every.toFixed(2)),
        total: Math.round(items.reduce((s, e) => s + e.amount, 0)),
        description: `${items[0].walletLabel} sells on a steady schedule: ${items.length} sales, about one every ${dayWord(every)}.`,
        sampleHashes: items.slice(-5).map((e) => e.hash),
      });
    }
    const slots = new Map();
    for (const e of items) {
      const slot = Math.floor(new Date(e.time * 1000).getUTCHours() / 3);
      slots.set(slot, (slots.get(slot) ?? 0) + 1);
    }
    const [slot, n] = [...slots.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n / items.length >= 0.6) {
      const h = String(slot * 3).padStart(2, "0");
      const h2 = String(slot * 3 + 3).padStart(2, "0");
      out.push({
        kind: "time_of_day",
        wallet: items[0].wallet,
        walletLabel: items[0].walletLabel,
        count: n,
        share: Number((n / items.length).toFixed(2)),
        description: `${Math.round((100 * n) / items.length)}% of ${items[0].walletLabel}'s sales happen between ${h}:00 and ${h2}:00 UTC.`,
        sampleHashes: items.filter((e) => Math.floor(new Date(e.time * 1000).getUTCHours() / 3) === slot).slice(-5).map((e) => e.hash),
      });
    }
  }

  // fixed_size: bot sales (or any seller) with many near-identical sizes
  if (botSales.length >= 10) {
    const amounts = botSales.map((s) => s.amount).filter((a) => a > 0);
    const sorted = [...amounts].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    if (p10 > 0 && p90 / p10 <= 10) {
      out.push({
        kind: "fixed_size",
        wallet: "bot-cluster",
        walletLabel: "Bot cluster",
        count: botSales.length,
        typicalAmount: Math.round(median(amounts)),
        range: [Math.round(p10), Math.round(p90)],
        description: `The bot cluster made ${botSales.length} sales, 80% of them between ${fmt(p10)} and ${fmt(p90)} ${ticker}: the narrow, repeated size of an automated seller.`,
        sampleHashes: botSales.slice(-5).map((s) => s.hash),
      });
    }
  }

  const rank = { fixed_size: 0, regular_cadence: 1, recurring_payment: 2, time_of_day: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (b.total ?? b.count) - (a.total ?? a.count));
}
