#!/usr/bin/env node
/**
 * extend-transfer-caches.js
 *
 * Brings each data/rebuild-transfers-<chain>.ndjson cache forward from its last
 * cached block to the current chain head, by APPENDING. Fetch-only: it writes
 * nothing under public/data/ and touches no servable artifact.
 *
 * WHY THIS EXISTS SEPARATELY FROM rebuild-history-from-logs.js
 *
 * That script's --resume is a fetch-SKIP flag, not a scope flag: it reads the
 * cache instead of refetching, but main() still rewrites
 * public/data/holders-history.json, date-blocks.json and the ever-checkpoint
 * unconditionally. There is no way to ask it for "just top up the caches", and
 * its writeTransfersCache() truncates and rewrites the whole file, so a naive
 * extend would refetch from genesis — 8.6M+ transfers and 1.2 GB on Polygon
 * alone. This appends only the new tail.
 *
 * WHY alchemy_getAssetTransfers, NOT eth_getLogs
 *
 * The Alchemy FREE tier caps eth_getLogs at a 10-BLOCK range per request
 * (scripts/lib/rpc.js's FREE_TIER_RANGE_PATTERN transparently re-issues a wider
 * request as 10-block sub-chunks, serially). Catching the flow scanners up that
 * way measured at ~320,000 requests. alchemy_getAssetTransfers has no
 * block-range cap and pages 1,000 transfers at a time, so the same tail costs
 * on the order of hundreds of requests. This is the same reasoning
 * rebuild-history-from-logs.js records, applied to the incremental case — and
 * the same lesson as lessons.md's "A Blocked Backfill Is Sometimes Blocked on
 * the Wrong Input".
 *
 * WHY THIS IS A BACKUP, NOT THE PRIMARY PATH
 *
 * The caches are gitignored (Polygon is 1.2 GB), so CI cannot use them. This is
 * the local fallback for when the scheduled workflows cannot run — see README's
 * "When the scheduled workflows are down". The daily automation remains the
 * primary path.
 *
 * Requires ENV_PASSPHRASE (decrypts .env.enc -> Alchemy RPC URLs).
 *
 * Run: node scripts/extend-transfer-caches.js [--chain=polygon] [--dry-run]
 */
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { getUsableRpcUrls, rpcCall } from "./lib/rpc.js";
import { fetchAllTransfers } from "./lib/alchemyTransfers.js";

await loadEnv();

const ROOT = process.cwd();

/** TEL token per chain, from config/chains.json — see scan-exchange-flows.js.
 *  Base previously hardcoded NFTEarthOFT, so the Base cache holds the wrong
 *  token's transfers and must be rebuilt. */
const CHAIN_CONFIG = JSON.parse(
  await fs.readFile(path.resolve(ROOT, "config/chains.json"), "utf8"),
);
const tokenFor = (chainKey) => {
  const token = CHAIN_CONFIG[chainKey]?.tokenAddress;
  if (typeof token !== "string" || !/^0x[0-9a-f]{40}$/i.test(token)) {
    throw new Error(`config/chains.json is missing a valid tokenAddress for ${chainKey}`);
  }
  return token.toLowerCase();
};

const CHAINS = {
  ethereum: { token: tokenFor("ethereum") },
  polygon: { token: tokenFor("polygon") },
  base: { token: tokenFor("base") },
};

const cachePath = (chainKey) => path.resolve(ROOT, `data/rebuild-transfers-${chainKey}.ndjson`);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const chainArg = args.find((a) => a.startsWith("--chain="))?.split("=")[1];

/**
 * Last blockNumber in an NDJSON cache, by streaming to the end.
 *
 * Deliberately reads every line rather than seeking the tail: shards are
 * fetched concurrently and merged, so the file is ordered by shard, and the
 * final line is only the last shard's last row. Taking a max over all rows is
 * the only correct answer, and at 1.2 GB it still costs seconds, not minutes.
 */
const lastCachedBlock = async (p) => {
  let max = 0;
  let rows = 0;
  const rl = createInterface({ input: createReadStream(p), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    rows += 1;
    try {
      const block = Number.parseInt(JSON.parse(line).blockNumber, 16);
      if (Number.isFinite(block) && block > max) max = block;
    } catch {
      // A truncated final line can only come from an interrupted append. Skip
      // it: the block it carried is re-fetched, since max stays behind it.
    }
  }
  return { lastBlock: max, rows };
};

const headBlock = async (rpcUrl) => Number.parseInt(await rpcCall(rpcUrl, "eth_blockNumber", []), 16);

const main = async () => {
  const chainKeys = chainArg ? [chainArg] : Object.keys(CHAINS);
  const summary = [];

  for (const chainKey of chainKeys) {
    const cfg = CHAINS[chainKey];
    if (!cfg) throw new Error(`Unknown chain: ${chainKey}`);

    const rpcUrls = await getUsableRpcUrls(chainKey);
    if (rpcUrls.length === 0) {
      console.log(`${chainKey}: no RPC URLs — skipping (is ENV_PASSPHRASE set?)`);
      continue;
    }

    const p = cachePath(chainKey);
    try {
      await fs.access(p);
    } catch {
      // Refuse to create a cache from scratch here: a partial file looks
      // identical to a complete one to every downstream reader, and the
      // genesis fetch belongs to rebuild-history-from-logs.js.
      console.log(`${chainKey}: no cache at ${p} — run rebuild-history-from-logs.js first. Skipping.`);
      continue;
    }

    const { lastBlock, rows } = await lastCachedBlock(p);
    const head = await headBlock(rpcUrls[0]);
    const from = lastBlock + 1;

    console.log(`${chainKey}: cache has ${rows.toLocaleString()} rows to block ${lastBlock.toLocaleString()}; head ${head.toLocaleString()} (+${(head - lastBlock).toLocaleString()})`);

    if (from > head) {
      console.log(`  already at head — nothing to do.`);
      summary.push({ chain: chainKey, appended: 0, lastBlock });
      continue;
    }
    if (dryRun) {
      console.log(`  --dry-run: would fetch ${from.toLocaleString()}..${head.toLocaleString()}`);
      continue;
    }

    let pages = 0;
    const transfers = await fetchAllTransfers(rpcUrls[0], {
      fromBlock: from,
      toBlock: head,
      contractAddress: cfg.token,
      onPage: async (count) => {
        pages += 1;
        if (pages % 10 === 0) console.log(`  page ${pages}: ${count.toLocaleString()} transfers so far`);
      },
    });

    console.log(`  fetched ${transfers.length.toLocaleString()} transfers over ${pages} page(s)`);

    if (transfers.length === 0) {
      summary.push({ chain: chainKey, appended: 0, lastBlock });
      continue;
    }

    // Serialize to a sibling temp file FIRST, then append it in one go.
    // Appending directly would risk leaving a half-written tail if
    // serialization threw partway (it did, on BigInt) — and a cache with a
    // truncated final row or a partially-written block silently poisons every
    // artifact derived from it. Staging means the real cache is only ever
    // touched by a single append of already-validated bytes.
    //
    // The BigInt replacer matches writeTransfersCache() in
    // rebuild-history-from-logs.js: normalizeTransfer returns `value` as a
    // BigInt and JSON.stringify cannot serialize one.
    const staging = `${p}.append`;
    await pipeline(
      (async function* () {
        for (const t of transfers) {
          yield `${JSON.stringify(t, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`;
        }
      })(),
      createWriteStream(staging),
    );
    await pipeline(createReadStream(staging), createWriteStream(p, { flags: "a" }));
    await fs.rm(staging, { force: true });

    const after = await lastCachedBlock(p);
    // The append must strictly advance the cache; if it did not, the fetch
    // returned rows at or below what was already there and something is wrong
    // with the range maths rather than with the chain.
    if (after.lastBlock <= lastBlock) {
      throw new Error(
        `${chainKey}: appended ${transfers.length} transfers but last block did not advance (${lastBlock} -> ${after.lastBlock})`,
      );
    }
    console.log(`  appended; cache now ${after.rows.toLocaleString()} rows to block ${after.lastBlock.toLocaleString()}`);
    summary.push({ chain: chainKey, appended: transfers.length, lastBlock: after.lastBlock });
  }

  console.log(`\nSummary: ${JSON.stringify(summary)}`);
};

await main();
