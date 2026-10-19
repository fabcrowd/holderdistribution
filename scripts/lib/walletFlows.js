/**
 * Pure helpers for the gated "Wallet flows" forensics report
 * (data/forensics/wallet-flows.json, served ONLY by the forensics gate function
 * after password verification — never from public/data or the client bundle).
 *
 * Everything here is deterministic and RPC-free so it can be unit tested; the
 * RPC work lives in scripts/generate-wallet-flows.js.
 */

export const WINDOWS = ["72h", "30d", "90d"];
export const WINDOW_SECONDS = { "72h": 72 * 3600, "30d": 30 * 86400, "90d": 90 * 86400 };

/** Outflow kinds that count as "sent to a sell venue". */
export const SELL_VENUE_KINDS = ["CEX", "DEX", "bot-cluster"];

/** Swap event topic0s: a tx emitting one of these swapped on a DEX. */
export const SWAP_TOPICS = new Map([
  ["0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822", "uniV2"],
  ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", "uniV3/algebra"],
  ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", "uniV4"],
  ["0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b", "balancer"],
  ["0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140", "curve"],
  ["0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83", "pancakeV3"],
  ["0x823eaf01002d7353fbcadb2ea3305cc46fa35d799cb0914846d185ac06f8ad05", "algebraV1.9"],
]);

/** Distribution classes, in display order. */
export const DISTRIBUTION_CLASSES = [
  { key: "treasury", label: "Telcoin-linked: TEL Treasury", group: "telcoin" },
  { key: "association", label: "Telcoin-linked: Association Safes & operational wallets", group: "telcoin" },
  { key: "holdings", label: "Telcoin-linked: Telcoin Holdings (company)", group: "telcoin" },
  { key: "escrow", label: "Escrow & custody (BitGo, Anchorage, vaults)", group: "locked" },
  { key: "staking", label: "Staking contract", group: "locked" },
  { key: "cex", label: "Centralised exchanges (incl. deposit relays)", group: "market" },
  { key: "dex", label: "DEX pools & market makers", group: "market" },
  { key: "bots", label: "Tracked sell bots & large sellers", group: "market" },
  { key: "other", label: "Other labelled (dormant whales, burn, unlabelled exclusions)", group: "other" },
  { key: "retail", label: "Retail & unlabelled holders", group: "retail" },
];

/** supply-reconciliation.json category → distribution class. */
const RECON_CATEGORY_CLASS = {
  treasury: "treasury",
  council: "association",
  holdings: "holdings",
  escrow: "escrow",
  cex: "cex",
  dex: "dex",
  retail: "retail",
};

/** Registry entityClass → distribution class for wallets not already itemised by reconciliation. */
const ENTITY_CLASS_TO_DISTRIBUTION = {
  treasury: "treasury",
  association: "association",
  holdings: "holdings",
  escrow: "escrow",
  staking: "staking",
  cex: "cex",
  relay: "cex",
  bots: "bots",
  seller: "bots",
};

export const norm = (a) => String(a ?? "").trim().toLowerCase();

const round = (n) => Math.round(Number(n) || 0);

/**
 * Index of every address the classifier knows about.
 * @param {{
 *   registry: object,
 *   cexWallets?: {address:string,label:string}[],
 *   dexAddresses?: string[],
 *   recon?: { items?: {address:string,category:string,name?:string}[] },
 *   upgradeContracts?: string[],
 *   bridgeAddresses?: string[],
 * }} input
 */
export function buildVenueIndex({ registry, cexWallets = [], dexAddresses = [], recon, upgradeContracts = [], bridgeAddresses = [] }) {
  const known = new Map();
  for (const w of registry.knownWallets ?? []) known.set(norm(w.address), w);
  const relays = new Map();
  const relayLabels = new Map();
  for (const w of registry.knownWallets ?? []) {
    if (!w.relayTo) continue;
    relays.set(norm(w.address), w.relayTo);
    if (w.relayLabel) relayLabels.set(norm(w.address), w.relayLabel);
  }
  const sellerLabels = new Map((registry.watchedSellers ?? []).map((s) => [norm(s.address), s.label]));
  const cex = new Map();
  for (const w of cexWallets) cex.set(norm(w.address), w.label ?? w.walletName ?? "CEX");
  for (const [a, label] of Object.entries(registry.extraCex ?? {})) cex.set(norm(a), label);
  const dex = new Set([...dexAddresses, ...Object.keys(registry.extraDex ?? {})].map(norm));
  const reconByAddr = new Map();
  for (const item of recon?.items ?? []) {
    const a = norm(item.address);
    reconByAddr.set(a, item);
    if (item.category === "cex" && !cex.has(a)) cex.set(a, item.name ?? "CEX");
    if (item.category === "dex") dex.add(a);
  }
  const bots = new Set((registry.botCluster?.addresses ?? []).map(norm));
  const upgrade = new Set(upgradeContracts.map(norm));
  const bridges = new Set(bridgeAddresses.map(norm));
  const staking = new Set(
    (registry.knownWallets ?? []).filter((w) => w.entityClass === "staking").map((w) => norm(w.address)),
  );
  return {
    known,
    relays,
    relayLabels,
    sellerLabels,
    botLabel: registry.botCluster?.label ?? "Bot cluster",
    cex,
    dex,
    bots,
    upgrade,
    bridges,
    staking,
    reconByAddr,
  };
}

/**
 * Classify one outflow's destination. `swapped` = the tx emitted a DEX swap event.
 * @returns {"CEX"|"DEX"|"bot-cluster"|"upgrade"|"internal"|"bridge"|"custody"|"reward/unstake payout"|"unlabelled"}
 */
export function classifyOutflow(from, to, index, { swapped = false } = {}) {
  const f = norm(from);
  const t = norm(to);
  if (index.relays.has(t)) {
    const via = index.relays.get(t);
    return via === "CEX" ? "CEX" : via === "custody" ? "custody" : "bridge";
  }
  if (index.upgrade.has(t)) return "upgrade";
  if (index.known.has(t)) {
    const k = index.known.get(t);
    return k.entityClass === "escrow" ? "custody" : "internal";
  }
  if (index.cex.has(t)) return "CEX";
  if (index.bots.has(t)) return "bot-cluster";
  if (index.dex.has(t) || swapped) return "DEX";
  if (index.bridges.has(t)) return "bridge";
  if (index.reconByAddr.get(t)?.category === "escrow") return "custody";
  if (index.staking.has(f)) return "reward/unstake payout";
  return "unlabelled";
}

const explorerTx = {
  ethereum: "https://etherscan.io/tx/",
  polygon: "https://polygonscan.com/tx/",
  base: "https://basescan.org/tx/",
};
export const explorerAddress = {
  ethereum: "https://etherscan.io/address/",
  polygon: "https://polygonscan.com/address/",
  base: "https://basescan.org/address/",
};
export const txUrl = (chain, tx) => `${explorerTx[chain] ?? explorerTx.ethereum}${tx}`;

/**
 * True when a transfer at `block` on `chain` falls inside window `win`.
 * @param {Record<string, Record<string, number>>} startBlocks chain → window → first block
 */
export const inWindow = (startBlocks, chain, block, win) => {
  const start = startBlocks?.[chain]?.[win];
  return Number.isFinite(start) && block >= start;
};

/**
 * Sum outflows per wallet (registry wallets and, separately, the bot cluster) and window.
 * @param {{chain:string, from:string, to:string, tel:number, tx:string, block:number, swapped?:boolean}[]} transfers
 * @param {object} index  buildVenueIndex result
 * @param {Record<string, Record<string, number>>} startBlocks
 */
export function aggregateOutflows(transfers, index, startBlocks) {
  const byWallet = new Map();
  const bot = { out: Object.fromEntries(WINDOWS.map((k) => [k, {}])), samples: [] };
  for (const tr of transfers) {
    const from = norm(tr.from);
    const isKnown = index.known.has(from);
    const isBot = index.bots.has(from);
    if (!isKnown && !isBot) continue;
    const kind = classifyOutflow(from, tr.to, index, { swapped: tr.swapped });
    let w = isBot ? bot : byWallet.get(from);
    if (!w) {
      w = { out: Object.fromEntries(WINDOWS.map((k) => [k, {}])), samples: [] };
      byWallet.set(from, w);
    }
    // Bot-to-bot shuffles are not sales.
    if (isBot && index.bots.has(norm(tr.to))) continue;
    for (const win of WINDOWS) {
      if (inWindow(startBlocks, tr.chain, tr.block, win)) w.out[win][kind] = (w.out[win][kind] ?? 0) + tr.tel;
    }
    if (SELL_VENUE_KINDS.includes(kind) && inWindow(startBlocks, tr.chain, tr.block, "90d")) {
      w.samples.push({ tel: tr.tel, url: txUrl(tr.chain, tr.tx), kind });
    }
  }
  return { byWallet, bot };
}

/**
 * Unique TEL leaving Telcoin-linked wallets into sell venues. Relay wallets are
 * skipped: a send TO a relay already counts as CEX, so counting the relay's
 * onward hop too would double count.
 */
export function telcoinSellTotals(rows, priceUsd) {
  const totals = {};
  for (const win of WINDOWS) {
    const breakdown = {};
    for (const r of rows) {
      if (r.entityClass === "relay" || r.entityClass === "escrow") continue;
      for (const k of SELL_VENUE_KINDS) {
        const v = r.outflows?.[win]?.[k] ?? 0;
        if (v > 0) breakdown[k] = (breakdown[k] ?? 0) + v;
      }
    }
    const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
    totals[win] = { total: round(total), usd: round(total * priceUsd), byVenue: roundMap(breakdown) };
  }
  return totals;
}

export const sellVenueTotal = (out) => SELL_VENUE_KINDS.reduce((s, k) => s + (out?.[k] ?? 0), 0);

export function verdictFor(entry, out90) {
  const total = Object.values(out90 ?? {}).reduce((s, v) => s + v, 0);
  if (total < 1) return "inactive (no outflows in window)";
  if (sellVenueTotal(out90) > 0.2 * total) return "selling / sending to sell venues";
  if (entry.entityClass === "staking") return "distributing incentives / unstakes";
  if ((out90.upgrade ?? 0) > 0.5 * total) return "upgrading to v3";
  return "internal / treasury moves";
}

const roundMap = (m) =>
  Object.fromEntries(
    Object.entries(m ?? {})
      .map(([k, v]) => [k, round(v)])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]),
  );

/**
 * One row per registry wallet.
 * @param {object} registry
 * @param {Map<string, {out:object, samples:object[]}>} flows
 * @param {Map<string, Record<string, number>>} balances  address → { "polygon_v3": tel, ... }
 * @param {number} priceUsd
 */
export function buildKnownWalletRows(registry, flows, balances, priceUsd) {
  const rows = [];
  for (const entry of registry.knownWallets ?? []) {
    const a = norm(entry.address);
    const f = flows.get(a) ?? { out: { "72h": {}, "30d": {}, "90d": {} }, samples: [] };
    const detail = balances.get(a) ?? {};
    const balance = Object.values(detail).reduce((s, v) => s + (v || 0), 0);
    const sell = Object.fromEntries(WINDOWS.map((w) => [w, round(sellVenueTotal(f.out[w]))]));
    rows.push({
      label: entry.label,
      group: entry.group,
      entityClass: entry.entityClass,
      source: entry.source,
      confidence: entry.confidence,
      address: a,
      chains: entry.chains ?? [],
      balance: round(balance),
      balanceDetail: roundMap(detail),
      balanceUsd: round(balance * priceUsd),
      outflows: Object.fromEntries(WINDOWS.map((w) => [w, roundMap(f.out[w])])),
      sellVenue: sell,
      sellVenueUsd90d: round(sell["90d"] * priceUsd),
      sampleTxs: f.samples.sort((x, y) => y.tel - x.tel).slice(0, 4).map((s) => s.url),
      verdict: verdictFor(entry, f.out["90d"]),
    });
  }
  rows.sort((x, y) => y.sellVenue["90d"] - x.sellVenue["90d"] || y.balance - x.balance);
  return rows;
}

/**
 * Supply distribution by entity class.
 *
 * Starts from supply-reconciliation.json's categories (which already sum to the
 * reconciled supply), then moves balances of wallets the reconciliation does not
 * itemise (they sit inside "retail") into their class: the staking contract, the
 * Settlement hub and relays, the tracked bot cluster and large sellers. Moving
 * never changes the total.
 *
 * @param {{ categories: Record<string, number>, items?: {address:string}[], counted?: number, totalSupply?: number }} recon
 * @param {{ address: string, entityClass: string, balance: number }[]} tracked
 */
export function buildDistribution(recon, tracked) {
  const classes = Object.fromEntries(DISTRIBUTION_CLASSES.map((c) => [c.key, 0]));
  for (const [cat, amount] of Object.entries(recon?.categories ?? {})) {
    classes[RECON_CATEGORY_CLASS[cat] ?? "other"] += Number(amount) || 0;
  }
  const itemised = new Set((recon?.items ?? []).map((i) => norm(i.address)));
  const seen = new Set();
  const moved = [];
  for (const t of tracked) {
    const a = norm(t.address);
    const cls = ENTITY_CLASS_TO_DISTRIBUTION[t.entityClass];
    if (!cls || seen.has(a) || itemised.has(a) || !(t.balance > 0)) continue;
    seen.add(a);
    const amount = Math.min(t.balance, Math.max(classes.retail, 0));
    if (amount <= 0) continue;
    classes.retail -= amount;
    classes[cls] += amount;
    moved.push({ address: a, to: cls, tel: round(amount) });
  }
  const counted = Object.values(classes).reduce((s, v) => s + v, 0);
  return {
    totalSupply: recon?.totalSupply ?? 100e9,
    counted: round(counted),
    classes: DISTRIBUTION_CLASSES.map((c) => ({
      key: c.key,
      label: c.label,
      group: c.group,
      tel: round(classes[c.key]),
      share: counted > 0 ? classes[c.key] / counted : 0,
    })),
    movedFromRetail: moved,
  };
}

/**
 * 72h large-seller discovery from a full transfer list. A wallet is a seller if
 * the TEL it sent to venues (CEX / DEX / swaps) exceeds what it received from
 * them by `minTel` (so arbitrage bots that buy as much as they sell drop out).
 * Upgrades, bridges and mints are never sells. The bot cluster is one row.
 *
 * Pass-throughs (exchange deposit addresses, routers, forwarding wallets) — a
 * wallet that received in the window about as much as it sent on to venues — are
 * not reported themselves: the venue-bound share of what they received is
 * credited to the wallets that funded them (one hop, as in the manual analysis).
 */
export function discoverLargeSellers(transfers, index, { minTel = 5e6, limit = 15, priceUsd = 0 } = {}) {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const infra = (a) =>
    a === ZERO || index.cex.has(a) || index.dex.has(a) || index.upgrade.has(a) || index.bridges.has(a) || index.relays.has(a);
  const received = new Map();
  const sentAll = new Map();
  const sentVenue = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  const kinds = transfers.map((tr) => {
    const from = norm(tr.from);
    const to = norm(tr.to);
    const kind = classifyOutflow(from, to, index, { swapped: tr.swapped });
    add(received, to, tr.tel);
    add(sentAll, from, tr.tel);
    if (kind === "CEX" || kind === "DEX") add(sentVenue, from, tr.tel);
    return { from, to, kind, tr };
  });
  const passThrough = (a) => {
    const v = sentVenue.get(a) ?? 0;
    const r = received.get(a) ?? 0;
    return !infra(a) && !index.bots.has(a) && !index.known.has(a) && v > 0 && r >= 0.9 * v && (sentAll.get(a) ?? 0) <= 1.1 * r;
  };
  const venueOf = (kind, to) => (kind === "CEX" ? index.cex.get(to) ?? index.relayLabels?.get(to) ?? "CEX" : "DEX");
  const passVenue = new Map();
  for (const { from, to, kind, tr } of kinds) {
    if ((kind === "CEX" || kind === "DEX") && passThrough(from)) {
      const m = passVenue.get(from) ?? new Map();
      m.set(venueOf(kind, to), (m.get(venueOf(kind, to)) ?? 0) + tr.tel);
      passVenue.set(from, m);
    }
  }

  const per = new Map();
  const get = (key) => {
    let p = per.get(key);
    if (!p) {
      p = { sold: 0, bought: 0, venues: new Map(), chains: new Set(), samples: [], addresses: new Set() };
      per.set(key, p);
    }
    return p;
  };
  const credit = (from, tel, venue, tr) => {
    const key = index.bots.has(from) ? "bot-cluster" : from;
    const p = get(key);
    p.sold += tel;
    p.chains.add(tr.chain);
    p.addresses.add(from);
    p.venues.set(venue, (p.venues.get(venue) ?? 0) + tel);
    p.samples.push({ tel, url: txUrl(tr.chain, tr.tx) });
  };
  for (const { from, to, kind, tr } of kinds) {
    if (infra(from)) continue;
    if ((kind === "CEX" || kind === "DEX") && !passThrough(from)) credit(from, tr.tel, venueOf(kind, to), tr);
    // Funding a pass-through: credit the venue-bound share to the funder.
    if (passThrough(to) && !passThrough(from) && !index.bots.has(to)) {
      const share = Math.min(1, (sentVenue.get(to) ?? 0) / (received.get(to) || 1));
      const top = [...(passVenue.get(to) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "CEX";
      if (share > 0) credit(from, tr.tel * share, `${top} via ${to.slice(0, 6)}…${to.slice(-4)}`, tr);
    }
  }
  for (const { from, to, tr } of kinds) {
    if (!infra(to) && (index.cex.has(from) || index.dex.has(from))) {
      const key = index.bots.has(to) ? "bot-cluster" : to;
      if (per.has(key)) per.get(key).bought += tr.tel;
    }
  }
  const rows = [];
  for (const [key, p] of per) {
    const net = p.sold - (key === "bot-cluster" ? 0 : p.bought);
    if (net < minTel) continue;
    const known = index.known.get(key);
    const named =
      key === "bot-cluster" ? index.botLabel ?? "Bot cluster" : known?.label ?? index.sellerLabels?.get(key) ?? "Unlabelled wallet";
    rows.push({
      entity: named,
      addresses: [...p.addresses],
      chains: [...p.chains],
      destination: [...p.venues.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 3).join(", "),
      tel: round(p.sold),
      netTel: round(net),
      usd: round(p.sold * priceUsd),
      sampleTx: p.samples.sort((a, b) => b.tel - a.tel)[0]?.url ?? null,
    });
  }
  rows.sort((a, b) => b.netTel - a.netTel);
  return rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
}

/** Minimal schema check used by the generator before overwriting the file, and by tests. */
export function validateWalletFlowsReport(report) {
  const errors = [];
  if (!report || typeof report !== "object") return ["report is not an object"];
  if (report.version !== 1) errors.push("version must be 1");
  if (!report.generated || Number.isNaN(Date.parse(report.generated))) errors.push("generated must be an ISO date");
  if (!Array.isArray(report.distribution?.classes) || report.distribution.classes.length === 0) errors.push("distribution.classes missing");
  if (!Array.isArray(report.knownWallets) || report.knownWallets.length === 0) errors.push("knownWallets missing");
  if (!Array.isArray(report.largeSellers)) errors.push("largeSellers missing");
  for (const w of report.knownWallets ?? []) {
    if (!/^0x[0-9a-f]{40}$/.test(w.address ?? "")) errors.push(`bad address ${w.address}`);
  }
  return errors;
}
