/**
 * Pure helpers that turn classified Solana wallet transfers into per-wallet
 * outflow windows and sample sell transactions. No I/O.
 *
 * Addresses are base58 and case-sensitive: they are compared exactly as given,
 * never normalised.
 */
import {
  DISTRIBUTION_CLASSES,
  RECON_CATEGORY_CLASS,
  SELL_VENUE_KINDS,
  WINDOW_SECONDS,
  WINDOWS,
  sellVenueTotal,
  telcoinSellTotals,
  verdictFor,
} from "../walletFlows.js";

const SOLSCAN_TX = "https://solscan.io/tx/";
const DEFAULT_SAMPLE_LIMIT = 4;
const DEX_VENUE = "dex";

/**
 * Keeps transfers sent by a registry wallet to a real destination and labels
 * each by its destination. Mint/burn legs (to = null) are dropped.
 * Check order: CEX, DEX, staking, internal, unlabelled.
 * @param {Array<{from: string|null, to: string|null, raw: bigint}>} transfers pairTransfers output
 * @param {{wallets: Set<string>, cex: Map<string, string>, dex: Set<string>, staking: Set<string>}} roles
 * @returns {Array<{wallet: string, dest: string, kind: string, venue: string|null, raw: bigint}>}
 */
export function classifyWalletTransfers(transfers, roles) {
  const out = [];
  for (const { from, to, raw } of transfers) {
    if (from === null || to === null || !roles.wallets.has(from)) continue;
    out.push({ wallet: from, dest: to, ...destinationKind(to, roles), raw });
  }
  return out;
}

/**
 * Like classifyWalletTransfers, but keeps every transfer sent by `from` instead
 * of requiring it to be a registry wallet. Used to follow the funds of an owner
 * that is not in the registry. Mint/burn legs are dropped.
 * @param {Array<{from: string|null, to: string|null, raw: bigint}>} transfers pairTransfers output
 * @param {string} from sender to keep, compared exactly (base58 is case-sensitive)
 * @param {{cex: Map<string, string>, dex: Set<string>, staking: Set<string>, wallets: Set<string>}} roles
 * @returns {Array<{wallet: string, dest: string, kind: string, venue: string|null, raw: bigint}>}
 */
export function classifyFrom(transfers, from, roles) {
  const out = [];
  for (const { from: sender, to, raw } of transfers) {
    if (sender === null || to === null || sender !== from) continue;
    out.push({ wallet: from, dest: to, ...destinationKind(to, roles), raw });
  }
  return out;
}

/** Labels a destination: CEX, DEX, staking, internal (registry wallet) or unlabelled. */
export function destinationKind(to, roles) {
  if (roles.cex.has(to)) return { kind: "CEX", venue: roles.cex.get(to) };
  if (roles.dex.has(to)) return { kind: "DEX", venue: DEX_VENUE };
  if (roles.staking.has(to)) return { kind: "staking", venue: null };
  if (roles.wallets.has(to)) return { kind: "internal", venue: null };
  return { kind: "unlabelled", venue: null };
}

/**
 * JSON-safe wallet events. raw becomes a decimal string so events survive
 * JSON persistence without losing precision.
 * @param {ReturnType<typeof classifyWalletTransfers>} classified
 * @param {{signature: string, blockTime: number}} tx
 */
export function toWalletEvents(classified, { signature, blockTime }) {
  return classified.map(({ wallet, kind, venue, dest, raw }) => ({
    wallet,
    kind,
    venue,
    dest,
    raw: raw.toString(),
    t: blockTime,
    sig: signature,
  }));
}

/** Drops events older than the 90-day window. */
export function pruneEvents(events, nowSec) {
  const floor = nowSec - WINDOW_SECONDS["90d"];
  return events.filter((e) => e.t >= floor);
}

const sumBigInt = (a, b) => a + b;

/**
 * Per wallet, per window, per kind: outflow in UI units. Sums stay BigInt until
 * the final division so no precision is lost on large raw amounts.
 * @returns {Map<string, Record<string, Record<string, number>>>}
 */
export function aggregateWalletOutflows(events, nowSec, decimals) {
  const scale = 10 ** decimals;
  const sums = new Map();
  for (const e of events) {
    const amount = BigInt(e.raw);
    let byWindow = sums.get(e.wallet);
    if (!byWindow) {
      byWindow = Object.fromEntries(WINDOWS.map((w) => [w, new Map()]));
      sums.set(e.wallet, byWindow);
    }
    for (const w of WINDOWS) {
      if (e.t < nowSec - WINDOW_SECONDS[w]) continue;
      const kinds = byWindow[w];
      kinds.set(e.kind, sumBigInt(kinds.get(e.kind) ?? 0n, amount));
    }
  }
  const result = new Map();
  for (const [wallet, byWindow] of sums) {
    const perWindow = Object.fromEntries(
      WINDOWS.map((w) => [w, Object.fromEntries([...byWindow[w]].map(([kind, sum]) => [kind, Number(sum) / scale]))]),
    );
    result.set(wallet, perWindow);
  }
  return result;
}

const isSellEvent = (e) => SELL_VENUE_KINDS.includes(e.kind);

/**
 * Largest sell-venue transactions per wallet inside the 90-day window.
 * Wallets without any such event are absent from the result.
 * @returns {Map<string, string[]>}
 */
export function sampleTxs(events, nowSec, limit = DEFAULT_SAMPLE_LIMIT) {
  const floor = nowSec - WINDOW_SECONDS["90d"];
  const byWallet = new Map();
  for (const e of events) {
    if (e.t < floor || !isSellEvent(e)) continue;
    const list = byWallet.get(e.wallet) ?? [];
    list.push(e);
    byWallet.set(e.wallet, list);
  }
  const result = new Map();
  for (const [wallet, list] of byWallet) {
    const urls = [...list]
      .sort((a, b) => compareBigIntDesc(BigInt(a.raw), BigInt(b.raw)))
      .slice(0, limit)
      .map((e) => `${SOLSCAN_TX}${e.sig}`);
    result.set(wallet, urls);
  }
  return result;
}

function compareBigIntDesc(a, b) {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

const round = (n) => Math.round(Number(n) || 0);

const roundMap = (m) =>
  Object.fromEntries(
    Object.entries(m ?? {})
      .map(([k, v]) => [k, round(v)])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]),
  );

const emptyOutflows = () => Object.fromEntries(WINDOWS.map((w) => [w, {}]));

/**
 * One row per registry wallet, same shape as EVM buildKnownWalletRows. Addresses
 * are base58 and kept exactly as given (no case folding).
 * @param {object} registry
 * @param {Map<string, Record<string, Record<string, number>>>} flows aggregateWalletOutflows output
 * @param {Map<string, number>} balances address → balance in UI units
 * @param {number} priceUsd
 * @param {Map<string, string[]>} [samples] sampleTxs output
 */
export function buildSolanaWalletRows(registry, flows, balances, priceUsd, samples = new Map()) {
  const rows = [];
  for (const entry of registry.knownWallets ?? []) {
    const address = entry.address;
    const out = flows.get(address) ?? emptyOutflows();
    const rawBalance = balances.get(address) ?? 0;
    const sell = Object.fromEntries(WINDOWS.map((w) => [w, round(sellVenueTotal(out[w]))]));
    rows.push({
      label: entry.label,
      group: entry.group,
      entityClass: entry.entityClass,
      source: entry.source,
      confidence: entry.confidence,
      address,
      chains: entry.chains ?? [],
      balance: round(rawBalance),
      balanceDetail: rawBalance > 0 ? { solana: round(rawBalance) } : {},
      balanceUsd: round(rawBalance * priceUsd),
      outflows: Object.fromEntries(WINDOWS.map((w) => [w, roundMap(out[w])])),
      sellVenue: sell,
      sellVenueUsd90d: round(sell["90d"] * priceUsd),
      sampleTxs: samples.get(address) ?? [],
      verdict: verdictFor(entry, out["90d"]),
    });
  }
  rows.sort((x, y) => y.sellVenue["90d"] - x.sellVenue["90d"] || y.balance - x.balance);
  return rows;
}

/** Neutral class labels: the Solana view is not Telcoin-branded. */
const NEUTRAL_CLASS_LABELS = {
  treasury: "Treasury",
  association: "Association & council",
  holdings: "Team & holdings",
  escrow: "Escrow & custody",
  staking: "Staking",
  cex: "Centralised exchanges",
  dex: "DEX pools",
  bots: "Tracked sellers",
  other: "Other labelled",
  retail: "Retail & unlabelled holders",
};

/**
 * Supply distribution from supply-reconciliation categories. Categories with no
 * class map to "other"; nothing is moved between classes.
 * @param {{ totalSupply?: number, categories?: Record<string, number> }} recon
 * @param {{ extraClassMap?: Record<string, string> }} [options]
 */
export function distributionFromRecon(recon, { extraClassMap } = {}) {
  const classMap = { ...RECON_CATEGORY_CLASS, staking: "staking", ...(extraClassMap ?? {}) };
  const amounts = Object.fromEntries(DISTRIBUTION_CLASSES.map((c) => [c.key, 0]));
  for (const [category, amount] of Object.entries(recon?.categories ?? {})) {
    const mapped = classMap[category];
    const key = Object.hasOwn(amounts, mapped) ? mapped : "other";
    amounts[key] += Number(amount) || 0;
  }
  const countedRaw = Object.values(amounts).reduce((s, v) => s + v, 0);
  return {
    totalSupply: recon?.totalSupply,
    counted: round(countedRaw),
    classes: DISTRIBUTION_CLASSES.map((c) => ({
      key: c.key,
      label: NEUTRAL_CLASS_LABELS[c.key],
      group: c.group,
      tel: round(amounts[c.key]),
      share: countedRaw > 0 ? amounts[c.key] / countedRaw : 0,
    })),
    movedFromRetail: [],
  };
}

/** Same shape as telcoinSellTotals; relay and escrow rows are skipped there. */
export function solanaSellTotals(rows, priceUsd) {
  return telcoinSellTotals(rows, priceUsd);
}
