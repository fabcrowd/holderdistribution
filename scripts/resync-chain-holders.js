#!/usr/bin/env node
/**
 * EMERGENCY ONLY — re-syncs public/data/tel-holders.json per-chain holders[]
 * against wallets[] and the current non-retail set (exclusions + CEX + DEX).
 *
 * Routine refreshes already apply exclusions at scan time via
 * pull-holders-rpc.js + scripts/lib/nonRetailSet.js. Prefer a full RPC run.
 * Use this only when exclusions changed and a rescan is not practical.
 *
 * Metrics (holderCount / retail / underThreshold / totalBalance) are always
 * recomputed via scripts/lib/holderMetrics.js — never set retail.count = kept.length.
 *
 * Idempotent for holders lists; metrics are rewritten whenever they drift.
 *
 * Usage: node scripts/resync-chain-holders.js [--dry-run]
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadNonRetailSet, normalizeAddress } from "./lib/nonRetailSet.js";
import { computeChainMetrics, buildSummary, RETAIL_THRESHOLD } from "./lib/holderMetrics.js";

const HOLDERS_PATH = path.resolve(process.cwd(), "public/data/tel-holders.json");
const SUMMARY_PATH = path.resolve(process.cwd(), "public/data/holders-summary.json");

const readJson = async (p, fallback = null) => {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const snapshot = await readJson(HOLDERS_PATH);
  if (!snapshot) throw new Error("tel-holders.json not found");

  const { set: excluded, sizes } = await loadNonRetailSet();
  console.log(
    `Non-retail set: ${sizes.total} addresses ` +
      `(exclusions ${sizes.exclusions}, CEX config ${sizes.cex}, DEX config ${sizes.dex}).`,
  );

  let added = 0;
  let removed = 0;

  for (const [chainKey, chain] of Object.entries(snapshot.chains ?? {})) {
    const holders = chain.holders ?? [];
    const present = new Map(
      holders
        .map((h) => [normalizeAddress(h?.address), h])
        .filter(([addr]) => Boolean(addr)),
    );
    const field = `${chainKey}_balance`;

    // Drop any holder that is now excluded. Skip address-less entries (do not
    // treat "" as an exclusion match — that would drop every blank-address row).
    const kept = [];
    for (const h of holders) {
      const address = normalizeAddress(h?.address);
      if (!address) continue;
      if (excluded.has(address)) {
        removed += 1;
        continue;
      }
      kept.push(h);
    }

    // Add any non-excluded wallet with a positive balance on this chain.
    for (const wallet of snapshot.wallets ?? []) {
      const address = normalizeAddress(wallet?.address);
      if (!address || excluded.has(address) || present.has(address)) continue;
      const balance = Number(wallet?.[field]) || 0;
      if (balance <= 0) continue;
      kept.push({ address: wallet.address, balance });
      added += 1;
    }

    kept.sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
    chain.holders = kept;

    const fromHolders = computeChainMetrics(kept, { retailThreshold: RETAIL_THRESHOLD });
    if (!chain.metrics) chain.metrics = {};
    // Preserve mega/excluded tallies from the scan; recompute retail metrics.
    chain.metrics.holderCount = fromHolders.holderCount;
    chain.metrics.totalBalance = fromHolders.totalBalance;
    chain.metrics.retail = fromHolders.retail;
    chain.metrics.underThreshold = fromHolders.underThreshold;
  }

  // Rebuild combined holder metrics from per-chain results.
  if (!snapshot.combined) snapshot.combined = {};
  snapshot.combined.holderCount = 0;
  snapshot.combined.totalBalance = 0;
  snapshot.combined.retail = { count: 0, balance: 0 };
  snapshot.combined.underThreshold = { count: 0, balance: 0 };
  for (const chain of Object.values(snapshot.chains ?? {})) {
    const m = chain.metrics ?? {};
    snapshot.combined.holderCount += m.holderCount ?? 0;
    snapshot.combined.totalBalance += m.totalBalance ?? 0;
    snapshot.combined.retail.count += m.retail?.count ?? 0;
    snapshot.combined.retail.balance += m.retail?.balance ?? 0;
    snapshot.combined.underThreshold.count += m.underThreshold?.count ?? 0;
    snapshot.combined.underThreshold.balance += m.underThreshold?.balance ?? 0;
  }

  const summary = buildSummary(snapshot);

  console.log(`Added ${added} holder entr${added === 1 ? "y" : "ies"}, removed ${removed}.`);
  console.log(
    `Retail counts: ` +
      Object.entries(snapshot.chains ?? {})
        .map(([k, c]) => `${k}=${c.metrics?.retail?.count ?? 0}`)
        .join(", ") +
      ` (combined=${snapshot.combined.retail.count})`,
  );

  if (dryRun) {
    console.log("--dry-run: nothing written.");
    return;
  }

  await fs.writeFile(HOLDERS_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Wrote ${HOLDERS_PATH}`);
  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`Wrote ${SUMMARY_PATH}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
