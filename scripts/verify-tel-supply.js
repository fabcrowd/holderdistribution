#!/usr/bin/env node
/**
 * verify-tel-supply.js — proves, from live on-chain reads only, that legacy TEL
 * + TEL v3 reconcile to the 100B total, and prints the arithmetic.
 *
 * No API keys, no repo data files: it uses the keyless public RPCs from
 * scripts/lib/rpc.js (override with PUBLIC_RPC_URLS_<CHAIN>) and
 * config/chains.json + config/exclusions.json for addresses.
 *
 * Per chain, pinned to ONE block:
 *   legacy totalSupply, v3 totalSupply, upgrade-contract balances (both tokens),
 *   and — by replaying the v3 + legacy-into-upgrade-contract Transfer logs from
 *   the v3 deployment block with the SAME code the pipeline uses
 *   (scripts/lib/telTokens.js, v3Scan.js) — how much legacy TEL was really
 *   swapped for v3 ("retired") versus sent to the contract without a swap.
 * Then the identity:
 *   Σ legacy supply − Σ retired + Σ v3 supply − (legacy locked as bridge backing)
 *     = 100B  (+ v3 not yet backed by retired legacy, i.e. bridge in-flight)
 *
 * Usage: node scripts/verify-tel-supply.js [--json] [--no-scan]
 *   --no-scan skips the log replay (balances/supplies only; retired is unknown).
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getPublicFallbackUrls, getLogs, rpcCall } from "./lib/rpc.js";
import { resolveChainTokens, rawToTel } from "./lib/telTokens.js";
import { scanV3Chain } from "./lib/v3Scan.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const scan = !args.has("--no-scan");

const pad = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
const fmt = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const readJson = async (rel) => JSON.parse(await fs.readFile(path.resolve(process.cwd(), rel), "utf8"));

async function viaPool(urls, fn) {
  let last;
  for (const url of urls) {
    try {
      return await fn(url);
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

async function main() {
  const [chains, exclusions] = await Promise.all([readJson("config/chains.json"), readJson("config/exclusions.json")]);
  const bridgeLocks = Object.entries(exclusions.labels ?? {})
    .filter(([, m]) => m.category === "bridge-lock")
    .map(([a]) => a.toLowerCase());

  const out = { generatedAt: new Date().toISOString(), chains: {}, totals: {} };

  // The three chains tick at different rates, and v3 crosses chains by burn-and-mint
  // (LayerZero, minutes of latency). Reading each chain at "its latest block" would
  // compare different instants and show bridge traffic as a phantom supply
  // difference, so every chain is pinned to the last block at or before ONE
  // wall-clock instant (a minute behind the slowest head so every node has it).
  const blockTime = async (urls, n) =>
    viaPool(urls, async (u) => Number.parseInt((await rpcCall(u, "eth_getBlockByNumber", ["0x" + n.toString(16), false])).timestamp, 16));
  const heads = {};
  for (const [key, meta] of Object.entries(chains)) {
    if (!resolveChainTokens({ ...meta, key }).v3) continue;
    const urls = getPublicFallbackUrls(key);
    const head = await viaPool(urls, async (u) => Number.parseInt(await rpcCall(u, "eth_blockNumber", []), 16));
    heads[key] = { head: head - 5, ts: await blockTime(urls, head - 5) };
  }
  const instant = Math.min(...Object.values(heads).map((h) => h.ts)) - 30;
  const blockAt = async (key) => {
    const urls = getPublicFallbackUrls(key);
    let hi = heads[key].head;
    let lo = hi - 200_000; // far more than any chain's blocks in a few minutes
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await blockTime(urls, mid)) <= instant) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  out.instant = new Date(instant * 1000).toISOString();

  // Chains are independent (separate endpoints), so replay them concurrently.
  await Promise.all(Object.entries(chains).map(async ([key, meta]) => {
    const tokens = resolveChainTokens({ ...meta, key });
    if (!tokens.v3) return;
    const urls = getPublicFallbackUrls(key);
    const block = await blockAt(key);
    const tag = "0x" + block.toString(16);
    const call = (to, data) =>
      viaPool(urls, async (u) => BigInt(await rpcCall(u, "eth_call", [{ to, data }, tag])));
    const supply = (t) => call(t, "0x18160ddd");
    const balance = (t, who) => call(t, "0x70a08231" + pad(who));

    const legacySupply = await supply(tokens.legacy.address);
    const v3Supply = await supply(tokens.v3.address);
    const escrow = {};
    for (const a of tokens.escrow) {
      escrow[a] = {
        legacy: await balance(tokens.legacy.address, a),
        v3: await balance(tokens.v3.address, a),
      };
    }
    const locks = {};
    if (meta.origin) for (const a of bridgeLocks) locks[a] = await balance(tokens.legacy.address, a);

    let retired = null;
    let v3Logs = 0;
    if (scan) {
      const escrowTopics = tokens.escrow.map((a) => "0x" + pad(a));
      const span = Number(process.env[`${key.toUpperCase()}_V3_GETLOGS_CHUNK_SIZE`]) || 500_000;
      const logs = (address, topics) => (from, to) =>
        viaPool(urls, (u) =>
          getLogs(u, { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address, topics }),
        );
      const r = await scanV3Chain({
        deployBlock: tokens.v3.deployBlock,
        toBlock: block,
        chunkSize: span,
        cfg: { escrow: tokens.escrow, legacyDecimals: tokens.legacy.decimals, v3Decimals: tokens.v3.decimals },
        fetchV3: logs(tokens.v3.address, [TRANSFER]),
        fetchEscrowLegacy: logs(tokens.legacy.address, [TRANSFER, null, escrowTopics]),
      });
      retired = tokens.escrow.reduce((acc, a) => acc + (r.state.retired.get(a) ?? 0n), 0n);
      v3Logs = r.v3Logs;
      // The replayed v3 balances must equal the contract's own totalSupply.
      const replayed = [...r.state.raw.values()].reduce((s, v) => (v > 0n ? s + v : s), 0n);
      if (replayed !== v3Supply) {
        throw new Error(`${key}: replayed v3 balances ${replayed} != on-chain totalSupply ${v3Supply}`);
      }
    }

    out.chains[key] = {
      block,
      legacySupply: rawToTel(legacySupply, tokens.legacy.decimals),
      v3Supply: rawToTel(v3Supply, tokens.v3.decimals),
      escrowLegacy: Object.values(escrow).reduce((s, e) => s + rawToTel(e.legacy, tokens.legacy.decimals), 0),
      escrowV3: Object.values(escrow).reduce((s, e) => s + rawToTel(e.v3, tokens.v3.decimals), 0),
      retiredLegacy: retired === null ? null : rawToTel(retired, tokens.legacy.decimals),
      v3Logs,
      bridgeLockedLegacy: Object.values(locks).reduce((s, v) => s + rawToTel(v, tokens.legacy.decimals), 0),
      origin: Boolean(meta.origin),
    };
  }));
  out.chains = Object.fromEntries(Object.keys(chains).filter((k) => out.chains[k]).map((k) => [k, out.chains[k]]));

  const rows = Object.entries(out.chains);
  const sum = (f) => rows.reduce((s, [, c]) => s + (f(c) ?? 0), 0);
  const origin = rows.find(([, c]) => c.origin)?.[1];
  const mirrorLegacy = sum((c) => (c.origin ? 0 : c.legacySupply));
  const totals = {
    legacySupply: sum((c) => c.legacySupply),
    v3Supply: sum((c) => c.v3Supply),
    retiredLegacy: scan ? sum((c) => c.retiredLegacy) : null,
    escrowLegacy: sum((c) => c.escrowLegacy),
    strandedLegacy: scan ? sum((c) => c.escrowLegacy) - sum((c) => c.retiredLegacy) : null,
    mirrorLegacyBacking: mirrorLegacy,
    bridgeLockedLegacy: origin?.bridgeLockedLegacy ?? 0,
  };
  if (scan) {
    totals.heldTelNetOfRetired = totals.legacySupply - totals.retiredLegacy + totals.v3Supply;
    totals.reconciled = totals.heldTelNetOfRetired - mirrorLegacy;
    totals.originLegacySupply = origin.legacySupply;
    totals.driftVs100B = totals.reconciled - 100_000_000_000;
  }
  out.totals = totals;

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log("TEL v3 SUPPLY PROOF (on-chain, keyless public RPC)");
  console.log("==================================================");
  console.log(`All chains pinned to the last block at or before ${out.instant}`);
  const cols = rows.map(([k]) => k.padStart(20)).join("");
  console.log(`${"".padEnd(46)}${cols}${"TOTAL".padStart(20)}`);
  const line = (label, f) =>
    console.log(`${label.padEnd(46)}${rows.map(([, c]) => fmt(f(c)).padStart(20)).join("")}${fmt(sum(f)).padStart(20)}`);
  console.log(`${"block".padEnd(46)}${rows.map(([, c]) => String(c.block).padStart(20)).join("")}`);
  line("legacy TEL totalSupply (2 dec)", (c) => c.legacySupply);
  line("v3 TEL totalSupply (18 dec)", (c) => c.v3Supply);
  line("legacy TEL held by TokenMigration+Vault", (c) => c.escrowLegacy);
  line("v3 held by TokenMigration+Vault", (c) => c.escrowV3);
  if (scan) {
    line("  of which swapped (v3 minted in same tx)", (c) => c.retiredLegacy);
    line("  of which stranded (sent, never swapped)", (c) => c.escrowLegacy - c.retiredLegacy);
  }
  line("legacy locked in labelled Ethereum bridge locks", (c) => c.bridgeLockedLegacy);
  if (scan) {
    console.log();
    console.log(`Σ legacy supply, all chains                  ${fmt(totals.legacySupply).padStart(24)}`);
    console.log(`− legacy retired into v3 (swapped)           ${fmt(totals.retiredLegacy).padStart(24)}`);
    console.log(`+ v3 supply, all chains                      ${fmt(totals.v3Supply).padStart(24)}`);
    console.log(`= TEL held on chains (legacy + v3, no overlap)${fmt(totals.heldTelNetOfRetired).padStart(23)}`);
    console.log(`− legacy mirrors backed by Ethereum locks    ${fmt(mirrorLegacy).padStart(24)}`);
    console.log(`= TOTAL TEL                                  ${fmt(totals.reconciled).padStart(24)}`);
    console.log(`  vs 100,000,000,000   drift                 ${fmt(totals.driftVs100B).padStart(24)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
