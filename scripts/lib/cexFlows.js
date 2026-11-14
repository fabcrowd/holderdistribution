/**
 * Exchange balance flows (cex-flows.json): the change in tracked exchange wallets
 * between two holder snapshots, plus the stamp of both snapshots so a reader (and
 * check-feed-consistency) can see which window the numbers describe.
 *
 * Pure; nothing here reads files.
 *
 * A comparison is only a one-day flow when both snapshots are comparable (carry an
 * asOf date and no unpinned chain, i.e. what shouldEmitRow accepts: settled, or
 * read live on a chain that cannot be pinned) and the previous one is dated exactly
 * one day before the current one. Anything else (first run, an unstamped or
 * unpinned previous, a same-day rerun, a skipped night, a pinned backfill) writes
 * the first-run shape: previous = current, so every delta reads zero, with
 * `comparison.available: false` and a reason. The UI already reads previousBalance
 * and net as plain numbers, so that shape needs no consumer change.
 */
import { normalizeValidAddress } from "./address.js";
import { inheritAsOf, shouldEmitRow } from "./asOf.js";

const DAY_MS = 86_400_000;

/** A stamp a daily comparison may use: it names a day and no chain was read at an unplanned head. */
export const isComparableStamp = (asOf) => typeof asOf?.date === "string" && shouldEmitRow(asOf);

const dayIndex = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/**
 * Whether the snapshot file about to be replaced may become "previous". The one
 * rotation rule: only a comparable snapshot from an earlier day. A same-day rerun
 * or an unpinned/unstamped file must never displace the older settled previous.
 */
export const canRotatePrevious = (priorAsOf, nextAsOf) =>
  isComparableStamp(priorAsOf) && typeof nextAsOf?.date === "string" && dayIndex(priorAsOf.date) < dayIndex(nextAsOf.date);

/**
 * Which two snapshots a flow compares and whether that is a one-day flow.
 * { available, reason?, windowDays?, previous, current }: previous/current are
 * copies of the asOf stamps (null when absent).
 */
export function snapshotComparison(currentAsOf, previousAsOf) {
  const current = inheritAsOf({ asOf: currentAsOf });
  const previous = inheritAsOf({ asOf: previousAsOf });
  const unavailable = (reason, extra = {}) => ({ available: false, reason, ...extra, previous, current });
  if (!previousAsOf) return unavailable("previous-unstamped");
  if (!isComparableStamp(currentAsOf)) return unavailable("current-not-comparable");
  if (!isComparableStamp(previousAsOf)) return unavailable("previous-not-comparable");
  const windowDays = dayIndex(currentAsOf.date) - dayIndex(previousAsOf.date);
  if (windowDays <= 0) return unavailable("not-ordered");
  if (windowDays > 1) return unavailable("gap", { windowDays });
  return { available: true, windowDays, previous, current };
}

const coerceBalance = (value) => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildWalletBalanceMap = (wallets) => {
  const map = new Map();
  for (const wallet of wallets ?? []) {
    const address = normalizeValidAddress(wallet?.address);
    if (!address) continue;
    const balance = coerceBalance(wallet?.total_telcoin_balance ?? wallet?.totalBalance) ?? 0;
    map.set(address, balance);
  }
  return map;
};

/**
 * address -> one chain's balance in a holder snapshot. A row carries `<chain>_balance`;
 * a single-chain feed whose rows carry only a total uses that total. A multi-chain row
 * lacking the field is null (not measured), never 0.
 */
const buildChainBalanceMap = (wallets, chain, singleChain) => {
  const map = new Map();
  for (const wallet of wallets ?? []) {
    const address = normalizeValidAddress(wallet?.address);
    if (!address) continue;
    const perChain = coerceBalance(wallet?.[`${chain}_balance`]);
    const total = singleChain ? coerceBalance(wallet?.total_telcoin_balance ?? wallet?.totalBalance) : null;
    map.set(address, perChain ?? total);
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

/**
 * `chains` (the feed's asOf.blocks keys) adds overall.byChain: per chain, the summed
 * previous/current balance of every listed exchange wallet, including wallets dropped
 * from `wallets[]` for holding nothing. null = not measurable from the snapshot rows.
 */
export const buildCexFlows = (cexWallets, currentWallets, previousWallets, chains = []) => {
  if (!cexWallets?.wallets?.length) return null;

  const currentMap = buildWalletBalanceMap(currentWallets);
  let previousMap = buildWalletBalanceMap(previousWallets);
  // An empty/stale previous snapshot would make every wallet look like a fresh
  // inflow (previous = 0), producing phantom +N.NB flow indicators. Treat it
  // as "no change" instead so flows read zero rather than fabricated.
  const previousIsCurrent = previousMap.size === 0;
  if (previousIsCurrent) previousMap = currentMap;

  const overall = createCexTotals();
  const exchangeMap = new Map();
  const chainSums = chains.map((chain) => ({
    chain,
    current: buildChainBalanceMap(currentWallets, chain, chains.length === 1),
    previous: buildChainBalanceMap(previousIsCurrent ? currentWallets : previousWallets, chain, chains.length === 1),
    currentBalance: 0,
    previousBalance: 0,
  }));
  const addChainBalance = (sum, key, map, address) => {
    if (sum[key] === null) return;
    const value = map.has(address) ? map.get(address) : 0;
    sum[key] = value === null ? null : sum[key] + value;
  };

  for (const wallet of cexWallets.wallets) {
    const address = normalizeValidAddress(wallet?.address);
    if (!address) continue;
    for (const sum of chainSums) {
      addChainBalance(sum, "currentBalance", sum.current, address);
      addChainBalance(sum, "previousBalance", sum.previous, address);
    }

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

  if (chainSums.length) {
    overall.byChain = Object.fromEntries(
      chainSums.map(({ chain, previousBalance, currentBalance }) => [chain, { previousBalance, currentBalance }]),
    );
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

// byChain is for the cex-flows feed's cross-check only; the summary keeps its original fields.
export const summaryCexTotals = (overall) => {
  const totals = { ...overall };
  delete totals.byChain;
  return totals;
};

/**
 * cex-flows for `snapshot` against `previousSnapshot` (either may be null), with
 * the `comparison` stamp. Without a valid one-day window the previous balances are
 * withheld (first-run shape) instead of presenting a different window as a day.
 */
export function buildCexFlowsFromSnapshots(cexWallets, snapshot, previousSnapshot) {
  const previousWallets = previousSnapshot?.wallets ?? [];
  let comparison = snapshotComparison(snapshot?.asOf, previousSnapshot?.asOf);
  const withhold = (reason) => ({ available: false, reason, previous: comparison.previous, current: comparison.current });
  if (!previousSnapshot) comparison = withhold("no-previous-snapshot");
  else if (comparison.available && previousWallets.length === 0) comparison = withhold("previous-empty");
  const blocks = snapshot?.asOf?.blocks;
  const chains = blocks && typeof blocks === "object" ? Object.keys(blocks) : [];
  const flows = buildCexFlows(cexWallets, snapshot?.wallets ?? [], comparison.available ? previousWallets : [], chains);
  if (!flows) return null;
  return { ...flows, comparison };
}
