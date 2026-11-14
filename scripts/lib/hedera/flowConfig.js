/**
 * Config-driven inputs of the Hedera flow scan (scripts/scan-hedera-flows.js, scan-exchange-flows.js,
 * generate-tier-outflows.js): the chain (chains[].vm "hedera", native asset), the exchange accounts
 * (classification.cexWallets), the day-end boundaries and the feed stamp. Nothing is per token.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { emptyFlowStore, buildSolanaTierDays } from "../solana/flowFeeds.js";
import { FLOW_CLASSIFIER_VERSION } from "./flowClassify.js";
import { datesFromTo, ensureCutoffs, nextDate } from "../dayBlocks.js";
import { projectChainEntries, projectClassificationPath } from "../projects.js";
import { settledBlockFor } from "../asOf.js";
import { parseHederaAddress } from "./address.js";

/** Hedera chains of a project with their native decimals: [{ chain, key, decimals }]. */
export function hederaFlowChains(config) {
  return projectChainEntries(config)
    .filter((c) => c.vm === "hedera")
    .map((chain) => {
      const decimals = Number(chain.asset?.decimals);
      if (chain.asset?.kind !== "native" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        throw new Error(`hedera chain ${chain.key}: config needs asset { kind: "native", decimals } for the flow scan`);
      }
      return { chain, key: chain.key, decimals };
    });
}

/**
 * The project's exchange accounts in config order, ids canonical (0.0.N). An invalid address or one listed
 * under two exchanges stops the scan: a flow attributed to the wrong exchange is worse than no flow.
 */
export function hederaFlowAccounts(project) {
  const file = projectClassificationPath(project, "cexWallets");
  let wallets = [];
  if (file) {
    try {
      wallets = JSON.parse(fs.readFileSync(file, "utf8"))?.wallets ?? [];
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const byId = new Map();
  for (const w of wallets) {
    if (typeof w.address !== "string" || !w.address.trim()) continue;
    const id = parseHederaAddress(w.address.trim());
    if (!id) throw new Error(`${project.slug}: cexWallets address ${JSON.stringify(w.address)} is not a Hedera account id (0.0.N)`);
    const exchange = String(w.label ?? w.exchange ?? w.walletName ?? "CEX").trim() || "CEX";
    if (byId.has(id) && byId.get(id) !== exchange) throw new Error(`${project.slug}: ${id} is listed under ${byId.get(id)} and ${exchange}`);
    byId.set(id, exchange);
  }
  return [...byId].map(([id, exchange]) => ({ id, exchange }));
}

/**
 * Consensus end of each day from `firstDate` to `lastDate`: the last consensus time of block cutoff[D+1]-1.
 * Missing cutoffs are resolved with the chain's clock and saved to date-blocks.json; known ends are kept
 * (`known`: { date: { stamp, block } }). Returns { ends: { date: { stamp, block } } } for firstDate..lastDate
 * and `startStamp`, the end of the day before firstDate.
 */
export async function resolveDayEnds(project, { key, clock, firstDate, lastDate, known = {}, root, io }) {
  const before = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const days = datesFromTo(before(firstDate), lastDate);
  const cutoffs = await ensureCutoffs(project, datesFromTo(firstDate, nextDate(lastDate)), {
    resolvers: { [key]: (target) => clock.firstAtOrAfter(target) },
    root,
    io,
  });
  const ends = {};
  for (const date of days) {
    if (known[date]) {
      ends[date] = known[date];
      continue;
    }
    const block = settledBlockFor(cutoffs, key, date);
    if (block == null) throw new Error(`${key}: no cutoff for ${nextDate(date)}; cannot place the end of ${date}`);
    ends[date] = { stamp: (await clock.rangeOf(block)).to, block };
  }
  return { ends, startStamp: ends[before(firstDate)].stamp };
}

/**
 * Feed stamp of a Hedera flow feed from exchange-flow-checkpoint.json chains.<key>. Only a scan that reached
 * the settled end of its target day on every account claims that day; anything else claims none.
 */
export function hederaFlowAsOf(state, key, setHash = undefined) {
  const stale = setHash !== undefined && state?.setHash !== setHash; // scanned for another account set or classifier
  if (stale || state?.complete !== true || !state.throughDate || !Number.isInteger(state.throughBlock)) {
    return { date: null, blocks: {}, settled: false, incomplete: [key] };
  }
  return { date: state.throughDate, blocks: { [key]: state.throughBlock }, settled: true };
}

/**
 * Stamp of what a stored scan means: the classifier version and the sorted (account id, exchange) set.
 * Config order does not matter. Which exchange account owns a record, and what counts as internal, depend on
 * exactly this set, so a stored scan is only valid for the set it was made with.
 */
export function flowSetHash(accounts) {
  const pairs = accounts.map((a) => [a.id, a.exchange]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return createHash("sha256").update(JSON.stringify([FLOW_CLASSIFIER_VERSION, pairs])).digest("hex").slice(0, 16);
}

/**
 * Decides whether the stored scan of one chain can be resumed. Any change that makes the stored flows differ from
 * a fresh scan of the current inputs (missing day store, other floor, other account set or classifier, or a
 * checkpoint without a stamp) discards that chain's cursors and day rows so the scan rebuilds from `since`; the
 * rebuild resumes like any scan (cursors persist per page) and the checkpoint stays incomplete until done.
 * Other chains' keys in `store` and `checkpoint` are never touched.
 * @returns {{ prev: object|null, store: object, setHash: string, reason: string|null }} `prev` is the checkpoint to resume (null = start over)
 */
export function planFlowResume({ prev, store, since, accounts, key }) {
  const setHash = flowSetHash(accounts);
  let reason = null;
  if (prev && !store) reason = "its day store is missing";
  else if (prev && prev.since !== since) reason = `the floor changed (${prev.since} -> ${since})`;
  else if (prev && !prev.setHash) reason = "the checkpoint has no account-set stamp";
  else if (prev && prev.setHash !== setHash) reason = "the exchange account set or the classifier changed";
  const keep = prev && reason === null;
  const base = store ?? emptyFlowStore();
  const chains = { ...base.chains };
  if (!keep) delete chains[key];
  return { prev: keep ? prev : null, store: { ...base, chains }, setHash, reason };
}

/** Day-store counterparty bucket for flow whose counterparty is not a tiered holder. */
export const UNATTRIBUTED_TIER = "unattributed";

/**
 * Tier-outflow day buckets of a Hedera store. Like Solana's (buildSolanaTierDays) but nothing is dropped: a
 * counterparty with no tier (new account, under the holder floor, excluded, another exchange, an unpaired
 * remainder) and every day before the first holder snapshot land in the `unattributed` bucket, so for every day
 * the tier volumes plus `unattributed` equal that day's exchange in/out in exchange-flow-history.
 * `tierAt(date)` is a Map owner -> tier label.
 */
export function buildHederaTierDays(store, { decimals, tierAt }) {
  return buildSolanaTierDays(store, {
    decimals,
    firstSnapshotDate: "0000-01-01",
    tierAt: (date) => {
      const tiers = tierAt(date);
      return { get: (owner) => tiers.get(owner) ?? UNATTRIBUTED_TIER };
    },
  });
}
