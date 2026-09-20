#!/usr/bin/env node
/**
 * Probe every ETH_RPC_* / MATIC_RPC_* / BASE_RPC_* in .env.enc.
 * Prints PASS/FAIL per slot with a short fingerprint — never the full key.
 */
import { getDecryptedEnv } from "./decrypt-env.js";

const SLOTS = {
  ethereum: Array.from({ length: 10 }, (_, i) => `ETH_RPC_${i}`),
  polygon: Array.from({ length: 10 }, (_, i) => `MATIC_RPC_${i}`),
  base: Array.from({ length: 10 }, (_, i) => `BASE_RPC_${i}`),
};

function fingerprint(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/v2\/([^/]+)/);
    const key = m ? m[1] : "?";
    return `${u.host}/v2/${key.slice(0, 4)}…${key.slice(-4)}`;
  } catch {
    return "(invalid-url)";
  }
}

async function probe(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    }),
  });
  if (!res.ok) {
    return { ok: false, detail: `HTTP ${res.status} ${res.statusText}` };
  }
  const data = await res.json();
  if (data.error) {
    return { ok: false, detail: data.error.message || JSON.stringify(data.error) };
  }
  const block = parseInt(data.result, 16);
  return { ok: Number.isFinite(block), detail: `block ${block}` };
}

const env = await getDecryptedEnv();
if (!env) {
  console.error("Could not decrypt .env.enc (is ENV_PASSPHRASE set?)");
  process.exit(1);
}

/** @type {Record<string, { pass: number, fail: number }>} */
const perChain = {};

for (const [chain, keys] of Object.entries(SLOTS)) {
  console.log(`\n=== ${chain} ===`);
  perChain[chain] = { pass: 0, fail: 0 };
  let found = 0;
  for (const name of keys) {
    const url = env[name];
    if (typeof url !== "string" || !url.trim()) continue;
    found += 1;
    const fp = fingerprint(url.trim());
    try {
      const result = await probe(url.trim());
      if (result.ok) {
        perChain[chain].pass += 1;
        console.log(`PASS  ${name}  ${fp}  ${result.detail}`);
      } else {
        perChain[chain].fail += 1;
        console.log(`FAIL  ${name}  ${fp}  ${result.detail}`);
      }
    } catch (err) {
      perChain[chain].fail += 1;
      console.log(`FAIL  ${name}  ${fp}  ${err.message}`);
    }
  }
  if (found === 0) console.log("(no keys set)");
}

// A duplicate key is worse than a missing one: the pool counts slots, so the
// same key in two slots reads as extra capacity while actually concentrating
// twice the request rate on one key's limit. Two of these were live before
// 2026-09-13 (BASE_RPC_0 == BASE_RPC_4, ETH_RPC_0 == ETH_RPC_3) and nothing
// reported them, because every check here was per-slot.
const byKey = new Map();
for (const keys of Object.values(SLOTS)) {
  for (const name of keys) {
    const url = env[name];
    if (typeof url !== "string" || !url.trim()) continue;
    const id = url.trim().split("/v2/")[1] ?? url.trim();
    if (!byKey.has(id)) byKey.set(id, []);
    byKey.get(id).push(name);
  }
}
const duplicates = [...byKey.entries()].filter(([, slots]) => slots.length > 1);
if (duplicates.length) {
  console.log("\n=== duplicates ===");
  for (const [id, slots] of duplicates) {
    console.log(`DUPLICATE  ${slots.join(" == ")}  ${fingerprint(id)}`);
  }
  console.log("Each duplicate slot inflates the apparent pool size without adding capacity.");
}

console.log("\n=== summary ===");
let ok = true;
for (const [chain, stats] of Object.entries(perChain)) {
  const status = stats.pass > 0 ? "OK" : "MISSING";
  if (stats.pass === 0) ok = false;
  console.log(
    `${chain}: ${status} (${stats.pass} pass, ${stats.fail} fail)`,
  );
}

if (duplicates.length) ok = false;

process.exit(ok ? 0 : 1);
