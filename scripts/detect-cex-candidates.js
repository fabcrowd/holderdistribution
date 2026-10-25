#!/usr/bin/env node
/**
 * detect-cex-candidates.js
 *
 * Dune (sync-cex-wallets-dune.js) only knows about exchange wallets someone
 * else has already labelled — a newly-rotated hot wallet can sit misclassified
 * as retail for weeks until a label catches up. This scans TEL's own transfer
 * graph directly for the same custodial fan-in/fan-out signature that already
 * distinguished the seven KuCoin vaults from a real OTC holder (see
 * lessons.md "Address-Level Evidence Beats Funder-Only Reasoning" and
 * data/vault-unattributed-evidence.md).
 *
 * This is advisory only — it never writes config/cex-wallets.json. It writes
 * data/cex-candidates.json, a review queue for a human (or a follow-up
 * session, explorer-tag-checked) to promote confirmed entries from.
 *
 * Required env: ENV_PASSPHRASE (decrypts .env.enc -> Alchemy RPC URLs, same
 * as pull-holders-rpc.js).
 *
 * Optional env:
 *   CEX_CANDIDATE_MIN_BALANCE   floor TEL balance to consider (default 100000)
 *   CEX_CANDIDATE_MAX_SCAN      cap on how many candidates to RPC-scan per run,
 *                               largest balances first (default 300)
 *   CEX_CANDIDATE_LOOKBACK_BLOCKS_ETHEREUM / _POLYGON / _BASE
 *                               how far back to scan per chain (defaults below)
 *   CEX_CANDIDATE_FAN_THRESHOLD distinct counterparties required on BOTH the
 *                               deposit and withdrawal side to flag (default 50)
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { getUsableRpcUrls, getLogs, rpcCall } from "./lib/rpc.js";
import { loadNonRetailSet, normalizeAddress } from "./lib/nonRetailSet.js";
import { selectPipelineProject, projectPaths, projectChains, projectNonRetailPaths, projectWork } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: the project's
// snapshot, chain map and non-retail lists; the review queue goes to its work
// dir (TEL: data/cex-candidates.json, others: data/<slug>/cex-candidates.json).
const project = selectPipelineProject("detect-cex-candidates", { ported: true });

await loadEnv();

const HOLDERS_PATH = projectPaths(project)("tel-holders.json");
const OUTPUT_PATH = projectWork(project)("cex-candidates.json");

// Standard ERC-20 Transfer(address,address,uint256) topic0 — same constant
// for every ERC-20 token, TEL included. Not worth a keccak256 dependency for
// a value that never changes.
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const MIN_BALANCE = Number(process.env.CEX_CANDIDATE_MIN_BALANCE ?? 100_000);
const MAX_SCAN = Number(process.env.CEX_CANDIDATE_MAX_SCAN ?? 300);
const FAN_THRESHOLD = Number(process.env.CEX_CANDIDATE_FAN_THRESHOLD ?? 50);

// Alchemy PAYG: Polygon max 2000 blocks per eth_getLogs; ETH/Base unlimited,
// chunked here mainly to keep individual calls fast, not because of a hard cap.
const CHAIN_RPC_SETTINGS = {
  ethereum: { chunkSize: 10_000, defaultLookback: 200_000 }, // ~12s blocks, ~28 days
  polygon: { chunkSize: 2_000, defaultLookback: 300_000 }, // ~2s blocks, ~7 days
  base: { chunkSize: 10_000, defaultLookback: 300_000 }, // ~2s blocks, ~7 days
};
// Any other chain a project maps: the most conservative (Polygon-sized) settings.
const DEFAULT_RPC_SETTINGS = { chunkSize: 2_000, defaultLookback: 300_000 };
const rpcSettingsFor = (chainKey) => CHAIN_RPC_SETTINGS[chainKey] ?? DEFAULT_RPC_SETTINGS;

const lookbackFor = (chainKey) => {
  const envKey = `CEX_CANDIDATE_LOOKBACK_BLOCKS_${chainKey.toUpperCase()}`;
  const override = Number(process.env[envKey]);
  if (Number.isFinite(override) && override > 0) return override;
  return rpcSettingsFor(chainKey).defaultLookback;
};

const readJson = async (absolutePath) => JSON.parse(await fs.readFile(absolutePath, "utf8"));

const hex = (n) => "0x" + n.toString(16);

const parseTransferLog = (log, divisor = 100) => {
  const topics = log.topics ?? [];
  const data = (log.data ?? "").replace("0x", "");
  if (topics.length < 3 || data.length < 64) return null;
  const from = "0x" + (topics[1] ?? "").slice(-40).toLowerCase();
  const to = "0x" + (topics[2] ?? "").slice(-40).toLowerCase();
  const value = Number(BigInt("0x" + data.slice(0, 64))) / divisor; // 10 ** decimals (TEL: 2 -> 100)
  return { from, to, value };
};

/**
 * Fetches TEL Transfer logs where `address` is either side, over the last
 * `lookbackBlocks` blocks, chunked to respect provider block-range limits.
 * Deposit (in) and withdrawal (out) logs are fetched separately per chunk so
 * each eth_getLogs call stays address-filtered (topics[1] or topics[2]),
 * never a full-token scan.
 */
const fetchAddressTransfers = async (rpcUrls, tokenAddress, address, latestBlock, chunkSize, lookbackBlocks) => {
  const fromBlock = Math.max(0, latestBlock - lookbackBlocks);
  const padded = `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const topicsIn = [TRANSFER_TOPIC0, null, padded];
  const topicsOut = [TRANSFER_TOPIC0, padded, null];

  const chunks = [];
  for (let from = fromBlock; from <= latestBlock; from += chunkSize) {
    chunks.push({ from, to: Math.min(from + chunkSize - 1, latestBlock) });
  }

  const concurrency = Math.max(1, rpcUrls.length);
  const logs = [];
  for (let i = 0; i < chunks.length; i += concurrency) {
    const slice = chunks.slice(i, i + concurrency);
    const results = await Promise.all(
      slice.map(({ from, to }, idx) => {
        const rpcUrl = rpcUrls[idx % concurrency];
        const range = { fromBlock: hex(from), toBlock: hex(to), address: tokenAddress.toLowerCase() };
        return Promise.all([
          getLogs(rpcUrl, { ...range, topics: topicsIn }),
          getLogs(rpcUrl, { ...range, topics: topicsOut }),
        ]);
      }),
    );
    for (const [inLogs, outLogs] of results) {
      logs.push(...inLogs, ...outLogs);
    }
  }
  return logs;
};

/** Distinct counterparty count per direction, mirroring identify-other-addresses.js. */
const counterpartyStats = (logs, self) => {
  const s = self.toLowerCase();
  const inSet = new Set();
  const outSet = new Set();
  for (const raw of logs) {
    const parsed = parseTransferLog(raw);
    if (!parsed) continue;
    if (parsed.to === s && parsed.from !== s) inSet.add(parsed.from);
    if (parsed.from === s && parsed.to !== s) outSet.add(parsed.to);
  }
  return { depositors: inSet.size, withdrawalRecipients: outSet.size };
};

const main = async () => {
  const [snapshot, chains, { set: nonRetailSet }] = await Promise.all([
    readJson(HOLDERS_PATH),
    projectChains(project),
    loadNonRetailSet(projectNonRetailPaths(project)),
  ]);

  const candidates = (snapshot.wallets ?? [])
    .map((w) => ({ address: normalizeAddress(w.address), balance: Number(w.total_telcoin_balance ?? 0), raw: w }))
    .filter((w) => w.address && w.balance >= MIN_BALANCE && !nonRetailSet.has(w.address))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, MAX_SCAN);

  console.log(`${candidates.length} candidate wallet(s) above ${MIN_BALANCE.toLocaleString()} TEL, not already classified.`);
  if (candidates.length === 0) {
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), thresholds: { minBalance: MIN_BALANCE, fanThreshold: FAN_THRESHOLD }, candidates: [] }, null, 2)}\n`, "utf8");
    return;
  }

  const flagged = [];
  for (const chainKey of Object.keys(chains)) {
    const rpcUrls = await getUsableRpcUrls(chainKey);
    if (rpcUrls.length === 0) {
      console.warn(`No RPC URLs for ${chainKey}; skipping.`);
      continue;
    }
    const tokenAddress = chains[chainKey].tokenAddress;
    const chainBalanceKey = `${chainKey}_balance`;
    const onChain = candidates.filter((c) => Number(c.raw[chainBalanceKey] ?? 0) > 0);
    if (onChain.length === 0) continue;

    console.log(`Scanning ${onChain.length} candidate(s) on ${chainKey}...`);
    const { chunkSize } = rpcSettingsFor(chainKey);
    const lookback = lookbackFor(chainKey);
    const latestHex = await rpcCall(rpcUrls[0], "eth_blockNumber", []);
    const latestBlock = Number.parseInt(String(latestHex), 16);

    for (const candidate of onChain) {
      const logs = await fetchAddressTransfers(rpcUrls, tokenAddress, candidate.address, latestBlock, chunkSize, lookback);
      const stats = counterpartyStats(logs, candidate.address);
      if (stats.depositors >= FAN_THRESHOLD && stats.withdrawalRecipients >= FAN_THRESHOLD) {
        flagged.push({
          address: candidate.address,
          chain: chainKey,
          balance: candidate.balance,
          depositors: stats.depositors,
          withdrawalRecipients: stats.withdrawalRecipients,
          lookbackBlocks: lookback,
        });
        console.log(`  CANDIDATE: ${candidate.address} on ${chainKey} — ${stats.depositors} depositors, ${stats.withdrawalRecipients} withdrawal recipients`);
      }
    }
  }

  // One entry per address across chains, keeping the strongest signal.
  const byAddress = new Map();
  for (const f of flagged) {
    const existing = byAddress.get(f.address);
    if (!existing || (f.depositors + f.withdrawalRecipients) > (existing.depositors + existing.withdrawalRecipients)) {
      byAddress.set(f.address, f);
    }
  }
  const results = [...byAddress.values()].sort((a, b) => b.balance - a.balance);

  console.log(`\n${results.length} candidate(s) flagged for manual review (never auto-added to config/cex-wallets.json).`);

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(
    OUTPUT_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        thresholds: { minBalance: MIN_BALANCE, fanThreshold: FAN_THRESHOLD, maxScan: MAX_SCAN },
        candidates: results,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`Wrote ${OUTPUT_PATH}`);
};

main().catch((error) => {
  console.error("Failed to detect CEX candidates:", error);
  process.exit(1);
});
