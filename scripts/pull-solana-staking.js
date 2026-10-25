#!/usr/bin/env node
/**
 * pull-solana-staking.js --project <slug>   (or HD_PROJECT)
 * For a staking[] entry of kind "zebecStakeV1", writes
 * public/data/<slug>/solana-staking.json. Exits 0 without writing (and without
 * importing any Solana module) when the project has no such entry, e.g. TEL.
 */
import fs from "node:fs/promises";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { selectPipelineProject, projectPaths, projectStakingContracts } from "./lib/projects.js";

await loadEnv();
const project = selectPipelineProject("pull-solana-staking", { ported: true });
const data = projectPaths(project);
const entries = projectStakingContracts(project, { kind: "zebecStakeV1" });
if (entries.length === 0) {
  console.log("No Solana program staking configured; nothing to do.");
  process.exit(0);
}
if (entries.length > 1) throw new Error(`${project.slug}: more than one zebecStakeV1 entry is not supported`);
const entry = entries[0];
const chain = (project.config.chains ?? []).find((c) => c.key === entry.chain);
if (!chain) throw new Error(`${project.slug}: staking chain ${entry.chain} not in chains[]`);

const { configureSolanaChain, getUsableSolanaRpcUrls, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
const { solanaBaseToken } = await import("./lib/solana/adapter.js");
const { fetchZebecStakePositions } = await import("./lib/solana/zebecStake.js");

configureSolanaChain(chain);
const urls = await getUsableSolanaRpcUrls(chain.key);
const call = (method, params) => solanaCallWithFailover(urls, method, params, { chainKey: chain.key });
const token = solanaBaseToken(chain);
const slot = await call("getSlot", [{ commitment: "finalized" }]);
const result = await fetchZebecStakePositions(call, { programId: entry.address, mint: token.address, decimals: token.decimals });

const out = {
  generatedAt: new Date().toISOString(),
  chain: chain.key,
  kind: entry.kind,
  name: entry.name ?? "Solana staking",
  slot: typeof slot === "number" ? slot : null,
  ...result,
};
await fs.writeFile(data("solana-staking.json"), JSON.stringify(out, null, 2) + "\n");
console.log(
  `${project.slug}: ${result.stakerCount} stakers, ${result.positionCount} positions, ` +
    `${Math.round(result.stakedTotal).toLocaleString()} ${project.config.ticker} staked across ${result.lockups.length} lockups.`,
);
