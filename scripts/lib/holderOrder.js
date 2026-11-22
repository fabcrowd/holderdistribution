/**
 * The ordering of holder rows, wallet rows and raw-balance keys in the snapshot writers.
 *
 * Rows go by balance descending, then by address ascending, so equal balances land in an order that is a
 * function of the data and not of the scan's insertion order (what lets a snapshot be rebuilt byte for byte).
 * The address order depends on the address family of the rows being sorted:
 *   - Hedera account numbers (every address is `0.0.<n>`): ascending account number. This is also the order
 *     the sharded-v1 layout (snapshotShards.js) rebuilds from its shards, so slim-v1 and sharded-v1 agree.
 *   - everything else (EVM hex, Solana base58, legacy two-chain TEL): plain UTF-16 code-unit comparison (`a < b`).
 * Used by: sortHolders / sortWallets (pull-holders-rpc.js, resyncSnapshot legacy branch, solanaStaking.js) for
 * slim-v1 and legacy snapshots; canonicalCheckpointChains (holders-checkpoint.json keys, code-unit order).
 * sharded-v1 does not use this file: buildShards/assembleSnapshot keep their own numeric account order.
 * Ordering never changes a balance or a row.
 */

const ACCOUNT_ADDRESS = /^0\.0\.(0|[1-9]\d*)$/;
const accountNumberOf = (address) => Number(address.slice(4));

/** Code-unit order of two addresses (total over strings). */
export const compareAddress = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Ascending account number; total over `0.0.<n>` addresses of safe-integer size. */
export const compareAccountAddress = (a, b) => accountNumberOf(a) - accountNumberOf(b);

// Balances compare as numbers (a string "9" is below "10"); NaN, undefined and other non-numbers sort last.
const rankOf = (value) => {
  const n = Number(value);
  return Number.isNaN(n) ? -Infinity : n;
};

const byBalanceDescThen = (balanceOf, compareAddresses) => (a, b) => {
  const left = rankOf(balanceOf(a));
  const right = rankOf(balanceOf(b));
  if (left !== right) {
    if (left > right) return -1;
    if (left < right) return 1;
  }
  return compareAddresses(a.address, b.address);
};

/** Account-number order when every row is a `0.0.<n>` address (and there is at least one), else code-unit order. */
const addressOrderFor = (rows) =>
  rows.length > 0 && rows.every((row) => ACCOUNT_ADDRESS.test(row.address ?? "") && Number.isSafeInteger(accountNumberOf(row.address)))
    ? compareAccountAddress
    : compareAddress;

/** Comparators; `compareAddresses` defaults to code-unit order. */
export const compareHolders = byBalanceDescThen((row) => row.balance, compareAddress);
export const walletComparator = (totalKey, compareAddresses = compareAddress) =>
  byBalanceDescThen((row) => row[totalKey], compareAddresses);

/** In-place sorts for one snapshot's rows (the address family is read from the rows); return the array. */
export const sortHolders = (rows) => rows.sort(byBalanceDescThen((row) => row.balance, addressOrderFor(rows)));
export const sortWallets = (rows, totalKey) => rows.sort(walletComparator(totalKey, addressOrderFor(rows)));

/** New object with the same entries, keys in code-unit ascending order (addresses are never array-index-like keys). */
export const canonicalKeyOrder = (object) => {
  const out = {};
  for (const key of Object.keys(object ?? {}).sort(compareAddress)) out[key] = object[key];
  return out;
};

const KEYED_MAPS = ["rawBalances", "retired"];

const canonicalSection = (section) => {
  if (!section || typeof section !== "object") return section;
  const out = { ...section };
  for (const field of KEYED_MAPS) if (out[field] && typeof out[field] === "object") out[field] = canonicalKeyOrder(out[field]);
  return out;
};

/**
 * holders-checkpoint.json `chains` with every per-address map written in canonical key order:
 * chains.<k>.rawBalances, chains.<k>.v3.{rawBalances,retired}, chains.<k>.v3Staking.<module>.rawBalances.
 * Field order of everything else is kept; no value changes. Does not mutate.
 */
export const canonicalCheckpointChains = (chains) => {
  const out = {};
  for (const [key, chain] of Object.entries(chains ?? {})) {
    if (!chain || typeof chain !== "object") {
      out[key] = chain;
      continue;
    }
    const next = canonicalSection(chain);
    if (next.v3) next.v3 = canonicalSection(next.v3);
    if (next.v3Staking && typeof next.v3Staking === "object") {
      next.v3Staking = Object.fromEntries(Object.entries(next.v3Staking).map(([module, section]) => [module, canonicalSection(section)]));
    }
    out[key] = next;
  }
  return out;
};
