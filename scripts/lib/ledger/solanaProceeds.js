/**
 * Solana side of trace-bot-proceeds: the same chain record as the EVM
 * traceSale (proceeds.js), so summarizeProceeds and the UI stay identical.
 * Proceeds are decoded the way the wallet-flows sales journal
 * (scripts/lib/solana/salesJournal.js) reads a sale: only wallet-held legs
 * count — the seller's positive non-token mint deltas in the sale tx, plus
 * native SOL (fee added back) folded into SOL.
 */
import { listSignatures } from "../solana/flowScan.js";
import { getTransactionAnyVersion } from "../solana/getTransaction.js";
import { allMintDeltasByOwner, nativeSolDelta } from "../solana/tokenFlows.js";
import { WSOL_MINT, knownDecimalsOf, symbolOf } from "../solana/knownMints.js";
import { toUiAmount } from "../solana/salesJournal.js";
import { stopFor } from "./proceeds.js";

const SOL_DECIMALS = 9;

/** Pure: proceeds legs `wallet` received in one parsed sale tx. */
export function solanaProceedsFromTx(tx, wallet, assets, soldMints = new Set()) {
  const out = [];
  const mine = allMintDeltasByOwner(tx).get(wallet);
  let sol = nativeSolDelta(tx, wallet);
  for (const [mint, d] of mine ?? []) {
    if (soldMints.has(mint) || d.raw <= 0n) continue;
    if (mint === WSOL_MINT) { sol += d.raw; continue; }
    const a = assets.get(mint);
    const decimals = a?.decimals ?? knownDecimalsOf(mint) ?? 0;
    out.push({ contract: mint, asset: a?.asset ?? "other", symbol: a?.symbol ?? symbolOf(mint) ?? mint.slice(0, 4), amount: toUiAmount(d.raw, decimals) });
  }
  // Ignore lamport dust (fee add-back, rent refunds) below 0.0001 SOL.
  if (sol > 100_000n) out.push({ contract: WSOL_MINT, asset: "native", symbol: "SOL", amount: toUiAmount(sol, SOL_DECIMALS) });
  return out;
}

/** Pure: first outgoing move of `mint` (SOL = native + wSOL) from `holder` in tx -> { to, amount } | null. */
export function solanaOutflow(tx, holder, mint) {
  const deltas = allMintDeltasByOwner(tx);
  const isSol = mint === WSOL_MINT;
  const own = (o) => (deltas.get(o)?.get(mint)?.raw ?? 0n) + (isSol ? nativeSolDelta(tx, o) : 0n);
  const lost = own(holder);
  if (lost >= 0n) return null;
  let best = null;
  const owners = new Set(deltas.keys());
  if (isSol) for (const k of tx?.transaction?.message?.accountKeys ?? []) owners.add(typeof k === "string" ? k : k?.pubkey);
  for (const o of owners) {
    if (!o || o === holder) continue;
    const g = own(o);
    if (g > 0n && (!best || g > best.g)) best = { to: o, g };
  }
  return best ? { to: best.to, raw: -lost } : null;
}

/** Trace one Solana bot sale: same record shape as proceeds.js traceSale. */
export async function traceSolanaSale({ sale, call, ix, assets, maxHops = 2, devShare = 0, soldMints, knownLabels, perHopTx = 25, getTx = getTransactionAnyVersion }) {
  const rec = { sale: { hash: sale.hash, time: sale.time, date: sale.date, wallet: sale.wallet, amount: sale.amount, venue: sale.venue, chain: sale.chain }, proceeds: [], hops: [], stop: null, devShare };
  const tx = await getTx(call, sale.hash);
  rec.proceeds = solanaProceedsFromTx(tx, sale.wallet, assets, soldMints).map((p) => ({ ...p, hash: sale.hash }));
  if (!rec.proceeds.length) {
    rec.stop = { kind: "untraced", label: "No proceeds credited to the selling wallet in the sale transaction" };
    return rec;
  }
  const main = rec.proceeds.reduce((a, b) => ((b.amount ?? 0) > (a.amount ?? 0) ? b : a));
  rec.devAttributed = main.amount * devShare;
  const decimals = main.contract === WSOL_MINT ? SOL_DECIMALS : (assets.get(main.contract)?.decimals ?? knownDecimalsOf(main.contract) ?? 0);
  let holder = sale.wallet;
  let since = sale.time;
  for (let hop = 1; hop <= maxHops; hop++) {
    const sigs = (await listSignatures(call, holder, { sinceSec: since, maxPages: 1, pageSize: 200 }).catch(() => []))
      .filter((s) => s.signature !== sale.hash && s.blockTime >= since)
      .sort((a, b) => a.blockTime - b.blockTime)
      .slice(0, perHopTx);
    let next = null;
    for (const s of sigs) {
      const o = solanaOutflow(await getTx(call, s.signature), holder, main.contract);
      if (o) { next = { ...o, hash: s.signature, time: s.blockTime }; break; }
    }
    if (!next) {
      rec.stop = { kind: "held", label: `Still held by ${hop === 1 ? "the bot wallet" : holder}` };
      return rec;
    }
    const stop = stopFor(next.to, ix, { knownLabels });
    rec.hops.push({ hop, hash: next.hash, time: next.time, from: holder, to: next.to, amount: toUiAmount(next.raw, decimals), symbol: main.symbol, label: stop?.label ?? null, kind: stop?.kind ?? "unlabelled" });
    if (stop) { rec.stop = stop; return rec; }
    holder = next.to;
    since = next.time;
  }
  rec.stop = { kind: "unlabelled", label: `Unlabelled wallet after ${maxHops} hops` };
  return rec;
}
