/**
 * Config-driven inputs of the Solana flow scan, shared by scan-solana-flows.js
 * and generate-tier-outflows.js: the chains (chains[].vm "solana"), the
 * tracked venues (classification.cexWallets, contracts{} role dex/staking,
 * optional classification.dexContracts, the staking feed's vaults) and the
 * floor date (first real holder snapshot). Nothing is hardcoded per token.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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

/** Earliest commit date (YYYY-MM-DD) of the project's holder snapshot, or null. */
export function firstSnapshotDate(snapshotRelPath, git = (a) => execFileSync("git", a, { encoding: "utf8" })) {
  const out = git(["log", "--format=%ad", "--date=short", "--", snapshotRelPath]).trim();
  return out ? out.split("\n").sort()[0] : null;
}
