/**
 * Solana side of the developer-wallet ledger, built on scripts/lib/solana:
 * listSignatures (per owner + its associated token accounts), getTransactionAnyVersion,
 * allMintDeltasByOwner + pairTransfers. RPCs: SOLANA_RPC_0 (Helius) first, then
 * SOLANA_RPC_1 (public) via solanaCallWithFailover / keyedFirst in the caller.
 *
 * Incremental: one `until` cursor per scanned account. Signatures from every
 * account are merged and processed OLDEST FIRST; a per-run cap cuts that global
 * order as a prefix, so each account's cursor stays correct (walletFlowScan.js).
 */
import { bySlotThenSig, listSignatures, mapLimit, pairTransfers } from "../solana/flowScan.js";
import { getTransactionAnyVersion } from "../solana/getTransaction.js";
import { allMintDeltasByOwner } from "../solana/tokenFlows.js";
import { WSOL_MINT } from "../solana/knownMints.js";

/** Pure: ledger transfers out of one parsed tx (only pairs touching `watched` owners). */
export function solanaTransfersFromTx(tx, { signature, blockTime, chain, assets, watched }) {
  const deltas = allMintDeltasByOwner(tx);
  const perMint = new Map();
  for (const [owner, mints] of deltas) {
    for (const [mint, d] of mints) {
      if (!assets.has(mint)) continue;
      if (!perMint.has(mint)) perMint.set(mint, new Map());
      perMint.get(mint).set(owner, d.raw);
    }
  }
  const out = [];
  for (const [mint, m] of perMint) {
    const a = assets.get(mint);
    for (const p of pairTransfers(m)) {
      if (!(p.from && watched.has(p.from)) && !(p.to && watched.has(p.to))) continue;
      const fromMints = p.from ? deltas.get(p.from) : null;
      // A seller that lost the token and gained a stable / wSOL in the same tx swapped.
      const swap =
        a.asset === "token" &&
        !!fromMints &&
        [...fromMints].some(([om, d]) => om !== mint && d.raw > 0n && (om === WSOL_MINT || assets.get(om)?.asset === "stable"));
      out.push({
        chain,
        hash: signature,
        uniqueId: `${signature}:${mint}:${p.from}:${p.to}:${p.raw}`,
        time: blockTime,
        from: p.from,
        to: p.to,
        contract: mint,
        asset: a.asset,
        symbol: a.symbol,
        amount: Number(p.raw) / 10 ** a.decimals,
        swap,
      });
    }
  }
  return out;
}

/**
 * @param {object} p
 * @param {(method:string, params:any[]) => Promise<any>} p.call  failover-wrapped RPC
 * @param {{wallet:string, account:string}[]} p.accounts   owners and their token accounts to list
 * @param {Map<string,{asset,symbol,decimals}>} p.assets  mint -> asset
 * @param {Set<string>} p.watched   developer owners (+ bot wallets)
 */
export async function scanSolanaChain({ chain, call, accounts, assets, watched, checkpoint = null, nowSec, historyDays, maxTx = 4000, concurrency = 4, logger = console }) {
  const prev = checkpoint?.accounts ?? {};
  const bySig = new Map();
  for (const { wallet, account } of accounts) {
    const sigs = await listSignatures(call, account, { until: prev[account]?.until ?? null, sinceSec: nowSec - historyDays * 86400 });
    for (const s of sigs) {
      const e = bySig.get(s.signature) ?? { ...s, accounts: new Set(), wallets: new Set() };
      e.accounts.add(account);
      e.wallets.add(wallet);
      bySig.set(s.signature, e);
    }
  }
  const ordered = [...bySig.values()].sort(bySlotThenSig);
  const batch = ordered.slice(0, maxTx);
  const txs = await mapLimit(batch, concurrency, async (s) => {
    try {
      return await getTransactionAnyVersion(call, s.signature);
    } catch (err) {
      logger.warn?.(`${chain}: getTransaction ${s.signature.slice(0, 12)}… failed (${String(err?.message ?? err).slice(0, 80)})`);
      return undefined;
    }
  });
  const transfers = [];
  const accountsOut = { ...prev };
  let processed = 0;
  for (let i = 0; i < batch.length; i++) {
    // A failed fetch stops the prefix here so the cursor never skips it.
    if (txs[i] === undefined) break;
    processed++;
    const s = batch[i];
    if (txs[i]) transfers.push(...solanaTransfersFromTx(txs[i], { signature: s.signature, blockTime: s.blockTime, chain, assets, watched }));
    for (const a of s.accounts) accountsOut[a] = { until: s.signature, blockTime: s.blockTime };
  }
  return {
    transfers,
    cursor: { accounts: accountsOut, headTime: new Date(nowSec * 1000).toISOString(), backlog: ordered.length - processed },
    stats: { signatures: ordered.length, processed, backlog: ordered.length - processed, transfers: transfers.length },
  };
}
