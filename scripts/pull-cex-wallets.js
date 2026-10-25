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
import { selectPipelineProject } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Refuses projects the
// pipeline cannot produce yet — see scripts/lib/projects.js pipelineProject().
selectPipelineProject("pull-cex-wallets");

const CONFIG_PATH = path.resolve(process.cwd(), "config/cex-wallets.json");
const OUTPUT_PATH = path.resolve(process.cwd(), "public/data/cex-wallets.json");
const CEX_FLOWS_PATH = path.resolve(process.cwd(), "public/data/cex-flows.json");
const CEX_HISTORY_PATH = path.resolve(process.cwd(), "public/data/cex-balance-history.json");
const HOLDERS_PATH = path.resolve(process.cwd(), "public/data/tel-holders.json");
const PREVIOUS_SNAPSHOT_PATH = path.resolve(process.cwd(), "public/data/tel-holders-previous.json");
const SUMMARY_PATH = path.resolve(process.cwd(), "public/data/holders-summary.json");

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

const normalizeAddress = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : null;
};

const coerceBalance = (value) => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildWalletBalanceMap = (wallets) => {
  const map = new Map();
  for (const wallet of wallets ?? []) {
    const address = normalizeAddress(wallet?.address);
    if (!address) continue;
    const balance = coerceBalance(wallet?.total_telcoin_balance ?? wallet?.totalBalance) ?? 0;
    map.set(address, balance);
  }
  return map;
};

const createCexTotals = () => ({
  walletCount: 0,
  walletCountWithBalance: 0,
  previousWalletCountWithBalance: 0,
  currentBalance: 0,
  previousBalance: 0,
  inflow: 0,
  outflow: 0,
  net: 0,
});

const updateCexTotals = (totals, currentBalance, previousBalance) => {
  totals.walletCount += 1;
  if (currentBalance > 0) totals.walletCountWithBalance += 1;
  if (previousBalance > 0) totals.previousWalletCountWithBalance += 1;
  totals.currentBalance += currentBalance;
  totals.previousBalance += previousBalance;
  const delta = currentBalance - previousBalance;
  if (delta > 0) {
    totals.inflow += delta;
  } else if (delta < 0) {
    totals.outflow += Math.abs(delta);
  }
  totals.net += delta;
};

const buildCexFlows = (cexWallets, currentWallets, previousWallets) => {
  if (!cexWallets?.wallets?.length) return null;

  const currentMap = buildWalletBalanceMap(currentWallets);
  let previousMap = buildWalletBalanceMap(previousWallets);
  // An empty/stale previous snapshot would make every wallet look like a fresh
  // inflow (previous = 0), producing phantom +N.NB flow indicators. Treat it
  // as "no change" instead so flows read zero rather than fabricated.
  if (previousMap.size === 0) previousMap = currentMap;

  const overall = createCexTotals();
  const exchangeMap = new Map();

  for (const wallet of cexWallets.wallets) {
    const address = normalizeAddress(wallet?.address);
    if (!address) continue;

    const exchange = typeof wallet?.label === "string" && wallet.label.trim()
      ? wallet.label.trim()
      : "Unknown";

    const currentBalance = currentMap.get(address) ?? 0;
    const previousBalance = previousMap.get(address) ?? 0;
    if (currentBalance <= 0 && previousBalance <= 0) continue;

    updateCexTotals(overall, currentBalance, previousBalance);

    if (!exchangeMap.has(exchange)) {
      exchangeMap.set(exchange, { totals: createCexTotals(), wallets: [] });
    }
    const entry = exchangeMap.get(exchange);
    updateCexTotals(entry.totals, currentBalance, previousBalance);
    const walletName = typeof wallet?.walletName === "string" && wallet.walletName.trim()
      ? wallet.walletName.trim()
      : undefined;
    entry.wallets.push({
      address,
      walletName: walletName || undefined,
      currentBalance,
      previousBalance,
    });
  }

  const exchanges = Array.from(exchangeMap.entries())
    .map(([name, { totals, wallets }]) => ({
      name,
      ...totals,
      wallets: wallets.sort((a, b) => b.currentBalance - a.currentBalance),
    }))
    .sort((a, b) => b.currentBalance - a.currentBalance);

  return {
    generatedAt: new Date().toISOString(),
    listUpdatedAt: cexWallets.generatedAt ?? null,
    overall,
    exchanges,
  };
};

const main = async () => {
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
    source: { type: "static", configPath: "config/cex-wallets.json" },
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

  const cexFlows = buildCexFlows(
    cexWalletsPayload,
    snapshot.wallets ?? [],
    previousSnapshot?.wallets ?? [],
  );

  if (!cexFlows) {
    console.warn("No CEX flows generated (no matching balances found).");
    return;
  }

  await fs.writeFile(CEX_FLOWS_PATH, `${JSON.stringify(cexFlows, null, 2)}\n`, "utf8");
  console.log(`Wrote ${CEX_FLOWS_PATH}`);

  // Upsert today's per-exchange balances into cex-balance-history.json
  const snapshotDate = snapshot?.source?.snapshotDate ?? null;
  const hasBalances = cexFlows.exchanges.some((ex) => ex.currentBalance > 0);
  if (snapshotDate && hasBalances) {
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
    await fs.writeFile(CEX_HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    console.log(`Updated ${CEX_HISTORY_PATH} (${history.entries.length} entries)`);
  }

  // Update CEX summary in holders-summary.json if it exists
  const summary = await readOptionalJson(SUMMARY_PATH);
  if (summary) {
    summary.cex = cexFlows?.overall
      ? { ...cexFlows.overall, listUpdatedAt: cexFlows.listUpdatedAt ?? null }
      : null;
    await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`Updated CEX summary in ${SUMMARY_PATH}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
