#!/usr/bin/env node
// Reconciles every TEL in existence, from the token's own on-chain totalSupply()
// down to the retail float, and checks the result against CoinGecko's reported
// circulating supply.
//
// WHY THIS EXISTS
// The site publishes several TEL totals (retail held, CEX balance, staked, % of
// supply). Until now nothing proved they added up, and they didn't: the parts
// summed to ~104B against a 100B max supply. Two causes, both now fixed —
// bridged mirrors were double-counted against the origin chain, and the staking
// contract's custodied TEL was counted both on the contract and on the stakers
// it had been attributed to. This script is the standing proof that neither
// returns, and the itemised list of what is held out of the retail figure.
//
// GROUND TRUTH, verified on-chain 2026-08-07:
//   Ethereum TEL totalSupply()          = 100,000,000,000  (the real max supply)
//   Polygon ERC20Predicate locks        =  37,249,704,874
//   Polygon TEL totalSupply()           =  37,248,867,603  (backed 1:1, 837K in flight)
//   Base L1StandardBridge locks         =     994,752,342
// So Polygon/Base TEL are MIRRORS of locked Ethereum TEL, never additional
// supply — summing all three chains double-counts every bridged token.
//
//
// TEL v3 (2026-10): total TEL is still 100B but exists as legacy (2 dec) + v3 (18 dec).
// Wallet balances are legacy + v3; legacy held by the upgrade contracts in exchange for
// minted v3 is netted out (see scripts/lib/telTokens.js, docs/TEL-CONTRACTS.md).
//
// Usage: node scripts/reconcile-supply.js [--json]
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  TEL_TOTAL_SUPPLY,
  RECONCILE_TOLERANCE,
  COINGECKO_CIRCULATING,
  buildReconciliation,
} from "./lib/reconcileSupply.js";

export {
  TEL_TOTAL_SUPPLY,
  RECONCILE_TOLERANCE,
  COINGECKO_CIRCULATING,
  buildReconciliation,
};

const HOLDERS_PATH = path.resolve(process.cwd(), "public/data/tel-holders.json");
const EXCLUSIONS_PATH = path.resolve(process.cwd(), "config/exclusions.json");
const CEX_WALLETS_PATH = path.resolve(process.cwd(), "config/cex-wallets.json");
const OUTPUT_PATH = path.resolve(process.cwd(), "public/data/supply-reconciliation.json");

const readJson = async (p, fallback = null) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

const fmt = (n) => Math.round(n).toLocaleString();

const main = async () => {
  const [snapshot, exclusions, cexWallets] = await Promise.all([
    readJson(HOLDERS_PATH),
    readJson(EXCLUSIONS_PATH, { addresses: [], labels: {} }),
    readJson(CEX_WALLETS_PATH, { wallets: [] }),
  ]);
  if (!snapshot) throw new Error("tel-holders.json not found");

  const r = buildReconciliation(snapshot, exclusions, cexWallets);

  console.log("TEL SUPPLY RECONCILIATION");
  console.log("=========================");
  console.log(`Total supply (Ethereum totalSupply())   ${fmt(r.totalSupply).padStart(16)}`);
  console.log(`Derived from our own scan               ${fmt(r.derivedOriginTotal).padStart(16)}`);
  console.log(`  drift vs contract                     ${fmt(r.derivedOriginTotal - r.totalSupply).padStart(16)}`);
  console.log();
  console.log(`Bridge-locked on Ethereum               ${fmt(r.bridgeLocked).padStart(16)}`);
  console.log(`Mirrored on Polygon + Base              ${fmt(r.mirrored).padStart(16)}`);
  console.log(`  mirror residual (should be ~0)        ${fmt(r.mirrorResidual).padStart(16)}`);
  console.log();
  console.log("Held by, counted once:");
  for (const [k, v] of Object.entries(r.categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${fmt(v).padStart(16)}`);
  }
  console.log(`  ${"".padEnd(24, "-")} ${"".padStart(16, "-")}`);
  console.log(`  ${"TOTAL".padEnd(24)} ${fmt(r.counted).padStart(16)}`);
  console.log(`  ${"residual".padEnd(24)} ${fmt(r.residual).padStart(16)}`);
  console.log(`  ${"TOTAL + residual".padEnd(24)} ${fmt(r.counted + r.residual).padStart(16)}`);
  console.log();
  console.log(`  residualParts.bridgeInFlight     ${fmt(r.residualParts.bridgeInFlight).padStart(16)}`);
  console.log(`  residualParts.originDrift        ${fmt(r.residualParts.originDrift).padStart(16)}`);
  console.log(`  residualParts.upgradeUnbacked    ${fmt(r.residualParts.upgradeUnbacked ?? 0).padStart(16)}`);
  if (r.upgrade) {
    console.log();
    console.log("TEL v3 upgrade (legacy 2-decimal TEL -> v3 18-decimal TEL, 1:1):");
    console.log(`  v3 supply (all chains)                 ${fmt(r.upgrade.v3Supply).padStart(16)}`);
    console.log(`  legacy retired into v3 (not counted)   ${fmt(r.upgrade.retiredLegacy).padStart(16)}`);
    console.log(`  stranded in upgrade contract (counted) ${fmt(r.upgrade.strandedInUpgrade).padStart(16)}`);
  }
  console.log();
  console.log(
    `Circulating (excl. treasury/council/SAFE escrow) ${fmt(r.circulating).padStart(15)}`,
  );
  if (r.circulatingExclusions.total > 0) {
    console.log(`  nonCirculatingOverride total             ${fmt(r.circulatingExclusions.total).padStart(16)}`);
    for (const item of r.circulatingExclusions.items) {
      console.log(`    ${(item.name ?? item.address).padEnd(22)} ${fmt(item.amount).padStart(16)}`);
    }
  }
  console.log(`CoinGecko circulating supply                ${fmt(COINGECKO_CIRCULATING).padStart(16)}`);
  console.log(
    `  delta                                     ${fmt(r.circulating - COINGECKO_CIRCULATING).padStart(16)}`,
  );
  // Circulating holds out treasury, council, and any address with a
  // nonCirculatingOverride (TEL contractually committed elsewhere, e.g. a
  // SAFE's return-to-treasury clause — see data/escrow-safe-provenance.md).
  // CoinGecko's figure is not a different methodology to reconcile against —
  // it is treasury 0x2580's on-chain balance frozen as of 2025-10-01 and
  // never refreshed since (see src/lib/methodology.ts). Police
  // counted + residual === 100B, not CG equality.

  if (r.warnings.length > 0) {
    console.warn(`\nWARNING: ${r.warnings.length} nonCirculatingOverride issue(s):`);
    for (const w of r.warnings) console.warn(`  - ${w}`);
  }

  const drift = Math.abs(r.counted - r.totalSupply) / r.totalSupply;
  if (drift > RECONCILE_TOLERANCE) {
    console.warn(
      `\nWARNING: parts sum to ${fmt(r.counted)} against a total supply of ` +
        `${fmt(r.totalSupply)} — ${(drift * 100).toFixed(2)}% adrift. Something is being ` +
        `counted twice or missed entirely.`,
    );
  }

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(r, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${OUTPUT_PATH} (${r.items.length} itemised non-retail addresses)`);
};

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
