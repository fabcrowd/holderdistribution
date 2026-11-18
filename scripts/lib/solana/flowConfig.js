/**
 * Config-driven inputs of the Solana flow scan, shared by scan-solana-flows.js
 * and generate-tier-outflows.js: the chains (chains[].vm "solana"), the
 * tracked venues (classification.cexWallets, contracts{} role dex/staking,
 * optional classification.dexContracts, the staking feed's vaults) and the
 * floor date (recorded in the scan checkpoint; first real holder snapshot day
 * on a first scan). Nothing is hardcoded per token.
 */
import fs from "node:fs";
import { projectChainEntries, projectClassificationPath, projectRoleAddresses } from "../projects.js";
import { solanaBaseToken } from "./adapter.js";

const readJson = (p) => {
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

/** Solana chains of a project with their scanned token: [{ chain, key, mint, decimals }]. */
export function solanaFlowChains(config) {
  return projectChainEntries(config)
    .filter((c) => c.vm === "solana")
    .map((chain) => {
      const token = solanaBaseToken(chain);
      const decimals = Number(token?.decimals);
      if (!token?.address || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        throw new Error(`solana chain ${chain.key}: config needs tokens[].address and integer decimals for the flow scan`);
      }
      return { chain, key: chain.key, mint: token.address, decimals };
    });
}

/** Venue lists for one chain, base58 case preserved. */
export function solanaFlowVenues(project, chainKey, { stakingFeedPath = null } = {}) {
  const wallets = readJson(projectClassificationPath(project, "cexWallets"))?.wallets ?? [];
  const cexWallets = wallets
    .filter((w) => typeof w.address === "string" && w.address.trim())
    .map((w) => ({ address: w.address.trim(), exchange: String(w.label ?? w.exchange ?? w.walletName ?? "CEX").trim() || "CEX" }));
  const roles = projectRoleAddresses(project.config, { roles: ["dex", "staking"] })[chainKey] ?? [];
  const dexOwners = new Set(roles.filter((r) => r.role === "dex").map((r) => r.address));
  for (const p of readJson(projectClassificationPath(project, "dexContracts"))?.pools ?? []) {
    if (typeof p.address === "string" && p.address.trim()) dexOwners.add(p.address.trim());
  }
  const staking = new Set(roles.filter((r) => r.role === "staking").map((r) => r.address));
  for (const l of readJson(stakingFeedPath)?.lockups ?? []) {
    for (const a of [l.stakeVault, l.stakeVaultAta]) if (typeof a === "string" && a) staking.add(a);
  }
  return { cexWallets, dexOwners: [...dexOwners], stakingAddresses: [...staking] };
}

const isDay = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * Default floor of a flow scan when no --since / env value is given: `{ since: YYYY-MM-DD | null, source }`.
 *   1. holders-history.json `firstLiveDate` (source "firstLiveDate"), the first live holder snapshot day
 *      (lib/firstLiveDate.js), never the earliest row: onboarding may backfill rows months before it. It wins
 *      over the checkpoint so a one-off --since stays one-off: the next default run returns to this day.
 *   2. While the history has no usable day (history written before the field existed, or no live row yet): the
 *      floor recorded in the scan's checkpoint (source "checkpoint"; recordedFlowFloor), so the floor does not
 *      move. A floor that came from step 3 stays once recorded.
 *   3. Otherwise the latest history row's day, today's snapshot day (source "latestRow"; the caller warns).
 * Never derived from git history: checkouts may be shallow and snapshots untracked.
 */
export function flowFloor({ checkpoint, chainKeys, historyPath }) {
  const history = readJson(historyPath);
  if (isDay(history?.firstLiveDate)) return { since: history.firstLiveDate, source: "firstLiveDate" };
  const recorded = recordedFlowFloor(checkpoint, chainKeys);
  if (recorded) return { since: recorded, source: "checkpoint" };
  const dates = (history?.entries ?? []).map((e) => e?.date).filter(isDay).sort();
  return dates.length ? { since: dates.at(-1), source: "latestRow" } : { since: null, source: null };
}

/**
 * Floor a default run may trust from one chain's checkpoint entry. `since` is the floor the stored days were built
 * from (the floor-changed checks compare it); after a --since / env override run it is the override, so the entry
 * also carries `sinceSource: "override"` and `defaultSince`, the floor a default run would have used then. An
 * entry without `sinceSource` (default run, or written before the markers existed) is trusted as is.
 */
export const trustedRecordedSince = (entry) => (entry?.sinceSource === "override" ? entry.defaultSince : entry?.since);

/** Earliest trusted recorded floor across the scanned chains of a flow checkpoint, or null. */
export function recordedFlowFloor(checkpoint, chainKeys) {
  return (chainKeys ?? []).map((k) => trustedRecordedSince(checkpoint?.chains?.[k])).filter(isDay).sort()[0] ?? null;
}

/**
 * Floor of one scan run: `{ since, source, markers }`. `markers` go on every checkpoint entry the run writes:
 * an override run records `sinceSource: "override"` and `defaultSince` (omitted when no default exists); a default
 * run records none, so a rebuilt entry drops the markers of an earlier override run.
 */
export function resolveFlowFloor({ override, checkpoint, chainKeys, historyPath }) {
  const floor = flowFloor({ checkpoint, chainKeys, historyPath });
  if (!override) return { ...floor, markers: {} };
  return { since: override, source: "override", markers: { sinceSource: "override", ...(isDay(floor.since) ? { defaultSince: floor.since } : {}) } };
}

/** Warning text when the floor fell back to the latest history row, else null. */
export function latestRowFloorWarning(slug, floor) {
  if (floor?.source !== "latestRow") return null;
  return `${slug}: holders-history.json has no firstLiveDate and the flow checkpoint records no floor; using the latest history row ${floor.since} as the floor (flow days before it are not scanned; pass --since to choose another).`;
}
