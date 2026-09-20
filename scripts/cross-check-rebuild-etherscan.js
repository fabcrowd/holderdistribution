#!/usr/bin/env node
/**
 * cross-check-rebuild-etherscan.js
 *
 * Independently verifies a SAMPLE of the rebuild's per-address balances
 * against Etherscan v2, without ever merging the two sources — see
 * rebuild-history-from-logs.js's module header for why (two providers can
 * each be internally correct and still disagree at the margins; comparing
 * catches that, merging would hide it).
 *
 * WHY A SAMPLE, AND WHY NOT FROM holders-history.json
 *
 * holders-history.json stores only aggregates per date (holderCount,
 * totalBalance, distribution, concentration sums) — no individual addresses,
 * by design (see that script's MEMORY section: a full per-date snapshot is
 * never retained). So this cross-checks against `data/rebuild-transfers-
 * <chain>.json`, the cached raw Alchemy transfers the rebuild already wrote —
 * replaying THAT locally (via the same balanceAtBlock used on the Etherscan
 * side) reproduces exactly what the rebuild's ledger computed, without
 * needing another Alchemy fetch.
 *
 * Sample addresses come from the live public/data/tel-holders.json snapshot
 * (real, currently-large wallets) rather than anything invented — checking
 * real wallets that actually matter to the holder-count/total-balance figures
 * is more informative than checking arbitrary ones.
 *
 * Run: node scripts/cross-check-rebuild-etherscan.js [--chain=polygon]
 *        [--sample=15] [--dates=2026-01-18,2026-04-01,2026-08-01]
 * Requires ENV_PASSPHRASE (Etherscan keys) — writes nothing, exits non-zero
 * on any mismatch so it can gate a workflow.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { balanceAtBlock, createEtherscanKeyPool, fetchAddressTransfers, keysFromEnv } from "./lib/etherscanMultiKey.js";

await loadEnv();

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const onlyChain = flag("chain", "polygon");
const sampleSize = Number(flag("sample", "15"));
const explicitDates = flag("dates");

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

/** BigInt survives a JSON round-trip as a string in these cache files — see
 *  rebuild-history-from-logs.js's cache-write comment. */
const reviveTransfers = (transfers) => transfers.map((t) => ({ ...t, value: BigInt(t.value) }));

const main = async () => {
  const keys = keysFromEnv();
  if (!keys.length) throw new Error("No ETHERSCAN_API_KEY[_N] found — cannot cross-check.");
  const pool = createEtherscanKeyPool(keys);
  console.log(`Etherscan key pool: ${pool.size} key(s).`);

  const chainConfig = await readJson(path.resolve(ROOT, "config/chains.json"));
  const meta = chainConfig[onlyChain];
  if (!meta) throw new Error(`Unknown chain "${onlyChain}"`);

  const transfersPath = path.resolve(ROOT, `data/rebuild-transfers-${onlyChain}.json`);
  const alchemyTransfers = reviveTransfers(await readJson(transfersPath));
  console.log(`Loaded ${alchemyTransfers.length} cached ${onlyChain} transfers from ${transfersPath}.`);

  const dateBlocks = await readJson(path.resolve(ROOT, "public/data/date-blocks.json"));
  const chainDateBlocks = dateBlocks[onlyChain] ?? {};
  const dates = explicitDates
    ? explicitDates.split(",")
    : Object.keys(chainDateBlocks).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 5)) === 0).slice(0, 5);
  console.log(`Sampling dates: ${dates.join(", ")}`);

  const snapshot = await readJson(path.resolve(ROOT, "public/data/tel-holders.json"));
  const balanceField = `${onlyChain}_balance`;
  const sampleAddresses = [...snapshot.wallets]
    .filter((w) => Number(w[balanceField]) > 0)
    .sort((a, b) => Number(b[balanceField]) - Number(a[balanceField]))
    .slice(0, sampleSize)
    .map((w) => w.address.toLowerCase());
  console.log(`Sampling ${sampleAddresses.length} addresses (largest current ${onlyChain} holders).`);

  let checked = 0;
  let matched = 0;
  const mismatches = [];

  for (const address of sampleAddresses) {
    const etherscanTransfers = await fetchAddressTransfers(pool, {
      chainId: meta.chainId,
      address,
      contractAddress: meta.tokenAddress,
    });

    for (const date of dates) {
      const block = chainDateBlocks[date];
      if (block == null) continue;
      checked += 1;

      const ours = balanceAtBlock(alchemyTransfers, address, block);
      const theirs = balanceAtBlock(etherscanTransfers, address, block);

      if (ours === theirs) {
        matched += 1;
      } else {
        mismatches.push({ address, date, block, alchemy: ours.toString(), etherscan: theirs.toString() });
        console.log(`  MISMATCH ${address} @ ${date} (block ${block}): alchemy=${ours} etherscan=${theirs}`);
      }
    }
  }

  console.log(`\n${matched}/${checked} address-date checks matched exactly.`);
  if (mismatches.length) {
    console.log(`${mismatches.length} mismatch(es):`);
    console.log(JSON.stringify(mismatches, null, 2));
    process.exit(1);
  }
  console.log("All sampled balances agree between Alchemy and Etherscan.");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
