import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const OUTPUT_PATH = path.resolve(process.cwd(), "public/data/cex-wallets.json");
const HOLDERS_PATH = path.resolve(process.cwd(), "public/data/tel-holders.json");
const PREVIOUS_SNAPSHOT_PATH = path.resolve(process.cwd(), "public/data/tel-holders-previous.json");
const SUMMARY_PATH = path.resolve(process.cwd(), "public/data/holders-summary.json");

export { OUTPUT_PATH, HOLDERS_PATH, PREVIOUS_SNAPSHOT_PATH, SUMMARY_PATH };

const normalizeAddress = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : null;
};

const readJson = async (absolutePath) => {
  const content = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(content);
};

const coerceBalance = (value) => {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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
  if (delta > 0) totals.inflow += delta;
  else if (delta < 0) totals.outflow += Math.abs(delta);
  totals.net += delta;
};

const buildCexFlows = (cexWallets, currentWallets, previousWallets) => {
  if (!cexWallets?.wallets?.length) return null;
  const currentMap = buildWalletBalanceMap(currentWallets);
  const previousMap = buildWalletBalanceMap(previousWallets);
  const overall = createCexTotals();
  const exchangeMap = new Map();
  for (const wallet of cexWallets.wallets) {
    const address = normalizeAddress(wallet?.address);
    if (!address) continue;
    const exchange = (typeof wallet?.label === "string" && wallet.label.trim())
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
    entry.wallets.push({ address, walletName: walletName || undefined, currentBalance, previousBalance });
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
    listQueryId: cexWallets.queryId ?? null,
    overall,
    exchanges,
  };
};

const updateCexFlowsInSnapshot = async (cexWallets) => {
  let snapshot;
  try {
    snapshot = await readJson(HOLDERS_PATH);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn("Holder snapshot not found. Skipping CEX flow update.");
      return;
    }
    throw error;
  }
  let previousSnapshot = null;
  try {
    previousSnapshot = await readJson(PREVIOUS_SNAPSHOT_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Unable to load previous holder snapshot:", error.message);
    }
  }
  const cexFlows = buildCexFlows(cexWallets, snapshot.wallets ?? [], previousSnapshot?.wallets ?? []);
  if (!cexFlows) {
    console.warn("No CEX flows generated from current holder snapshot.");
    return;
  }
  snapshot.cex = cexFlows;
  await fs.writeFile(HOLDERS_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Updated CEX flows in ${HOLDERS_PATH}`);
  try {
    const summary = await readJson(SUMMARY_PATH);
    summary.cex = cexFlows?.overall
      ? { ...cexFlows.overall, listUpdatedAt: cexFlows.listUpdatedAt ?? null, listQueryId: cexFlows.listQueryId ?? null }
      : null;
    await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(`Updated CEX flows in ${SUMMARY_PATH}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Unable to update holder summary CEX data:", error.message);
    }
  }
};

/**
 * Writes the CEX payload to cex-wallets.json and updates CEX flows in tel-holders.json and holders-summary.json.
 * @param {object} payload - { generatedAt, queryId, executionId?, executedAt?, wallets, totals, source }
 */
export async function writeCexSnapshotAndUpdateFlows(payload) {
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
  await updateCexFlowsInSnapshot(payload);
}
