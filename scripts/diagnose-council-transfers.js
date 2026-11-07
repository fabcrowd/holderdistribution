#!/usr/bin/env node
/**
 * One-off diagnostic for a TEL council-category mismatch (supply-reconciliation
 * vs treasury-history disagreed by 100M TEL on 2026-11-07). Read-only: it reads
 * Transfer logs and balances over the RPC keys in .env.enc and, for every chain
 * in config/chains.json that has a TEL legacy and v3 token (ethereum, polygon,
 * base), prints:
 *   - every transfer of at least MIN_TEL between a council wallet and anyone,
 *     for the legacy and v3 tokens, over roughly the last WINDOW_DAYS days;
 *   - each council wallet's balance at head and ~WINDOW_DAYS days back, plus
 *     (Ethereum only) at SCAN_BLOCK, the block the failed snapshot scanned to;
 *   - each wallet's config label and the chain(s) where it holds a balance;
 *   - the council total across chains at head. Exits 1 if it is below
 *     MIN_COUNCIL_TOTAL_TEL (the pipeline reports ~461-561M).
 * Never prints an RPC URL or key. Run with ENV_PASSPHRASE; no data is written.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDecryptedEnv } from "./decrypt-env.js";
import { rpcEnvKeys } from "./lib/rpc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Optional Ethereum-only override of the scan start (other chains use the window). */
const ETH_FROM_BLOCK = process.env.DIAG_FROM_BLOCK ? Number(process.env.DIAG_FROM_BLOCK) : null;
const SCAN_BLOCK = Number(process.env.DIAG_SCAN_BLOCK ?? 26_363_394);
const MIN_TEL = 1_000_000;
const MIN_COUNCIL_TOTAL_TEL = 300_000_000;
const WINDOW_DAYS = 3;
const CHAIN_KEYS = ["ethereum", "polygon", "base"];
/** Average seconds per block, used only to size the ~WINDOW_DAYS lookback. */
const BLOCK_SECONDS = { ethereum: 12, polygon: 2.1, base: 2 };
const CHUNK = { ethereum: 5_000, polygon: 2_000, base: 2_000 };
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BALANCE_OF = "0x70a08231";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexToNum = (h) => parseInt(h, 16);
const toHex = (n) => `0x${n.toString(16)}`;
const padAddr = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const addrOf = (topic) => `0x${topic.slice(-40)}`;
const fmtTel = (raw, decimals) => Number(BigInt(raw)) / 10 ** decimals;
const num = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** A chain's endpoints from .env.enc (<PREFIX>_RPC_0..), never printed. */
const chainUrls = (env, chainKey) =>
  rpcEnvKeys(chainKey)
    .map((k) => env[k])
    .filter((u) => typeof u === "string" && u.startsWith("http"))
    .map((u) => u.trim());

async function rpc(urls, method, params) {
  let lastError = null;
  for (let attempt = 0; attempt < 4 * urls.length; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 200));
      return json.result;
    } catch (err) {
      lastError = err;
      await sleep(400 * (attempt + 1));
    }
  }
  // Message is built from the RPC error only; fetch errors never embed the URL here.
  throw new Error(`${method} failed on every endpoint: ${lastError?.message ?? "unknown"}`);
}

async function councilWallets() {
  const ex = JSON.parse(await fs.readFile(path.join(ROOT, "config/exclusions.json"), "utf8"));
  const found = new Map();
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object" && value.category === "council" && /^0x[0-9a-fA-F]{40}$/.test(key)) {
        found.set(key.toLowerCase(), value.name ?? value.label ?? "(unlabelled)");
      }
      walk(value);
    }
  })(ex);
  return found;
}

async function chainConfigs() {
  const chains = JSON.parse(await fs.readFile(path.join(ROOT, "config/chains.json"), "utf8"));
  return CHAIN_KEYS.map((key) => {
    const c = chains[key];
    const { legacy, v3 } = c?.tokens ?? {};
    if (!legacy || !v3) throw new Error(`config/chains.json: ${key} lacks tokens.legacy/tokens.v3`);
    return {
      key,
      fromBlock: c.fromBlock,
      tokens: {
        legacy: { address: legacy.address.toLowerCase(), decimals: legacy.decimals },
        v3: { address: v3.address.toLowerCase(), decimals: v3.decimals },
      },
    };
  });
}

async function scanTransfers(urls, chain, council, from, head) {
  const hits = [];
  for (const [name, { address, decimals }] of Object.entries(chain.tokens)) {
    const minRaw = BigInt(MIN_TEL) * 10n ** BigInt(decimals);
    for (const side of [1, 2]) {
      const topics = [TRANSFER_TOPIC, null, null];
      topics[side] = council.map(padAddr);
      for (let start = from; start <= head; start += CHUNK[chain.key]) {
        const to = Math.min(start + CHUNK[chain.key] - 1, head);
        const logs = await rpc(urls, "eth_getLogs", [{ address, fromBlock: toHex(start), toBlock: toHex(to), topics }]);
        for (const log of logs) {
          const value = BigInt(log.data);
          if (value < minRaw) continue;
          hits.push({
            token: name,
            block: hexToNum(log.blockNumber),
            tx: log.transactionHash,
            from: addrOf(log.topics[1]),
            to: addrOf(log.topics[2]),
            amount: fmtTel(value.toString(), decimals),
          });
        }
      }
    }
  }
  const unique = new Map(hits.map((h) => [`${h.tx}|${h.token}|${h.from}|${h.to}|${h.amount}`, h]));
  return [...unique.values()].sort((a, b) => a.block - b.block);
}

async function balancesAt(urls, chain, council, block) {
  const tag = toHex(block);
  const rows = [];
  for (const wallet of council) {
    const parts = {};
    let total = 0;
    for (const [name, { address, decimals }] of Object.entries(chain.tokens)) {
      const raw = await rpc(urls, "eth_call", [{ to: address, data: BALANCE_OF + padAddr(wallet).slice(2) }, tag]);
      parts[name] = fmtTel(raw, decimals);
      total += parts[name];
    }
    rows.push({ wallet, total, parts });
  }
  return rows;
}

function printBalances(chain, label, block, rows) {
  const sum = rows.reduce((s, r) => s + r.total, 0);
  console.log(`\n[${chain.key}] council balances at ${label} (block ${block}), total ${num(sum)} TEL`);
  for (const r of [...rows].sort((a, b) => b.total - a.total)) {
    console.log(`  ${r.wallet} ${num(r.total).padStart(18)}  legacy ${r.parts.legacy.toLocaleString("en-US")}  v3 ${r.parts.v3.toLocaleString("en-US")}`);
  }
  return sum;
}

async function main() {
  const env = await getDecryptedEnv();
  if (!env) throw new Error("ENV_PASSPHRASE is not set or does not decrypt .env.enc");

  const councilMap = await councilWallets();
  const council = [...councilMap.keys()];
  const chains = await chainConfigs();
  console.log(`council wallets: ${council.length}; chains: ${chains.map((c) => c.key).join(", ")}; window ~${WINDOW_DAYS} days`);

  const headTotals = new Map(); // wallet -> { chainKey: TEL }
  let grandTotal = 0;

  for (const chain of chains) {
    const urls = chainUrls(env, chain.key);
    if (urls.length === 0) throw new Error(`no ${rpcEnvKeys(chain.key)[0].replace(/_0$/, "_n")} endpoints in .env.enc for ${chain.key}`);
    const head = hexToNum(await rpc(urls, "eth_blockNumber", []));
    const lookback = Math.round((WINDOW_DAYS * 86_400) / BLOCK_SECONDS[chain.key]);
    const backBlock = Math.max(head - lookback, chain.fromBlock);
    const from = chain.key === "ethereum" && ETH_FROM_BLOCK !== null ? ETH_FROM_BLOCK : backBlock;
    console.log(`\n=== ${chain.key}: ${urls.length} endpoints; window ${from}..${head} (head)`);

    const list = await scanTransfers(urls, chain, council, from, head);
    console.log(`[${chain.key}] council transfers >= ${MIN_TEL.toLocaleString("en-US")} TEL: ${list.length}`);
    for (const h of list) {
      console.log(`  block ${h.block} ${h.token.padEnd(6)} ${num(h.amount).padStart(18)} TEL  ${h.from} -> ${h.to}  tx ${h.tx}`);
    }

    const points = [["~3 days back", backBlock]];
    if (chain.key === "ethereum") points.unshift(["snapshot block", SCAN_BLOCK]);
    for (const [label, block] of points) {
      printBalances(chain, label, block, await balancesAt(urls, chain, council, block));
    }
    const headRows = await balancesAt(urls, chain, council, head);
    grandTotal += printBalances(chain, "head", head, headRows);
    for (const r of headRows) {
      headTotals.set(r.wallet, { ...(headTotals.get(r.wallet) ?? {}), [chain.key]: r.total });
    }
  }

  console.log("\ncouncil wallets: label and chains holding a balance at head");
  for (const wallet of council) {
    const held = Object.entries(headTotals.get(wallet) ?? {}).filter(([, t]) => t > 0);
    const where = held.length ? held.map(([k, t]) => `${k} ${num(t)}`).join(", ") : "none";
    console.log(`  ${wallet}  ${councilMap.get(wallet)}  ->  ${where}`);
  }

  console.log(`\ncouncil total across chains at head: ${num(grandTotal)} TEL (minimum expected ${num(MIN_COUNCIL_TOTAL_TEL)})`);
  if (grandTotal < MIN_COUNCIL_TOTAL_TEL) {
    console.error("SANITY FAIL: council total is below the minimum; the scan is missing balances or chains.");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`diagnose-council-transfers failed: ${err.message}`);
  process.exit(1);
});
