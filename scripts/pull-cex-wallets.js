#!/usr/bin/env node
/**
 * pull-cex-wallets.js
 *
 * Reads the curated CEX wallet list from config/cex-wallets.json (no API needed),
 * then cross-references those addresses against the current and previous holder
 * snapshots to compute inflow/outflow metrics per exchange.
 *
 * Outputs:
 *   public/data/cex-wallets.json  — timestamped copy of the config wallet list
 *   public/data/cex-flows.json    — per-exchange flow calculations
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { selectPipelineProject, projectPaths, projectClassificationPath } from "./lib/projects.js";
import { normalizeValidAddress } from "./lib/address.js";
import { inheritAsOf, rowDateOf, shouldEmitRow } from "./lib/asOf.js";
import { buildCexFlowsFromSnapshots, summaryCexTotals } from "./lib/cexFlows.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: reads the
// project's own `classification.cexWallets` list and writes its data dir
// (TEL: config/cex-wallets.json -> public/data/; others -> public/data/<slug>/).
const project = selectPipelineProject("pull-cex-wallets", { ported: true });
const data = projectPaths(project);

const CONFIG_PATH = projectClassificationPath(project, "cexWallets", process.cwd());
const CONFIG_REL = CONFIG_PATH ? path.relative(process.cwd(), CONFIG_PATH).split(path.sep).join("/") : null;
const OUTPUT_PATH = data("cex-wallets.json");
const CEX_FLOWS_PATH = data("cex-flows.json");
const CEX_HISTORY_PATH = data("cex-balance-history.json");
const HOLDERS_PATH = data("tel-holders.json");
const PREVIOUS_SNAPSHOT_PATH = data("tel-holders-previous.json");
const SUMMARY_PATH = data("holders-summary.json");

const readJson = async (absolutePath) => {
  const content = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(content);
};

const readOptionalJson = async (absolutePath) => {
  try {
    return await readJson(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

// EVM hex lowercased (TEL unchanged); Solana base58 kept exactly as written.
const normalizeAddress = (value) => normalizeValidAddress(value);

const main = async () => {
  if (!CONFIG_PATH) {
    // A non-legacy project that declares no CEX list: publish an empty list in
    // the shared format (never TEL's wallets) and skip flows.
    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    const empty = { generatedAt: new Date().toISOString(), source: { type: "static", configPath: null }, wallets: [], totals: { walletCount: 0 } };
    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(empty, null, 2)}\n`, "utf8");
    console.warn(`project "${project.slug}" declares no classification.cexWallets — wrote an empty ${OUTPUT_PATH}, no CEX flows.`);
    return;
  }
  // Load static CEX wallet list from config
  const config = await readJson(CONFIG_PATH);
  const wallets = Array.isArray(config?.wallets) ? config.wallets : [];
  if (!wallets.length) {
    throw new Error(`No wallets found in ${CONFIG_PATH}`);
  }

  const generatedAt = new Date().toISOString();

  // Write timestamped cex-wallets.json
  const cexWalletsPayload = {
    generatedAt,
    source: { type: "static", configPath: CONFIG_REL },
    wallets: wallets.map((w) => ({
      address: normalizeAddress(w.address) ?? w.address,
      label: w.label ?? null,
      walletName: w.walletName ?? undefined,
    })),
    totals: { walletCount: wallets.length },
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(cexWalletsPayload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_PATH} (${wallets.length} wallets)`);

  // Compute flows against current and previous holder snapshots
  const snapshot = await readOptionalJson(HOLDERS_PATH);
  if (!snapshot) {
    console.warn("Holder snapshot not found. Skipping CEX flow generation.");
    return;
  }

  const previousSnapshot = await readOptionalJson(PREVIOUS_SNAPSHOT_PATH);

  // The previous snapshot is only a baseline when both snapshots are comparable and
  // exactly one day apart (lib/cexFlows.js); otherwise the feed says why it has none.
  const cexFlows = buildCexFlowsFromSnapshots(cexWalletsPayload, snapshot, previousSnapshot);
  if (cexFlows && !cexFlows.comparison.available) {
    console.warn(`CEX flows carry no previous-snapshot comparison (${cexFlows.comparison.reason}); deltas read zero.`);
  }

  if (!cexFlows) {
    console.warn("No CEX flows generated (no matching balances found).");
    return;
  }

  // Balances are the holder snapshot's, so the flows carry its stamp.
  const asOf = inheritAsOf(snapshot);
  if (asOf) cexFlows.asOf = asOf;
  await fs.writeFile(CEX_FLOWS_PATH, `${JSON.stringify(cexFlows, null, 2)}\n`, "utf8");
  console.log(`Wrote ${CEX_FLOWS_PATH}`);

  // Upsert today's per-exchange balances into cex-balance-history.json
  const snapshotDate = rowDateOf(snapshot);
  const hasBalances = cexFlows.exchanges.some((ex) => ex.currentBalance > 0);
  const emitRow = shouldEmitRow(snapshot?.asOf);
  if (!emitRow) console.warn(`Snapshot ${snapshotDate} is not settled; cex-balance-history row skipped.`);
  if (snapshotDate && hasBalances && emitRow) {
    const history = (await readOptionalJson(CEX_HISTORY_PATH)) ?? { entries: [] };
    const exchanges = {};
    for (const ex of cexFlows.exchanges) {
      if (ex.currentBalance > 0) exchanges[ex.name] = Math.round(ex.currentBalance * 100) / 100;
    }
    const entry = {
      date: snapshotDate,
      exchanges,
      total: Math.round(Object.values(exchanges).reduce((s, v) => s + v, 0) * 100) / 100,
    };
    const entryMap = new Map((history.entries ?? []).map((e) => [e.date, e]));
    entryMap.set(entry.date, entry);
    history.entries = Array.from(entryMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    history.generatedAt = generatedAt;
    if (asOf) history.asOf = asOf;
    await fs.writeFile(CEX_HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    console.log(`Updated ${CEX_HISTORY_PATH} (${history.entries.length} entries)`);
  }

  // Update CEX summary in holders-summary.json if it exists
  const summary = await readOptionalJson(SUMMARY_PATH);
  if (summary) {
    summary.cex = cexFlows?.overall
      ? { ...summaryCexTotals(cexFlows.overall), listUpdatedAt: cexFlows.listUpdatedAt ?? null }
      : null;
    await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`Updated CEX summary in ${SUMMARY_PATH}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
