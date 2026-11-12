#!/usr/bin/env node
/**
 * build-cutoffs.js --project <slug> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Backfills the shared day-cutoff map (date-blocks.json "cutoffs",
 * scripts/lib/dayBlocks.js) for every chain of a project: EVM chains by block
 * timestamp, Solana chains (chains[].vm "solana") by produced-slot block time,
 * Hedera chains by mirror block number.
 * Dates already in the map are never re-searched. Defaults: --from 14 days
 * before today, --to today (cutoff[today] is the settled end of yesterday).
 * Example: node scripts/build-cutoffs.js --project tel --from 2026-08-29
 */
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  datesFromTo, ensureCutoffs, solanaBlockTimeOrNull, solanaSearchLow, utcDate,
} from "./lib/dayBlocks.js";
import { loadChainAdapter } from "./lib/chainAdapters.js";

/**
 * chains: [{ key, vm, head, low?, getTime(blockOrSlot) }]. Returns the full cutoff map.
 */
export async function buildCutoffs(project, { from, to, chains, root, io }) {
  const resolvers = Object.fromEntries(await Promise.all(chains.map(async (c) => {
    const first = (await loadChainAdapter(c.vm ?? "evm")).clock(c).firstAtOrAfter;
    return [c.key, (target) => first(target, c.getTime, c.low ?? 0, c.head)];
  })));
  return ensureCutoffs(project, datesFromTo(from, to), { resolvers, root, io });
}

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const { loadEnv } = await import("./loadEnv.js");
  await loadEnv();
  const { selectPipelineProject, projectChains } = await import("./lib/projects.js");
  const { getUsableRpcUrls, rpcCall } = await import("./lib/rpc.js");
  const { solanaFlowChains } = await import("./lib/solana/flowConfig.js");
  const project = selectPipelineProject("build-cutoffs", { ported: true });
  const to = argValue("--to") ?? utcDate();
  const from = argValue("--from") ?? utcDate(Date.parse(`${to}T00:00:00Z`) - 14 * 86_400_000);

  const chains = [];
  for (const [key, cfg] of Object.entries(projectChains(project))) {
    const urls = await getUsableRpcUrls(key);
    if (!urls.length) throw new Error(`${key}: no RPC URLs (is ENV_PASSPHRASE set?)`);
    const head = Number(BigInt(await rpcCall(urls[0], "eth_blockNumber", [])));
    const getTime = async (b) => parseInt((await rpcCall(urls[0], "eth_getBlockByNumber", [`0x${b.toString(16)}`, false])).timestamp, 16);
    chains.push({ key, vm: "evm", head, low: Number(cfg.fromBlock) || 0, getTime });
  }
  // Hedera: the mirror's consecutive block numbers, through the adapter's own clock (no key needed).
  for (const [key, cfg] of Object.entries(projectChains(project, process.cwd(), { vms: ["hedera"] }))) {
    const clock = (await loadChainAdapter("hedera")).clock({ key, ...cfg });
    chains.push({ key, vm: "hedera", head: (await clock.latest()).number, low: 0, getTime: clock.timeOf });
  }
  const sol = solanaFlowChains(project.config);
  if (sol.length) {
    const { configureSolanaChain, getUsableSolanaRpcUrls, keyedFirst, solanaCallWithFailover } = await import("./lib/solana/rpc.js");
    for (const c of sol) {
      configureSolanaChain(c.chain);
      const urls = keyedFirst(await getUsableSolanaRpcUrls(c.key), c.key);
      const call = (m, p) => solanaCallWithFailover(urls, m, p, { chainKey: c.key });
      const head = Number(await call("getSlot", [{ commitment: "finalized" }]));
      // Bounded floor (never probe pruned history): head minus the days back to --from, with margin.
      const daysBack = Math.ceil((Date.now() - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
      chains.push({ key: c.key, vm: "solana", head, low: solanaSearchLow(head, daysBack), getTime: solanaBlockTimeOrNull(call, head) });
    }
  }
  const map = await buildCutoffs(project, { from, to, chains });
  for (const c of chains) console.log(`  ${c.key}: ${Object.keys(map[c.key] ?? {}).length} cutoffs (${from}..${to} requested)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
