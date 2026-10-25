#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { reconcileHistoryEntry } from "./lib/holderHistoryReconcile.js";
import { loadNonRetailSet, normalizeAddress } from "./lib/nonRetailSet.js";
import { selectPipelineProject } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Refuses projects the
// pipeline cannot produce yet — see scripts/lib/projects.js pipelineProject().
selectPipelineProject("generate-holders-history");

const HISTORY_PATH = path.resolve(process.cwd(), "public/data/holders-history.json");
const SUMMARY_PATH = path.resolve(process.cwd(), "public/data/holders-summary.json");
const SNAPSHOT_PATH = path.resolve(process.cwd(), "public/data/tel-holders.json");
const PREVIOUS_SNAPSHOT_PATH = path.resolve(process.cwd(), "public/data/tel-holders-previous.json");
const FUNDING_WALLETS_PATH = path.resolve(process.cwd(), "public/data/funding-wallets.json");
const LITE_PATH = path.resolve(process.cwd(), "public/data/holders-lite.json");
const CEX_FLOWS_PATH = path.resolve(process.cwd(), "public/data/cex-flows.json");
const EXCLUSIONS_PATH = path.resolve(process.cwd(), "config/exclusions.json");
const DEX_CONFIG_PATH = path.resolve(process.cwd(), "config/dex-contracts.json");

/** Sum TEL held by known DEX pool/router addresses in a snapshot. */
const sumDexLiquidity = (snapshot, exclusions, dexConfig) => {
  const set = new Set();
  for (const [addr, meta] of Object.entries(exclusions?.labels ?? {})) {
    if (meta?.category === "dex") {
      const a = typeof addr === "string" ? addr.trim().toLowerCase() : "";
      if (a) set.add(a);
    }
  }
  for (const p of dexConfig?.pools ?? []) {
    const a = typeof p?.address === "string" ? p.address.trim().toLowerCase() : "";
    if (a) set.add(a);
  }
  for (const r of dexConfig?.routers ?? []) {
    const a = typeof r?.address === "string" ? r.address.trim().toLowerCase() : "";
    if (a) set.add(a);
  }
  if (set.size === 0) return null;
  let sum = 0;
  for (const w of snapshot?.wallets ?? []) {
    const a = typeof w?.address === "string" ? w.address.trim().toLowerCase() : "";
    if (!a || !set.has(a)) continue;
    sum +=
      (Number(w.ethereum_balance) || 0) +
      (Number(w.polygon_balance) || 0) +
      (Number(w.base_balance) || 0);
  }
  return Number.isFinite(sum) ? sum : null;
};

const readJson = async (absolutePath) => {
  const content = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(content);
};

const parseSnapshotEntry = (snapshot, stakingBalance = null, liteBalance = null) => {
  if (!snapshot) return null;
  const date = snapshot?.source?.snapshotDate ?? null;
  if (!date) return null;
  const generatedAt = snapshot.generatedAt ?? new Date().toISOString();
  const rawBalance = Number(snapshot?.combined?.totalBalance ?? 0);
  const combined = {
    holderCount: Number(snapshot?.combined?.holderCount ?? 0),
    retailHolderCount: Number(snapshot?.combined?.retail?.count ?? 0),
    totalBalance: liteBalance !== null ? liteBalance : rawBalance,
  };
  // stakingBalance is recorded for reporting only. It must NOT be added into
  // totalBalance: pull-holders-rpc.js already merges each staker's stake into
  // their own chain balance, so both `rawBalance` and `liteBalance` are
  // already staking-inclusive. Adding it here was the same double-count that
  // was removed from applyStaking() — it just survived on the fallback path.
  if (stakingBalance !== null) {
    combined.stakingBalance = stakingBalance;
  }
  return {
    date,
    generatedAt,
    combined,
    chains: Object.entries(snapshot?.chains ?? {}).reduce((acc, [key, chain]) => {
      acc[key] = {
        holderCount: Number(chain?.metrics?.holderCount ?? 0),
        retailHolderCount: Number(chain?.metrics?.retail?.count ?? 0),
      };
      return acc;
    }, {}),
  };
};

const parseSummaryEntry = (summary, stakingBalance = null, liteBalance = null) => {
  if (!summary) return null;
  const date = summary.snapshotDate ?? null;
  if (!date) return null;
  const generatedAt = summary.generatedAt ?? new Date().toISOString();
  const rawBalance = Number(summary?.combined?.totalBalance ?? 0);
  const combined = {
    holderCount: Number(summary?.combined?.holderCount ?? 0),
    retailHolderCount: Number(summary?.combined?.retailHolderCount ?? 0),
    totalBalance: liteBalance !== null ? liteBalance : rawBalance,
    holderCountWithStakers: Number(summary?.combined?.holderCountWithStakers ?? 0),
  };
  // stakingBalance is recorded for reporting only. It must NOT be added into
  // totalBalance: pull-holders-rpc.js already merges each staker's stake into
  // their own chain balance, so both `rawBalance` and `liteBalance` are
  // already staking-inclusive. Adding it here was the same double-count that
  // was removed from applyStaking() — it just survived on the fallback path.
  if (stakingBalance !== null) {
    combined.stakingBalance = stakingBalance;
  }
  return {
    date,
    generatedAt,
    combined,
    chains: Object.entries(summary?.chains ?? {}).reduce((acc, [key, chain]) => {
      acc[key] = {
        holderCount: Number(chain?.holderCount ?? 0),
        retailHolderCount: Number(chain?.retailHolderCount ?? 0),
      };
      return acc;
    }, {}),
  };
};

const upsertEntry = (map, entry, { skipIfExists = false } = {}) => {
  if (!entry?.date) return;
  // Never record empty snapshots (e.g. a stale/stub previous file) — they
  // create zero-value entries that corrupt every chart they touch.
  if (!(entry.combined?.holderCount > 0)) return;
  const existing = map.get(entry.date);
  if (skipIfExists && existing) return;
  // Preserve enrichment fields (concentration/distribution) when the
  // replacement entry doesn't carry its own.
  if (existing) {
    if (entry.concentration == null && existing.concentration != null) entry.concentration = existing.concentration;
    if (entry.distribution == null && existing.distribution != null) entry.distribution = existing.distribution;
  }
  if (existing?.combined && entry.combined && entry.combined.stakingBalance == null && existing.combined.stakingBalance != null) {
    // Carry forward the staking balance for reporting only. Do NOT add it into
    // totalBalance — that balance is already staking-inclusive upstream, and
    // adding yesterday's staking figure on top was a double-count.
    entry.combined.stakingBalance = existing.combined.stakingBalance;
  }
  if (existing?.combined && entry.combined && entry.combined.stakingV3Balance == null && existing.combined.stakingV3Balance != null) {
    // Same date re-run without lite details: keep the measured v3 figure.
    entry.combined.stakingV3Balance = existing.combined.stakingV3Balance;
  }
  if (existing?.combined && entry.combined && entry.combined.dexLiquidity == null && existing.combined.dexLiquidity != null) {
    entry.combined.dexLiquidity = existing.combined.dexLiquidity;
  }
  map.set(entry.date, entry);
};

const readOptionalJson = async (absolutePath) => {
  try {
    return await readJson(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const main = async () => {
  const [summary, snapshot, previousSnapshot, existingHistory, fundingWallets, lite, exclusions, dexConfig] = await Promise.all([
    readOptionalJson(SUMMARY_PATH),
    readOptionalJson(SNAPSHOT_PATH),
    readOptionalJson(PREVIOUS_SNAPSHOT_PATH),
    readOptionalJson(HISTORY_PATH),
    readOptionalJson(FUNDING_WALLETS_PATH),
    readOptionalJson(LITE_PATH),
    readOptionalJson(EXCLUSIONS_PATH),
    readOptionalJson(DEX_CONFIG_PATH),
  ]);
  const cexFlows = await readOptionalJson(CEX_FLOWS_PATH);
  const { set: nonRetailSet } = await loadNonRetailSet();
  const dexLiquidity = sumDexLiquidity(snapshot, exclusions, dexConfig);
  // Total TEL held across all tracked wallets, INCLUDING exchanges: exchange
  // deposits are custody moves, not sales, so they must not reduce the total.
  const cexHeld = Number(cexFlows?.overall?.currentBalance ?? 0) || 0;

  const historyMap = new Map();
  for (const entry of existingHistory?.entries ?? []) {
    if (entry?.date) {
      historyMap.set(entry.date, entry);
    }
  }

  // `|| null` would turn a legitimate zero (nobody staking) into "no data",
  // which then triggers the carry-forward of a stale figure. Only a genuinely
  // absent/non-numeric value should become null.
  const rawStaking = Number(fundingWallets?.totals?.stakedAmount);
  const currentStaking = Number.isFinite(rawStaking) ? rawStaking : null;
  // Use holders-lite combined totalBalance (staking-inclusive, per-holder sum) as the
  // authoritative figure for the current snapshot date. Falls back to raw+staking if
  // lite hasn't been generated yet (e.g. first run or manual execution).
  const liteDate = lite?.source?.snapshotDate ?? null;
  const summaryDate = summary?.snapshotDate ?? null;
  const snapshotDate = snapshot?.source?.snapshotDate ?? null;
  const liteBalance = Number(lite?.views?.combined?.metrics?.totalBalance ?? null) || null;
  const liteBalanceForSummary = liteDate && summaryDate && liteDate === summaryDate ? liteBalance : null;
  const liteBalanceForSnapshot = liteDate && snapshotDate && liteDate === snapshotDate ? liteBalance : null;

  const summaryEntry = parseSummaryEntry(summary, currentStaking, liteBalanceForSummary);
  const snapshotEntry = parseSnapshotEntry(snapshot, currentStaking, liteBalanceForSnapshot);
  const previousEntry = parseSnapshotEntry(previousSnapshot);

  // Embed concentration and distribution from holders-lite so history entries
  // carry per-day baselines for the range-aware UI comparisons.
  const liteCombined = lite?.views?.combined ?? null;
  // Balances are rounded to whole TEL in history — sub-TEL precision is
  // meaningless at billions scale and bloats the payload.
  const mapDistribution = (rows) =>
    Array.isArray(rows)
      ? rows.map((row) => ({
          label: row.label,
          count: Number(row.count ?? 0),
          totalBalance: Math.round(Number(row.totalBalance ?? 0)),
        }))
      : undefined;
  const roundConcentration = (top) =>
    top ? Object.fromEntries(Object.entries(top).map(([k, v]) => [k, Math.round(Number(v))])) : top;
  // cexBalance is a standalone field (not just an ingredient of the blended
  // totalHeld) so the frontend can plot Retail/CEX/DEX as independent series
  // and derive Total client-side, instead of trusting a separately-computed
  // blended number that generate-holders-history.js/recompute-history-from-
  // git.js/rebuild-history-from-logs.js could otherwise disagree on. Set it
  // unconditionally (not gated on entry.date === liteDate like the rest of
  // embedLiteDetails below) — cexHeld only depends on cexFlows, loaded
  // independently of holders-lite.json, so there's no reason to withhold it
  // just because lite happens to be stale on a given run.
  const embedCexBalance = (entry) => {
    if (entry?.combined) entry.combined.cexBalance = Math.round(cexHeld);
  };
  embedCexBalance(snapshotEntry);
  embedCexBalance(summaryEntry);

  const embedLiteDetails = (entry) => {
    if (!entry || !liteCombined || entry.date !== liteDate) return;
    if (entry.combined && Number.isFinite(entry.combined.totalBalance)) {
      // Use the freshly-computed local dexLiquidity, not entry.combined.dexLiquidity
      // — the field on the entry hasn't been updated to today's value yet at
      // this point (that happens a few lines below), so reading it here would
      // add yesterday's stale figure instead of today's.
      const dex = Number.isFinite(dexLiquidity) ? dexLiquidity : 0;
      entry.combined.totalHeld = Math.round(entry.combined.totalBalance + cexHeld + dex);
    }
    if (entry.combined && dexLiquidity != null && Number.isFinite(dexLiquidity)) {
      entry.combined.dexLiquidity = Math.round(dexLiquidity);
    }
    // v3 StakingModule total for this date, alongside (never inside) the
    // legacy-only stakingBalance. Only dates the pipeline actually measured
    // carry it; the module did not exist before stakingStats.v3.deployDate,
    // so the frontend reads earlier dates as 0 and the gap in between as
    // unknown (no carry-forward: that would invent a history).
    const v3Staked = Number(liteCombined.stakingStats?.v3?.stakedTotal);
    if (entry.combined && Number.isFinite(v3Staked)) entry.combined.stakingV3Balance = Math.round(v3Staked);
    if (liteCombined.concentration?.top) {
      entry.concentration = roundConcentration(liteCombined.concentration.top);
    }
    const dist = mapDistribution(liteCombined.distribution);
    if (dist) entry.distribution = dist;
    // Per-chain concentration/distribution/balance so chain views are
    // range-aware too (not just the combined view).
    // Chain keys come from the snapshot's own chainOrder, never a hardcoded
    // list — adding a chain to config/chains.json must not silently no-op here.
    for (const ck of lite?.chainOrder ?? Object.keys(lite?.views ?? {}).filter((k) => k !== "combined")) {
      const view = lite?.views?.[ck];
      if (!view || !entry.chains?.[ck]) continue;
      if (view.concentration?.top) entry.chains[ck].concentration = roundConcentration(view.concentration.top);
      const cdist = mapDistribution(view.distribution);
      if (cdist) entry.chains[ck].distribution = cdist;
      if (Number.isFinite(view.metrics?.totalBalance)) entry.chains[ck].totalBalance = Math.round(view.metrics.totalBalance);
    }
  };
  embedLiteDetails(snapshotEntry);
  embedLiteDetails(summaryEntry);

  // Cumulative "wallets that have ever held TEL" — count first-time addresses in
  // this snapshot against a persisted ever-seen checkpoint. Monotonic adoption.
  //
  // Sourced from snapshot.wallets[] filtered against the CURRENT non-retail set,
  // NOT snapshot.chains[*].holders (scan-time-filtered — an address not yet
  // identified as CEX would get counted here as "new" and then never removed
  // even once correctly relabeled CEX later, since this checkpoint only ever
  // adds; see scripts/recompute-history-from-git.js's header for the same bug
  // in the historical recompute, fixed there the same way). Using the current
  // non-retail set here keeps the daily incremental checkpoint from drifting
  // back out of sync with a bulk recompute after the next reclassification.
  const EVER_CHECKPOINT_PATH = path.resolve(process.cwd(), "public/data/holders-ever-checkpoint.json");
  if (snapshot?.wallets && snapshotDate) {
    const everData = await readOptionalJson(EVER_CHECKPOINT_PATH);
    // Forward-only. A reconstructed past day (pull-holders-rpc.js --as-of, via
    // fill-history-gaps.js) must not fold its wallets into a set that has
    // already moved past it, and must never stamp the checkpoint back to its
    // own date — the next daily run would then re-add everything since as
    // "new". Such a row ships without newHolders/cumulativeHolders instead;
    // only a continuous recompute can place those correctly, and
    // pipeline-health.js reports how many rows are waiting for one.
    const everDate = everData?.generatedAt ?? null;
    const isForward = !everDate || snapshotDate > everDate;
    if (!isForward) {
      console.log(
        `Snapshot date ${snapshotDate} is at or before the ever-checkpoint (${everDate}) — ` +
          `leaving newHolders/cumulativeHolders unset and the checkpoint untouched.`,
      );
    }
    const everSet = new Set(everData?.addresses ?? []);
    const before = everSet.size;
    const chainKeys = Object.keys(snapshot.chains ?? {});
    for (const w of snapshot.wallets) {
      const a = normalizeAddress(w?.address);
      if (!a || nonRetailSet.has(a)) continue;
      if (chainKeys.some((k) => Number(w?.[`${k}_balance`]) > 0)) everSet.add(a);
    }
    const newHolders = everSet.size - before;
    const cumulativeHolders = everSet.size;
    if (isForward) {
      for (const entry of [snapshotEntry, summaryEntry]) {
        if (entry && entry.date === snapshotDate) {
          entry.newHolders = newHolders;
          entry.cumulativeHolders = cumulativeHolders;
        }
      }
      await fs.writeFile(
        EVER_CHECKPOINT_PATH,
        JSON.stringify({ generatedAt: snapshotDate, cumulativeHolders, addresses: Array.from(everSet).sort() }),
        "utf8",
      );
    }
  }

  // previousEntry fills gaps only — never overwrites an entry already written by a prior run
  upsertEntry(historyMap, previousEntry, { skipIfExists: true });
  upsertEntry(historyMap, snapshotEntry);
  upsertEntry(historyMap, summaryEntry);

  // Self-heal archive drift: fold any holderCount−distribution count gap into
  // the lowest bucket so hero KPI and Distribution Analysis share one baseline.
  const entries = Array.from(historyMap.values())
    .map((entry) => reconcileHistoryEntry(entry))
    .sort((a, b) => {
      const left = Date.parse(a.date ?? "") || 0;
      const right = Date.parse(b.date ?? "") || 0;
      return left - right;
    });

  const payload = {
    generatedAt: new Date().toISOString(),
    entries,
  };

  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${HISTORY_PATH}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
