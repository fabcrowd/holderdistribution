/**
 * Classify one transfer touching a developer wallet into a ledger tx type
 * (config/ledger-tx-types.json). Pure: no I/O.
 *
 * Input transfer:
 *   { chain, hash, time (unix s), from, to, amount (ui units), asset: "token" | "stable",
 *     symbol, swap?: boolean (receipt emitted a Swap event) }
 * Output event adds: type, direction, wallet, walletLabel, counterparty,
 *   counterpartyLabel, reason (the per-event "how identified"), internal, headline.
 */
import { addr, ZERO_EVM } from "./config.js";

const SOL_BURN = new Set(["1nc1nerator11111111111111111111111111111111"]);
const isZero = (a) => !a || a === ZERO_EVM || SOL_BURN.has(a);
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? ""));

/**
 * @param {object} t transfer
 * @param {ReturnType<import("./config.js").buildLedgerIndex>} ix
 * @param {Record<string, {headline?: boolean, internal?: boolean}>} types catalog `types`
 * @returns {object|null} null when neither side is a developer wallet
 */
export function classifyTransfer(t, ix, types = {}) {
  const from = t.from ? addr(t.from) : null;
  const to = t.to ? addr(t.to) : null;
  const fromDev = from !== null && ix.dev.has(from);
  const toDev = to !== null && ix.dev.has(to);
  if (!fromDev && !toDev) return null;

  const label = (a) => ix.dev.get(a)?.label ?? null;
  let type;
  let reason;
  let counterpartyLabel = null;
  const direction = fromDev && toDev ? "internal" : fromDev ? "out" : "in";
  const counterparty = direction === "in" ? from : to;

  if (t.asset === "stable") {
    if (direction === "internal") {
      type = "stable_internal";
      reason = `${t.symbol} moved from ${label(from)} to ${label(to)}; both are developer wallets.`;
    } else if (direction === "out") {
      type = "stable_out";
      counterpartyLabel = venueLabel(to, ix);
      reason = `${t.symbol} left ${label(from)} for ${counterpartyLabel ?? `unlabelled wallet ${short(to)}`}.`;
    } else {
      type = "stable_in";
      counterpartyLabel = venueLabel(from, ix);
      reason = `${t.symbol} arrived at ${label(to)} from ${counterpartyLabel ?? `unlabelled wallet ${short(from)}`}.`;
    }
  } else if (direction === "internal") {
    type = "internal_shuffle";
    reason = `Sender ${label(from)} and recipient ${label(to)} are both developer wallets (ledger developerWallets).`;
  } else if (direction === "in") {
    if (ix.staking.has(from)) {
      type = "staking";
      counterpartyLabel = ix.staking.get(from);
      reason = `Came back from staking/reward contract ${counterpartyLabel} (ledger venues.staking).`;
    } else {
      type = "receive";
      counterpartyLabel = venueLabel(from, ix);
      reason = `Received from ${counterpartyLabel ?? `unlabelled wallet ${short(from)}`}, which is not a developer wallet.`;
    }
  } else if (isZero(to)) {
    type = "burn";
    counterpartyLabel = "Burn address";
    reason = "Recipient is the zero / incinerator address.";
  } else if (ix.bot.has(to)) {
    type = "bot_funding";
    counterpartyLabel = "Bot cluster";
    reason = `Recipient ${short(to)} is one of the flagged bot-cluster wallets (ledger botCluster.addresses).`;
  } else if (ix.relays.has(to)) {
    const r = ix.relays.get(to);
    type = r.kind === "cex" ? "cex_deposit" : r.kind === "custody" ? "custody" : r.kind === "bridge" ? "bridge" : "dex_sell";
    counterpartyLabel = `${r.label} (via relay)`;
    reason = `Recipient ${short(to)} is a known relay that forwards to ${r.label}${r.endpoint ? ` ${short(r.endpoint)}` : ""} (ledger relays).`;
  } else if (ix.cex.has(to)) {
    type = "cex_deposit";
    counterpartyLabel = ix.cex.get(to);
    reason = `Recipient is labelled exchange wallet "${counterpartyLabel}" (CEX list).`;
  } else if (ix.dex.has(to)) {
    type = "dex_sell";
    counterpartyLabel = ix.dex.get(to);
    reason = `Recipient is DEX venue "${counterpartyLabel}" (DEX list / ledger venues.dex).`;
  } else if (ix.bridges.has(to)) {
    type = "bridge";
    counterpartyLabel = ix.bridges.get(to);
    reason = `Recipient is bridge contract "${counterpartyLabel}" (ledger venues.bridges).`;
  } else if (ix.custody.has(to)) {
    type = "custody";
    counterpartyLabel = ix.custody.get(to);
    reason = `Recipient is custody/escrow "${counterpartyLabel}" (ledger venues.custody).`;
  } else if (ix.staking.has(to)) {
    type = "staking";
    counterpartyLabel = ix.staking.get(to);
    reason = `Recipient is staking/reward contract "${counterpartyLabel}" (ledger venues.staking).`;
  } else if (t.swap) {
    type = "dex_sell";
    counterpartyLabel = "DEX (swap in receipt)";
    reason = "The transaction receipt emitted a DEX Swap event, so the transfer was part of a trade.";
  } else {
    type = "transfer_out";
    reason = `Recipient ${short(to)} has no label, is not a developer wallet and the receipt has no Swap event.`;
  }

  const meta = types[type] ?? {};
  return {
    chain: t.chain,
    hash: t.hash,
    time: t.time,
    date: t.time ? new Date(t.time * 1000).toISOString().slice(0, 10) : null,
    type,
    direction,
    wallet: direction === "in" ? to : from,
    walletLabel: direction === "in" ? label(to) : label(from),
    counterparty,
    counterpartyLabel: direction === "internal" ? label(to) : counterpartyLabel,
    asset: t.asset,
    symbol: t.symbol,
    amount: t.amount,
    reason,
    internal: meta.internal === true,
    headline: meta.headline === true,
  };
}

function venueLabel(a, ix) {
  if (!a) return null;
  if (ix.cex.has(a)) return ix.cex.get(a);
  if (ix.dex.has(a)) return ix.dex.get(a);
  if (ix.bridges.has(a)) return ix.bridges.get(a);
  if (ix.custody.has(a)) return ix.custody.get(a);
  if (ix.staking.has(a)) return ix.staking.get(a);
  if (ix.relays.has(a)) return `${ix.relays.get(a).label} (via relay)`;
  if (ix.bot.has(a)) return "Bot cluster";
  return null;
}

/**
 * A bot-cluster wallet's outgoing token transfer: a sale when it reaches a DEX
 * venue or the receipt shows a swap; bot-to-bot moves and others are ignored.
 * Returns { chain, hash, time, date, wallet, amount, venue, reason } or null.
 */
export function classifyBotTransfer(t, ix) {
  const from = addr(t.from);
  const to = t.to ? addr(t.to) : null;
  if (!ix.bot.has(from) || t.asset !== "token") return null;
  if (to && ix.bot.has(to)) return null;
  let venue = null;
  let reason = null;
  if (to && ix.dex.has(to)) {
    venue = ix.dex.get(to);
    reason = `Bot wallet sent to DEX venue "${venue}".`;
  } else if (t.swap) {
    venue = "DEX (swap in receipt)";
    reason = "Bot wallet transfer inside a transaction that emitted a Swap event.";
  } else if (to && (ix.cex.has(to) || (ix.relays.get(to)?.kind === "cex"))) {
    venue = ix.cex.get(to) ?? ix.relays.get(to).label;
    reason = `Bot wallet deposited to exchange "${venue}".`;
  } else return null;
  return {
    chain: t.chain,
    hash: t.hash,
    time: t.time,
    date: t.time ? new Date(t.time * 1000).toISOString().slice(0, 10) : null,
    wallet: from,
    to,
    amount: t.amount,
    venue,
    reason,
  };
}
