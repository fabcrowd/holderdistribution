/**
 * SPL Token / Token-2022 holder snapshot for one mint.
 *
 *   getProgramAccounts(<token program>, jsonParsed,
 *     filters: [dataSize 165 (SPL only), memcmp offset 0 = mint])
 *
 * Token-2022 accounts carry extensions and can be larger than 165 bytes, so
 * that path filters on the mint only. Zero balances are dropped, and balances
 * are summed per OWNER (a wallet can hold its ATA plus other token accounts):
 * the owner is the holder identity, the same thing an EVM address means in the
 * feeds. Addresses are kept exactly as returned (base58 is case-sensitive).
 */
import { rawToNumber } from "./metadata.js";

export const SPL_TOKEN_ACCOUNT_SIZE = 165;
/** Σ token accounts vs mint supply: refuse to publish beyond this gap. */
export const SNAPSHOT_SUPPLY_TOLERANCE = 0.01;

/** getProgramAccounts params for a mint. */
export function holderScanParams(mint, program) {
  const filters = [{ memcmp: { offset: 0, bytes: mint } }];
  if (program === "spl-token") filters.unshift({ dataSize: SPL_TOKEN_ACCOUNT_SIZE });
  return { encoding: "jsonParsed", commitment: "finalized", withContext: true, filters };
}

/**
 * Aggregates getProgramAccounts rows into per-owner holders.
 * @param {Array<{pubkey: string, account: {data: {parsed: {info: {mint: string, owner: string, tokenAmount: {amount: string}}}}}}>} rows
 * @returns {{ holders: Array<{address: string, raw: string, balance: number, accounts: number}>, tokenAccountOwners: Map<string,string>, totalRaw: bigint, accounts: number, zeroAccounts: number }}
 */
export function aggregateTokenAccounts(rows, { mint, decimals }) {
  const byOwner = new Map();
  const tokenAccountOwners = new Map();
  let totalRaw = 0n;
  let accounts = 0;
  let zeroAccounts = 0;
  for (const row of rows ?? []) {
    const info = row?.account?.data?.parsed?.info;
    if (!info || (mint && info.mint !== mint)) continue;
    const owner = typeof info.owner === "string" ? info.owner.trim() : null;
    if (!owner) continue;
    accounts += 1;
    if (row.pubkey) tokenAccountOwners.set(row.pubkey, owner);
    const raw = BigInt(info.tokenAmount?.amount ?? "0");
    if (raw <= 0n) {
      zeroAccounts += 1;
      continue;
    }
    totalRaw += raw;
    const prev = byOwner.get(owner) ?? { raw: 0n, accounts: 0 };
    byOwner.set(owner, { raw: prev.raw + raw, accounts: prev.accounts + 1 });
  }
  const holders = [...byOwner.entries()]
    .map(([address, v]) => ({ address, raw: v.raw.toString(), balance: rawToNumber(v.raw, decimals), accounts: v.accounts }))
    .sort((a, b) => (BigInt(b.raw) > BigInt(a.raw) ? 1 : BigInt(b.raw) < BigInt(a.raw) ? -1 : 0));
  return { holders, tokenAccountOwners, totalRaw, accounts, zeroAccounts };
}

/**
 * Full snapshot: one getProgramAccounts call through `call(method, params)`
 * (a failover-bound caller), aggregated, then checked against the mint supply.
 * Throws (never returns a partial set) when the token-account sum is more than
 * SNAPSHOT_SUPPLY_TOLERANCE away from the supply.
 */
export async function scanMintHolders(call, { mint, programId, program, decimals, supplyRaw, logger = console }) {
  const res = await call("getProgramAccounts", [programId, holderScanParams(mint, program)]);
  const rows = Array.isArray(res) ? res : res?.value;
  const slot = Array.isArray(res) ? null : res?.context?.slot ?? null;
  if (!Array.isArray(rows)) throw new Error(`solana getProgramAccounts for ${mint}: unexpected response`);
  const agg = aggregateTokenAccounts(rows, { mint, decimals });
  if (supplyRaw !== undefined && supplyRaw !== null) {
    const supply = BigInt(supplyRaw);
    const gap = supply > agg.totalRaw ? supply - agg.totalRaw : agg.totalRaw - supply;
    const ratio = supply > 0n ? Number(gap) / Number(supply) : 0;
    if (ratio > SNAPSHOT_SUPPLY_TOLERANCE) {
      throw new Error(
        `solana ${mint}: token accounts sum to ${agg.totalRaw} raw vs mint supply ${supply} ` +
          `(${(ratio * 100).toFixed(2)}% gap) — incomplete scan; refusing to publish a partial holder set.`,
      );
    }
    if (gap > 0n) logger.warn?.(`  solana ${mint}: token accounts differ from mint supply by ${gap} raw (${(ratio * 100).toFixed(4)}%, slot drift).`);
  }
  return { ...agg, slot };
}
