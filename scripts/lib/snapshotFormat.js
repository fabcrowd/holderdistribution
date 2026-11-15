/**
 * On-disk layout of tel-holders.json (and its rotated previous copy).
 *
 * A project with exactly ONE chain would list every holder twice (`wallets[]` and
 * `chains.<k>.holders[]`), pretty-printed, which pushes a large token past GitHub's
 * 100 MiB file limit. Those snapshots are written "slim": the second list is dropped,
 * only the addresses it left out are kept (`holdersOmitted`), `wallets[]` is written
 * one row per line and the file carries `layout: "slim-v1"`. Readers rebuild the list
 * with hydrateChainHolders. Anything with more or fewer than one chain (TEL) keeps the
 * legacy pretty-printed layout byte for byte.
 */

import { isDeepStrictEqual } from "node:util";
import { computeChainMetrics } from "./holderMetrics.js";
import { normalizeAddress } from "./nonRetailSet.js";

const MIB = 1024 * 1024;

export const SNAPSHOT_LAYOUT_SLIM = "slim-v1";
export const SNAPSHOT_WARN_BYTES = 50 * MIB;
export const SNAPSHOT_FAIL_BYTES = 95 * MIB;
const GITHUB_LIMIT_MIB = 100;

const WALLETS_SENTINEL = "__SNAPSHOT_WALLETS_SENTINEL__";

const chainKeysOf = (snapshot) => Object.keys(snapshot?.chains ?? {});

/** "slim-v1" for a snapshot with exactly one chain, otherwise "legacy". Structural, never by slug. */
export const snapshotLayout = (snapshot) => (chainKeysOf(snapshot).length === 1 ? SNAPSHOT_LAYOUT_SLIM : "legacy");

const positiveBalance = (wallet, key) => {
  const balance = wallet?.[`${key}_balance`];
  return Number.isFinite(balance) && balance > 0;
};

const toMiB = (bytes) => (bytes / MIB).toFixed(2);

/** Gate for a serialized snapshot: ok, warn from 50 MiB, fail from 95 MiB (GitHub rejects 100 MiB). */
export const checkSnapshotSize = (bytes, file) => {
  const size = `${toMiB(bytes)} MiB`;
  if (bytes >= SNAPSHOT_FAIL_BYTES) {
    return {
      level: "fail",
      message:
        `${file} is ${size}, at or above the ${toMiB(SNAPSHOT_FAIL_BYTES)} MiB safety limit; ` +
        `it cannot be pushed to GitHub (limit ${GITHUB_LIMIT_MIB} MiB). Size is fixed by layout, never by ` +
        `dropping rows: write the snapshot with the sharded layout (sharded-v1) or split it into more, smaller shards.`,
    };
  }
  if (bytes >= SNAPSHOT_WARN_BYTES) {
    return {
      level: "warn",
      message: `${file} is ${size}, above the ${toMiB(SNAPSHOT_WARN_BYTES)} MiB warning size (GitHub rejects files of ${GITHUB_LIMIT_MIB} MiB).`,
    };
  }
  return { level: "ok", message: `${file} is ${size}.` };
};

/** Chain entry with `holders` replaced by `holdersOmitted` (same key position). */
export const slimChain = (snapshot, key, chain) => {
  if (!Array.isArray(chain?.holders)) return chain;
  const inHolders = new Set(chain.holders.map((holder) => holder.address));
  const omitted = [];
  for (const wallet of snapshot.wallets ?? []) {
    if (positiveBalance(wallet, key) && !inHolders.has(wallet.address)) omitted.push(wallet.address);
  }
  const out = {};
  for (const [field, value] of Object.entries(chain)) {
    if (field === "holders") out.holdersOmitted = omitted;
    else out[field] = value;
  }
  return out;
};

/** Text to write for a snapshot: slim for one chain, otherwise `JSON.stringify(o, null, 2) + "\n"`. */
export const serializeSnapshot = (snapshot) => {
  if (snapshotLayout(snapshot) !== SNAPSHOT_LAYOUT_SLIM) return `${JSON.stringify(snapshot, null, 2)}\n`;

  const { layout: _layout, ...rest } = snapshot;
  const chains = {};
  for (const [key, chain] of Object.entries(rest.chains)) chains[key] = slimChain(snapshot, key, chain);
  const wallets = Array.isArray(rest.wallets) ? rest.wallets : null;
  const shell = { layout: SNAPSHOT_LAYOUT_SLIM, ...rest, chains };
  if (wallets) shell.wallets = WALLETS_SENTINEL;

  const text = JSON.stringify(shell, null, 2);
  if (!wallets) return `${text}\n`;

  const token = JSON.stringify(WALLETS_SENTINEL);
  const at = text.indexOf(token);
  const rows = wallets.length ? `[\n${wallets.map((row) => JSON.stringify(row)).join(",\n")}\n]` : "[]";
  return `${text.slice(0, at)}${rows}${text.slice(at + token.length)}\n`;
};

const rebuildHolders = (key, chain, wallets) => {
  const omitted = new Set(chain.holdersOmitted ?? []);
  const holders = [];
  for (const wallet of wallets) {
    if (!positiveBalance(wallet, key) || omitted.has(wallet.address)) continue;
    holders.push({ address: wallet.address, balance: wallet[`${key}_balance`] });
  }
  const expected = chain.metrics?.holderCount;
  if (expected !== undefined && expected !== null && holders.length !== expected) {
    throw new Error(
      `Snapshot chain "${key}": rebuilt ${holders.length} holders from wallets[] but metrics.holderCount is ${expected}; ` +
        `the snapshot is inconsistent (holdersOmitted does not match wallets[]).`,
    );
  }
  return holders;
};

/** Returns the snapshot with `chains.<k>.holders` present on every chain; array `holders` are kept as they are. Does not mutate. */
export const hydrateChainHolders = (snapshot) => {
  if (!snapshot?.chains) return snapshot;
  const chains = {};
  for (const [key, chain] of Object.entries(snapshot.chains)) {
    if (!chain || Array.isArray(chain.holders)) {
      chains[key] = chain;
      continue;
    }
    const { holdersOmitted: _omitted, ...rest } = chain;
    chains[key] = { ...rest, holders: rebuildHolders(key, chain, snapshot.wallets ?? []) };
  }
  return { ...snapshot, chains };
};

/**
 * serializeSnapshot plus the two guards the writer needs: a slim snapshot must hydrate back to
 * exactly the holders it was written from (else throw), and the byte size must pass checkSnapshotSize
 * ("fail" throws, "warn" logs). Throws before the caller has written anything.
 */
/** Key of the first chain whose `holders` array differs from the rebuilt (hydrated) snapshot, else null. */
export const findHoldersMismatch = (snapshot, rebuilt) => {
  for (const [key, chain] of Object.entries(snapshot.chains)) {
    if (!Array.isArray(chain?.holders)) continue;
    if (!isDeepStrictEqual(rebuilt.chains[key]?.holders, chain.holders)) return key;
  }
  return null;
};

const serializeRoundTripChecked = (snapshot, file) => {
  const text = serializeSnapshot(snapshot);
  if (snapshotLayout(snapshot) === SNAPSHOT_LAYOUT_SLIM) {
    const key = findHoldersMismatch(snapshot, hydrateChainHolders(JSON.parse(text)));
    if (key !== null) {
      throw new Error(`Slim snapshot ${file}: chain "${key}" holders do not survive the slim round trip; nothing written.`);
    }
  }
  return text;
};

export const serializeVerified = (snapshot, file, log = console) => {
  const text = serializeRoundTripChecked(snapshot, file);
  const size = checkSnapshotSize(Buffer.byteLength(text), file);
  if (size.level === "fail") throw new Error(size.message);
  if (size.level === "warn") log.warn(size.message);
  return text;
};

/**
 * Re-syncs per-chain holders[] against wallets[] and a non-retail set, then recomputes chain and combined
 * metrics. Pure: pass a hydrated snapshot (hydrateChainHolders) and write the result through serializeVerified.
 * Mega/excluded tallies from the scan are preserved. Returns { snapshot, added, removed }.
 */
export const resyncSnapshot = (snapshot, excluded, retailThreshold) => {
  let added = 0;
  let removed = 0;
  const chains = {};
  // A single-chain (slim) snapshot is ordered by wallets[] position, the order the scan writer produces
  // and hydrateChainHolders rebuilds; a balance sort would leave tied re-added wallets out of that order.
  const walletOrder = snapshotLayout(snapshot) === SNAPSHOT_LAYOUT_SLIM
    ? new Map((snapshot.wallets ?? []).map((wallet, index) => [wallet.address, index]))
    : null;
  const positionOf = (holder) => walletOrder.get(holder.address) ?? Number.MAX_SAFE_INTEGER;

  for (const [chainKey, chain] of Object.entries(snapshot.chains ?? {})) {
    const holders = chain.holders ?? [];
    const present = new Set(holders.map((h) => normalizeAddress(h?.address)).filter(Boolean));
    const field = `${chainKey}_balance`;

    // Drop any holder that is now excluded. Skip address-less entries (do not
    // treat "" as an exclusion match — that would drop every blank-address row).
    const kept = [];
    for (const h of holders) {
      const address = normalizeAddress(h?.address);
      if (!address) continue;
      if (excluded.has(address)) {
        removed += 1;
        continue;
      }
      kept.push(h);
    }

    // Add any non-excluded wallet with a positive balance on this chain.
    for (const wallet of snapshot.wallets ?? []) {
      const address = normalizeAddress(wallet?.address);
      if (!address || excluded.has(address) || present.has(address)) continue;
      const balance = Number(wallet?.[field]) || 0;
      if (balance <= 0) continue;
      kept.push({ address: wallet.address, balance });
      added += 1;
    }

    if (walletOrder) kept.sort((a, b) => positionOf(a) - positionOf(b));
    else kept.sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));

    const fromHolders = computeChainMetrics(kept, { retailThreshold });
    const next = { ...chain };
    next.holders = kept;
    next.metrics = next.metrics ? { ...next.metrics } : {};
    // Preserve mega/excluded tallies from the scan; recompute retail metrics.
    next.metrics.holderCount = fromHolders.holderCount;
    next.metrics.totalBalance = fromHolders.totalBalance;
    next.metrics.retail = fromHolders.retail;
    next.metrics.underThreshold = fromHolders.underThreshold;
    chains[chainKey] = next;
  }

  const combined = { ...(snapshot.combined ?? {}) };
  combined.holderCount = 0;
  combined.totalBalance = 0;
  combined.retail = { count: 0, balance: 0 };
  combined.underThreshold = { count: 0, balance: 0 };
  for (const chain of Object.values(chains)) {
    const m = chain.metrics ?? {};
    combined.holderCount += m.holderCount ?? 0;
    combined.totalBalance += m.totalBalance ?? 0;
    combined.retail.count += m.retail?.count ?? 0;
    combined.retail.balance += m.retail?.balance ?? 0;
    combined.underThreshold.count += m.underThreshold?.count ?? 0;
    combined.underThreshold.balance += m.underThreshold?.balance ?? 0;
  }

  return { snapshot: { ...snapshot, chains, combined }, added, removed };
};
