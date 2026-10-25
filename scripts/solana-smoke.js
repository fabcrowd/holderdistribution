#!/usr/bin/env node
/**
 * Live smoke test for the Solana adapter (free public RPC first, then
 * SOLANA_RPC_0..9). Read-only; writes nothing.
 *
 *   node scripts/solana-smoke.js --mint <base58> [--program spl-token|token-2022] [--scan]
 *
 * Without --scan it checks RPC health and reads mint metadata (cheap). --scan
 * also runs the full holder scan (getProgramAccounts) — public RPCs often
 * refuse that for large mints; set SOLANA_RPC_0 to a free-tier key then.
 */
import { solanaAdapter } from "./lib/solana/adapter.js";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mint = arg("mint");
if (!mint) {
  console.error("usage: node scripts/solana-smoke.js --mint <base58> [--program spl-token|token-2022] [--scan]");
  process.exit(2);
}
const chain = {
  key: "solana",
  name: "Solana",
  vm: "solana",
  cluster: "mainnet-beta",
  tokenAddress: mint,
  tokens: { legacy: { address: mint, ...(arg("program") ? { program: arg("program") } : {}) } },
};

const urls = await solanaAdapter.health(chain);
console.log(`usable RPCs: ${urls.length}`);
const meta = await solanaAdapter.tokenMeta(chain, chain.tokens.legacy, { urls });
console.log(JSON.stringify(meta, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
if (args.includes("--scan")) {
  const res = await solanaAdapter.scanChain(chain);
  console.log(`holders: ${res.balances.size}, supply: ${res.tokenTotals.legacy}, slot: ${res.checkpointData.lastSlot}`);
}
