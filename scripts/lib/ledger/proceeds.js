/**
 * Bot-cluster sale proceeds tracer (scripts/trace-bot-proceeds.js).
 *
 *   sale tx receipt -> proceeds (ERC-20 Transfer INTO the bot wallet in the same tx)
 *   -> hop 1 (bot wallet's next outgoing transfer of that asset)
 *   -> hop 2 (that recipient's next outgoing transfer), stopping as soon as a
 *      hop lands on a CEX, bridge, custody, developer or other known wallet.
 *
 * Every link carries its tx hash. Developer attribution is pro-rata: each
 * chain's amount x the developer share of the bot's funding.
 * Network calls are injected so the logic is testable offline.
 */
import { addr } from "./config.js";
import { fetchWalletTransfers, normalizeAlchemyTransfer } from "./evmSource.js";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (t) => "0x" + String(t).slice(-40).toLowerCase();

/** ERC-20 inflows to `wallet` inside one receipt (excluding the sold token itself). */
export function proceedsFromReceipt(receipt, wallet, assets, soldContracts = new Set()) {
  const w = addr(wallet);
  const out = [];
  for (const l of receipt?.logs ?? []) {
    if (String(l?.topics?.[0]).toLowerCase() !== TRANSFER_TOPIC || (l.topics?.length ?? 0) < 3) continue;
    const contract = String(l.address).toLowerCase();
    if (soldContracts.has(contract) || topicAddr(l.topics[2]) !== w) continue;
    const a = assets.get(contract);
    let raw;
    try {
      raw = BigInt(l.data);
    } catch {
      continue;
    }
    out.push({
      contract,
      symbol: a?.symbol ?? "unknown token",
      asset: a?.asset ?? "other",
      amount: a ? Number(raw) / 10 ** a.decimals : null,
      raw: raw.toString(),
      from: topicAddr(l.topics[1]),
    });
  }
  return out;
}

/** Where a hop ended: { kind, label } or null to keep following. */
export function stopFor(address, ix, { knownLabels = new Map() } = {}) {
  const a = addr(address);
  if (ix.dev.has(a)) return { kind: "developer", label: ix.dev.get(a).label };
  if (ix.relays.has(a)) return { kind: ix.relays.get(a).kind, label: `${ix.relays.get(a).label} (via relay)` };
  if (ix.cex.has(a)) return { kind: "cex", label: ix.cex.get(a) };
  if (ix.bridges.has(a)) return { kind: "bridge", label: ix.bridges.get(a) };
  if (ix.custody.has(a)) return { kind: "custody", label: ix.custody.get(a) };
  if (ix.staking.has(a)) return { kind: "known", label: ix.staking.get(a) };
  if (ix.dex.has(a)) return { kind: "dex", label: ix.dex.get(a) };
  if (ix.bot.has(a)) return { kind: "bot", label: "Bot cluster" };
  if (knownLabels.has(a)) return { kind: "known", label: knownLabels.get(a) };
  return null;
}

/**
 * Trace one sale. `sale` = classifyBotTransfer row + blockNumber.
 * @returns {Promise<object>} chain record (always has sale.hash; links have hashes)
 */
export async function traceSale({ sale, url, rpc, assetTransfers, ix, assets, maxHops = 2, devShare = 0, soldContracts, knownLabels }) {
  const rec = { sale: { hash: sale.hash, time: sale.time, date: sale.date, wallet: sale.wallet, amount: sale.amount, venue: sale.venue, chain: sale.chain }, proceeds: [], hops: [], stop: null, devShare };
  const receipt = await rpc(url, "eth_getTransactionReceipt", [sale.hash]);
  rec.proceeds = proceedsFromReceipt(receipt, sale.wallet, assets, soldContracts).map((p) => ({ ...p, hash: sale.hash }));
  if (!rec.proceeds.length) {
    rec.stop = { kind: "untraced", label: "No ERC-20 proceeds in the sale receipt (paid in the native coin, or to another address)" };
    return rec;
  }
  const main = rec.proceeds.reduce((a, b) => ((b.amount ?? 0) > (a.amount ?? 0) ? b : a));
  rec.devAttributed = main.amount != null ? main.amount * devShare : null;
  const contractAssets = new Map([[main.contract, assets.get(main.contract) ?? { asset: "other", symbol: main.symbol, decimals: 18 }]]);

  let holder = sale.wallet;
  let fromBlock = sale.blockNumber;
  for (let hop = 1; hop <= maxHops; hop++) {
    const raw = await fetchWalletTransfers({ url, address: holder, direction: "from", contracts: [main.contract], fromBlock, toBlock: "latest", assetTransfers });
    const next = raw.map((t) => normalizeAlchemyTransfer(t, sale.chain, contractAssets)).filter(Boolean)[0];
    if (!next) {
      rec.stop = { kind: "held", label: `Still held by ${hop === 1 ? "the bot wallet" : holder}` };
      return rec;
    }
    const stop = stopFor(next.to, ix, { knownLabels });
    rec.hops.push({ hop, hash: next.hash, time: next.time, from: next.from, to: next.to, amount: next.amount, symbol: main.symbol, label: stop?.label ?? null, kind: stop?.kind ?? "unlabelled" });
    if (stop) {
      rec.stop = stop;
      return rec;
    }
    holder = next.to;
    fromBlock = next.blockNumber;
  }
  rec.stop = { kind: "unlabelled", label: `Unlabelled wallet after ${maxHops} hops` };
  return rec;
}

/** Summary over traced chains: proceeds and developer-attributed amounts by asset and destination. */
export function summarizeProceeds(chains, devShare) {
  const byAsset = {};
  const byDest = new Map();
  let sold = 0;
  for (const c of chains) {
    sold += c.sale.amount || 0;
    const main = c.proceeds?.length ? c.proceeds.reduce((a, b) => ((b.amount ?? 0) > (a.amount ?? 0) ? b : a)) : null;
    if (!main || main.amount == null) continue;
    const s = (byAsset[main.symbol] ??= { proceeds: 0, devAttributed: 0, sales: 0 });
    s.proceeds += main.amount;
    s.devAttributed += main.amount * devShare;
    s.sales++;
    const k = `${c.stop?.kind}|${c.stop?.label}`;
    const d = byDest.get(k) ?? { kind: c.stop?.kind, label: c.stop?.label, amount: 0, devAttributed: 0, symbol: main.symbol, chains: 0, sampleHashes: [] };
    d.amount += main.amount;
    d.devAttributed += main.amount * devShare;
    d.chains++;
    const last = c.hops[c.hops.length - 1]?.hash ?? c.sale.hash;
    if (d.sampleHashes.length < 5) d.sampleHashes.push(last);
    byDest.set(k, d);
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 100) / 100 : v]));
  return {
    salesTraced: chains.length,
    tokenSold: Math.round(sold),
    tokenSoldDevShare: Math.round(sold * devShare),
    byAsset: Object.fromEntries(Object.entries(byAsset).map(([k, v]) => [k, round(v)])),
    destinations: [...byDest.values()].map(round).sort((a, b) => b.amount - a.amount),
  };
}

/** The "why is this cluster flagged" block: config evidence + the funding txs. */
export function evidenceBlock(botCluster, devShare) {
  const dev = (botCluster.funding ?? []).filter((f) => f.source === "developer");
  const ext = (botCluster.funding ?? []).filter((f) => f.source !== "developer");
  return {
    summary: `${botCluster.label}: ${botCluster.addresses.length} wallets on ${botCluster.chain}. ${Math.round(devShare * 1000) / 10}% of its funding came from developer wallets, so that share of its sales and proceeds counts as developer selling.`,
    points: botCluster.evidence ?? [],
    funding: [...dev, ...ext].map((f) => ({ source: f.source, label: f.label, address: f.address ?? null, amount: f.amount, confidence: f.confidence ?? null, when: f.when ?? null, txs: f.evidenceTxs ?? [], counted: f.source === "developer" })),
    devShare: Number(devShare.toFixed(4)),
  };
}
