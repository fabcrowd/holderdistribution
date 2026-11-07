#!/usr/bin/env node
/**
 * One-off diagnostic for a TEL council-category mismatch (supply-reconciliation
 * vs treasury-history disagreed by 100M TEL on 2026-11-07). Read-only: it reads
 * Transfer logs and balances over public RPC keys from .env.enc and prints:
 *   - every transfer of at least MIN_TEL between a council wallet and anyone,
 *     for the legacy and v3 TEL tokens, from FROM_BLOCK to the chain head;
 *   - each council wallet's balance at SCAN_BLOCK (the block the failed
 *     snapshot scanned to) and at the head, and the council total at each.
 * Never prints a key. Run with ENV_PASSPHRASE; no data is written.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDecryptedEnv } from "./decrypt-env.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROM_BLOCK = Number(process.env.DIAG_FROM_BLOCK ?? 26_363_000);
const SCAN_BLOCK = Number(process.env.DIAG_SCAN_BLOCK ?? 26_363_394);
const MIN_TEL = 1_000_000;
const CHUNK = 5_000;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BALANCE_OF = "0x70a08231";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The Ethereum endpoints from .env.enc (ETH_RPC_0..9), never printed. */
const ethUrls = (env) =>
  Array.from({ length: 10 }, (_, i) => env[`ETH_RPC_${i}`]).filter((u) => typeof u === "string" && u.startsWith("http"));

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
  throw new Error(`${method} failed on every endpoint: ${lastError?.message ?? "unknown"}`);
}

const hexToNum = (h) => parseInt(h, 16);
const toHex = (n) => `0x${n.toString(16)}`;
const padAddr = (a) => `0x${a.slice(2).padStart(64, "0")}`;
const addrOf = (topic) => `0x${topic.slice(-40)}`;

async function councilWallets() {
  const ex = JSON.parse(await fs.readFile(path.join(ROOT, "config/exclusions.json"), "utf8"));
  const found = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object" && value.category === "council" && /^0x[0-9a-fA-F]{40}$/.test(key)) {
        found.add(key.toLowerCase());
      }
      walk(value);
    }
  })(ex);
  return [...found];
}

async function tokens() {
  const chains = JSON.parse(await fs.readFile(path.join(ROOT, "config/chains.json"), "utf8"));
  const eth = chains.ethereum.tokens;
  return {
    legacy: { address: eth.legacy.address.toLowerCase(), decimals: eth.legacy.decimals },
    v3: { address: eth.v3.address.toLowerCase(), decimals: eth.v3.decimals },
  };
}

async function main() {
  const env = await getDecryptedEnv();
  if (!env) throw new Error("ENV_PASSPHRASE is not set or does not decrypt .env.enc");
  const urls = ethUrls(env);
  if (urls.length === 0) throw new Error("no ETH_RPC_* endpoints in .env.enc");
  console.log(`endpoints: ${urls.length}`);

  const council = await councilWallets();
  const tok = await tokens();
  const head = hexToNum(await rpc(urls, "eth_blockNumber", []));
  console.log(`council wallets: ${council.length}; window ${FROM_BLOCK}..${head} (head); snapshot block ${SCAN_BLOCK}`);

  const fmt = (raw, decimals) => Number(BigInt(raw)) / 10 ** decimals;
  const hits = [];
  for (const [name, { address, decimals }] of Object.entries(tok)) {
    const minRaw = BigInt(MIN_TEL) * 10n ** BigInt(decimals);
    for (const side of [1, 2]) {
      const topics = [TRANSFER_TOPIC, null, null];
      topics[side] = council.map(padAddr);
      for (let from = FROM_BLOCK; from <= head; from += CHUNK) {
        const to = Math.min(from + CHUNK - 1, head);
        const logs = await rpc(urls, "eth_getLogs", [{ address, fromBlock: toHex(from), toBlock: toHex(to), topics }]);
        for (const log of logs) {
          const value = BigInt(log.data);
          if (value < minRaw) continue;
          hits.push({
            token: name,
            block: hexToNum(log.blockNumber),
            tx: log.transactionHash,
            from: addrOf(log.topics[1]),
            to: addrOf(log.topics[2]),
            amount: fmt(value.toString(), decimals),
          });
        }
      }
    }
  }
  const unique = new Map(hits.map((h) => [`${h.tx}|${h.token}|${h.from}|${h.to}|${h.amount}`, h]));
  const list = [...unique.values()].sort((a, b) => a.block - b.block);
  console.log(`\ncouncil transfers >= ${MIN_TEL.toLocaleString("en-US")} TEL: ${list.length}`);
  for (const h of list) {
    console.log(`  block ${h.block} ${h.token.padEnd(6)} ${h.amount.toLocaleString("en-US").padStart(18)} TEL  ${h.from} -> ${h.to}  tx ${h.tx}`);
  }

  const balances = async (block) => {
    const tag = toHex(block);
    const rows = [];
    for (const wallet of council) {
      let total = 0;
      const parts = {};
      for (const [name, { address, decimals }] of Object.entries(tok)) {
        const raw = await rpc(urls, "eth_call", [{ to: address, data: BALANCE_OF + padAddr(wallet).slice(2) }, tag]);
        parts[name] = fmt(raw, decimals);
        total += parts[name];
      }
      rows.push({ wallet, total, parts });
    }
    return rows;
  };

  for (const [label, block] of [["snapshot block", SCAN_BLOCK], ["head", "latest"]]) {
    const tagBlock = label === "head" ? head : block;
    const rows = await balances(tagBlock);
    const sum = rows.reduce((s, r) => s + r.total, 0);
    console.log(`\ncouncil balances at ${label} (${tagBlock}), total ${sum.toLocaleString("en-US", { maximumFractionDigits: 0 })} TEL`);
    for (const r of rows.sort((a, b) => b.total - a.total)) {
      console.log(`  ${r.wallet} ${r.total.toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(18)}  legacy ${r.parts.legacy.toLocaleString("en-US")}  v3 ${r.parts.v3.toLocaleString("en-US")}`);
    }
  }
}

main().catch((err) => {
  console.error(`diagnose-council-transfers failed: ${err.message}`);
  process.exit(1);
});
