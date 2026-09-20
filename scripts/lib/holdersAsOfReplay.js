// Reconstruct per-chain TEL balances as of a past date, without re-scanning RPC.
//
// A checkpoint committed on some anchor date holds exact raw per-address
// balances at an exact block per chain. Replaying the cached Transfer logs
// (data/rebuild-transfers-<chain>.ndjson) from that block up to the target
// date's block yields the exact balance sheet for that date — verified by
// reproducing four later committed checkpoints from the 2026-08-21 anchor.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fetchAllTransfers } from "./alchemyTransfers.js";

/** Latest commit of `file` on or before `date`, parsed as JSON. */
export function readCommittedJson(file, date) {
  const sha = execFileSync(
    "git",
    ["log", "--format=%H", "-1", `--until=${date} 23:59:59`, "--", file],
    { encoding: "utf8", maxBuffer: 1 << 20 },
  ).trim();
  if (!sha) throw new Error(`No commit of ${file} at or before ${date}`);
  return JSON.parse(
    execFileSync("git", ["show", `${sha}:${file}`], { encoding: "utf8", maxBuffer: 1 << 30 }),
  );
}

/**
 * @returns {Promise<Map<string, bigint>>} address -> raw balance at `toBlock`
 */
export async function replayChainRawBalances({ anchorChain, transfersPath, toBlock }) {
  const raw = new Map(
    Object.entries(anchorChain.rawBalances).map(([addr, v]) => [addr.toLowerCase(), BigInt(v)]),
  );
  // Streamed line by line: the Polygon cache is >1GB, past the max string length.
  const rows = [];
  const rl = createInterface({ input: createReadStream(transfersPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    const block = parseInt(r.blockNumber, 16);
    // The anchor already reflects everything at or before its own block.
    if (block <= anchorChain.lastBlock || block > toBlock) continue;
    rows.push({ block, from: r.from, to: r.to, value: BigInt(r.value) });
  }
  rows.sort((a, b) => a.block - b.block);
  for (const l of rows) {
    if (l.to) raw.set(l.to, (raw.get(l.to) ?? 0n) + l.value);
    if (l.from) raw.set(l.from, (raw.get(l.from) ?? 0n) - l.value);
  }
  return raw;
}

/**
 * Transfers for (fromBlock, toBlock], from the big local cache when it exists
 * and otherwise fetched fresh into a small window cache.
 *
 * The rebuild-transfers-<chain>.ndjson caches are gitignored (Polygon is
 * 1.2 GB), so CI has never been able to use them — which is what kept
 * `--as-of` a local-only tool. A gap is a handful of days, and
 * alchemy_getAssetTransfers has no block-range cap, so fetching just that
 * window costs on the order of hundreds of requests rather than the millions a
 * genesis replay would. The window is cached under the same data/ directory so
 * filling several dates in one run fetches each block range once.
 */
/**
 * Whether `cachePath` exists and its highest block is at least `toBlock`.
 * extend-transfer-caches.js only ever appends later blocks, so the last line
 * carries the high-water mark and a tail read settles it without walking a
 * multi-GB file.
 */
async function cacheReaches(cachePath, toBlock) {
  let handle;
  try {
    handle = await fs.open(cachePath, "r");
  } catch {
    return false;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const length = Math.min(64 * 1024, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const block = parseInt(JSON.parse(lines[i]).blockNumber, 16);
        if (Number.isFinite(block)) return block >= toBlock;
      } catch {
        // Partial first line of the tail window — try the next one up.
      }
    }
    return false;
  } finally {
    await handle.close();
  }
}

export async function ensureWindowCache({ chainKey, fromBlock, toBlock, contractAddress, rpcUrl, root = process.cwd() }) {
  const fullCache = path.resolve(root, `data/rebuild-transfers-${chainKey}.ndjson`);
  // Present is not the same as sufficient. The cache is only usable if it
  // actually reaches toBlock: a cache that stops short contains no transfers
  // for the tail of the window, so the replay would return a balance sheet
  // that is simply missing those days — with no error anywhere, which is the
  // worst possible failure for a historical row. Checked, not assumed.
  if (await cacheReaches(fullCache, toBlock)) return fullCache;
  const windowCache = path.resolve(root, `data/asof-window-${chainKey}-${fromBlock}-${toBlock}.ndjson`);
  try {
    await fs.access(windowCache);
    return windowCache;
  } catch {
    // Not fetched yet.
  }
  if (!rpcUrl) throw new Error(`No RPC URL for ${chainKey} — cannot fetch the ${fromBlock}..${toBlock} window`);
  // Validated here rather than trusted from the caller: a missing/misnamed
  // config field used to reach Alchemy as contractAddresses:[null] and came
  // back as an opaque "expected Ethereum address format" error from the API,
  // pointing at the request instead of at the config that built it.
  if (typeof contractAddress !== "string" || !/^0x[0-9a-f]{40}$/i.test(contractAddress)) {
    throw new Error(
      `Invalid token address for ${chainKey}: ${JSON.stringify(contractAddress)} — ` +
        `expected config/chains.json's tokenAddress`,
    );
  }
  const transfers = await fetchAllTransfers(rpcUrl, {
    fromBlock: fromBlock + 1,
    toBlock,
    contractAddress,
  });
  const lines = transfers.map((t) =>
    `${JSON.stringify({ from: t.from, to: t.to, value: t.value.toString(), blockNumber: t.blockNumber, transactionHash: t.transactionHash })}\n`,
  );
  await fs.mkdir(path.dirname(windowCache), { recursive: true });
  await fs.writeFile(windowCache, lines.join(""), "utf8");
  return windowCache;
}
