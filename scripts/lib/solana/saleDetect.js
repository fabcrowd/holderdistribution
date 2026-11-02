/**
 * Sale detection for one transaction. A wallet's sale of the native token is
 * seen as the wallet receiving other value (tokens or SOL) in the same tx that
 * touches DEX pool owners.
 *
 * Owners and mints are compared exactly as given (base58 is case-sensitive).
 * Raw amounts are BigInt internally and decimal strings in the returned record.
 */
import { pairTransfers } from "./flowScan.js";
import { allMintDeltasByOwner, nativeSolDelta } from "./tokenFlows.js";
import { WSOL_MINT } from "./knownMints.js";

/** Lamports below this are fee / rent noise, not a sale. */
export const SALE_DUST_LAMPORTS = 5_000_000n;
const WSOL_DECIMALS = 9;

/**
 * @typedef {object} SaleLeg
 * @property {string} mint
 * @property {string} raw decimal string
 * @property {number} decimals
 * @property {"wallet"|"other"} holder
 * @property {string} owner
 * @property {string|null} account
 * @property {"token"|"native"} source
 */

/**
 * @param {object} p
 * @param {object} p.tx jsonParsed transaction (never mutated)
 * @param {string} p.signature
 * @param {number} p.blockTime
 * @param {string} p.wallet
 * @param {string} p.zbcnMint the native token; never a leg
 * @param {bigint} p.soldRaw wallet's DEX-bound raw amount of the native token
 * @param {Set<string>} p.dexOwners DEX owner addresses
 * @returns {{ sig: string, t: number, wallet: string, dex: string[], soldRaw: string, legs: SaleLeg[] } | null}
 */
export function detectSale({ tx, signature, blockTime, wallet, zbcnMint, soldRaw, dexOwners }) {
  const dexSet = new Set(dexOwners);
  const deltas = allMintDeltasByOwner(tx);
  const legs = [
    ...walletTokenLegs(deltas, wallet, zbcnMint),
    ...nativeLegs(tx, deltas, wallet),
  ];
  const chosen = legs.length > 0 ? legs : otherHolderLegs(deltas, wallet, zbcnMint, dexSet);
  const finalLegs = chosen.filter((leg) => leg.raw > 0n);
  if (finalLegs.length === 0) return null;
  return {
    sig: signature,
    t: blockTime,
    wallet,
    dex: dexOwnersInTx(tx, dexSet),
    soldRaw: soldRaw.toString(),
    legs: finalLegs.map(toSaleLeg),
  };
}

/** Rule (a): the wallet's own positive token deltas, excluding the native token and WSOL. */
function walletTokenLegs(deltas, wallet, zbcnMint) {
  const byMint = deltas.get(wallet);
  if (!byMint) return [];
  const legs = [];
  for (const [mint, entry] of byMint) {
    if (mint === zbcnMint || mint === WSOL_MINT || entry.raw <= 0n) continue;
    legs.push({ mint, raw: entry.raw, decimals: entry.decimals, holder: "wallet", owner: wallet, account: entry.account ?? null, source: "token" });
  }
  return legs;
}

/** Rule (c): SOL gained natively plus WSOL gained as a token, counted once as one SOL leg. */
function nativeLegs(tx, deltas, wallet) {
  const native = nativeSolDelta(tx, wallet);
  const wsol = deltas.get(wallet)?.get(WSOL_MINT)?.raw ?? 0n;
  const total = native + wsol;
  if (total < SALE_DUST_LAMPORTS) return [];
  return [{ mint: WSOL_MINT, raw: total, decimals: WSOL_DECIMALS, holder: "wallet", owner: wallet, account: null, source: "native" }];
}

/** Rule (b): tokens paid out by a DEX owner to a third owner, when the wallet gained nothing. */
function otherHolderLegs(deltas, wallet, zbcnMint, dexSet) {
  const legs = [];
  for (const mint of mintsIn(deltas)) {
    if (mint === zbcnMint) continue;
    for (const transfer of pairTransfers(deltasOfMint(deltas, mint))) {
      if (!isDexToOther(transfer, wallet, dexSet)) continue;
      const entry = deltas.get(transfer.to).get(mint);
      legs.push({ mint, raw: transfer.raw, decimals: entry.decimals, holder: "other", owner: transfer.to, account: entry.account ?? null, source: "token" });
    }
  }
  return legs;
}

function isDexToOther({ from, to }, wallet, dexSet) {
  if (from === null || to === null) return false;
  return dexSet.has(from) && to !== wallet && !dexSet.has(to);
}

function mintsIn(deltas) {
  return new Set([...deltas.values()].flatMap((byMint) => [...byMint.keys()]));
}

function deltasOfMint(deltas, mint) {
  const byOwner = new Map();
  for (const [owner, byMint] of deltas) {
    const entry = byMint.get(mint);
    if (entry) byOwner.set(owner, entry.raw);
  }
  return byOwner;
}

/** DEX owners that appear as owners of any token balance in this tx. */
function dexOwnersInTx(tx, dexSet) {
  const owners = new Set(
    [...(tx?.meta?.preTokenBalances ?? []), ...(tx?.meta?.postTokenBalances ?? [])].map((balance) => balance.owner),
  );
  return [...dexSet].filter((owner) => owners.has(owner));
}

/** Converts BigInt raw to the decimal string used in the record. */
function toSaleLeg(leg) {
  return {
    mint: leg.mint,
    raw: leg.raw.toString(),
    decimals: leg.decimals,
    holder: leg.holder,
    owner: leg.owner,
    account: leg.account,
    source: leg.source,
  };
}
