#!/usr/bin/env node
/**
 * recompute-history-from-git.js
 *
 * Corrects retail-count/CEX-balance history that predates a reclassification
 * WITHOUT any RPC calls — public/data/tel-holders.json is git-committed every
 * pipeline run (not gitignored), so every historical per-wallet balance
 * snapshot already exists as a git blob. This walks that history, re-derives
 * each date's classification against the CURRENT config/exclusions.json +
 * config/cex-wallets.json + config/dex-contracts.json (via the same
 * loadNonRetailSet() every other pipeline script uses), and overwrites the
 * affected fields in place:
 *
 *   public/data/holders-history.json    — combined.{cexBalance,totalHeld},
 *                                          distribution/concentration buckets,
 *                                          newHolders/cumulativeHolders
 *   public/data/cex-balance-history.json — entries[*].{exchanges,total}
 *
 * TWO MEASUREMENT REGIMES — what this script must NOT write (2026-08-22)
 * ---------------------------------------------------------------------
 * `holderCount`, `retailHolderCount` and `totalBalance` (combined and per-chain)
 * are owned by rebuild-history-from-logs.js and are deliberately NOT written
 * here. A git-committed tel-holders.json is a point-in-time *scan*, which is a
 * strictly weaker measurement of a day than replaying that day's Transfer logs:
 * it is capped by whatever the original scan happened to record. Only ~176 of
 * 233 archive dates have such a blob, so writing scan-derived balances onto
 * those while the other ~57 kept their log-replay values interleaved two
 * incompatible series in one chart. Measured on the teeth dates, the two regimes
 * disagree by 1.3-5.2B TEL and ~1,500 wallets, which rendered as paired V-shaped
 * spikes (a drop, then a near-identical recovery the next day) wherever a
 * snapshot date sat between log-replay neighbours — artifacts ~2.7x LARGER than
 * the entire real 8-month trend of +1.95B. The log-replay series on its own is
 * smooth across exactly those dates. See lessons.md → "One Series, One
 * Measurement Regime".
 *
 * Note the two regimes also disagree in DIRECTION per field (snapshot dates read
 * ~1,500 wallets HIGHER but ~3.8B LOWER), so this is not a single offset that
 * could be reconciled with a correction factor — they are genuinely different
 * measurements and only one of them can own a field.
 *
 * combined.totalHeld (= totalBalance + cexHeld) is normally frozen per day by
 * generate-holders-history.js — it only computes it for *today's* entry, so
 * historical days keep whatever CEX balance was in effect when they were
 * originally generated. A CEX relabel (addresses moving into/out of cexSet)
 * then shows up as a fake overnight step in the Total TEL Balance chart
 * instead of a flat, reclassified-consistent line. Recompute it here from
 * the same per-date totalBalance + cexTotal this script already derives.
 *
 * Also rebuilds `newHolders`/`cumulativeHolders` (per-date, chronologically,
 * combined across chains) and `public/data/holders-ever-checkpoint.json` — the
 * "wallets that have ever held TEL" running set. generate-holders-history.js's
 * daily block builds this from raw `chain.holders` (scan-time-filtered,
 * monotonic — never removes an address once added, so a wallet later
 * identified as CEX stays counted as a "new retail holder" forever, and a
 * wallet wrongly excluded at scan time never enters the set on the day it
 * should have). Recomputed here the same way as everything else: walk every
 * dated snapshot chronologically (including pre-archive dates back to
 * 2025-10-12, purely to seed the running set so day one of the archive isn't
 * misattributed), applying the CURRENT non-retail set at every date.
 *
 * Also removes PHANTOM STAKERS from every historical date. Until 2026-08-07
 * the staking attribution netted Etherscan transfer logs instead of reading
 * `stakedBy()`, and pull-holders-rpc.js merges every attributed staker into the
 * Polygon balance map as a holder — so each over-attributed wallet became a
 * phantom Polygon holder. The 2026-08-08 snapshot (first run after commits
 * 2049c06 / f60e6fb fixed the attribution) drops 1,399 Polygon wallets in one
 * day against a 7-64/day baseline. Unlike everything else in this file that is
 * NOT a classification problem — 0 of those 1,399 are in the non-retail set,
 * because they are fabricated rows rather than exchanges or pools, so
 * reclassifying reproduces them exactly. See scripts/lib/phantomStakers.js for
 * the detection test, the on-chain verification, and its known limitation.
 *
 * Also rebuilds `distribution` (per-tier count/totalBalance) and
 * `concentration` (top-10/25/.../1000 balance sums), combined and per-chain,
 * from the SAME wallets[]-derived holder lists as everything above — they are
 * just as much a function of "which addresses are excluded right now" as
 * holderCount/totalHeld, so freezing them was the same bug in a different
 * field. Previously `reconcileHistoryEntry()` alone was relied on to keep
 * `holderCount === Σ distribution[].count`, but it does that by dumping ANY
 * gap into the lowest tier bucket — fine for its original, narrow purpose
 * (the small, legitimate sub-1-TEL dust-wallet gap), but wrong for a
 * reclassification-sized gap: e.g. five TelcoinWallet contracts holding
 * 2,194,488,609 TEL (individually well into the 100M+ tiers) un-excluded
 * 2026-08-07 were getting counted as if they were dust in "1-250K". Bucketing
 * from wallets[] directly places each wallet in its real tier; reconcile
 * still runs afterward for the residual (correct, small) dust-floor gap.
 * stakingBalance/dexLiquidity remain untouched — genuinely unrelated to
 * exclusion classification.
 *
 * Run: node scripts/recompute-history-from-git.js [--dry-run]
 * Then flip the relevant config/classification-changelog.json events'
 * backfillStatus to "complete" and re-run scripts/sync-classification-changelog.js.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadNonRetailSet, normalizeAddress } from "./lib/nonRetailSet.js";
import { computeChainMetrics, RETAIL_THRESHOLD } from "./lib/holderMetrics.js";
import { reconcileHistoryEntry } from "./lib/holderHistoryReconcile.js";
import { DISTRIBUTION_RANGES, CONCENTRATION_BUCKETS } from "./lib/holdersView.js";
import { classifySnapshot, stakedAmountsByAddress } from "./lib/phantomStakers.js";
import { selectPipelineProject } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Refuses projects the
// pipeline cannot produce yet — see scripts/lib/projects.js pipelineProject().
selectPipelineProject("recompute-history-from-git");

const ROOT = process.cwd();
const HOLDERS_SNAPSHOT_FILE = "public/data/tel-holders.json";
const FUNDING_WALLETS_FILE = "public/data/funding-wallets.json";
const FUNDING_WALLETS_PATH = path.resolve(ROOT, FUNDING_WALLETS_FILE);
const EMPTY_SET = new Set();
const HOLDERS_HISTORY_PATH = path.resolve(ROOT, "public/data/holders-history.json");
const CEX_HISTORY_PATH = path.resolve(ROOT, "public/data/cex-balance-history.json");
const CEX_CONFIG_PATH = path.resolve(ROOT, "config/cex-wallets.json");
const EVER_CHECKPOINT_PATH = path.resolve(ROOT, "public/data/holders-ever-checkpoint.json");

const dryRun = process.argv.includes("--dry-run");

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const showJson = (commit, file) => JSON.parse(git(["show", `${commit}:${file}`]));

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

/** Latest commit hash per date the given file was committed at, newest-first. */
const commitsByDate = (file) => {
  const out = git(["log", "--format=%H %ad", "--date=short", "--", file]);
  const map = new Map();
  for (const line of out.trim().split("\n")) {
    const [hash, date] = line.split(" ");
    if (hash && date && !map.has(date)) map.set(date, hash);
  }
  return map;
};

/** Per-chain metrics for one historical tel-holders.json blob, reclassified
 *  against the CURRENT non-retail set.
 *
 *  Deliberately sourced from the snapshot's top-level `wallets[]` array, NOT
 *  `chain.holders`. `chain.holders` is the more aggressively filtered of the
 *  two: it drops everything `wallets[]` drops, plus more. Reading `wallets[]`
 *  recovers the difference — e.g. two TelcoinWallet contracts holding 866.4M
 *  TEL combined, wrongly excluded until 2026-08-07, were absent from every
 *  chain's `holders[]` on 2026-08-06 but present with full balances in
 *  `wallets[]`. It is also the array `exchangeBalancesForSnapshot()` below
 *  reads, which is why the CEX-balance half of this script never had the bug.
 *
 *  BUT `wallets[]` is NOT the complete, scan-time-unfiltered list, as this
 *  comment previously claimed. Measured: only 98-99 of the current 27,323
 *  non-retail addresses appear in ANY snapshot's `wallets[]`. Since commit
 *  348b47e (2026-08-07) pull-holders-rpc.js merges the CEX and DEX sets into
 *  its global exclusion set BEFORE serializing, so those addresses never reach
 *  `wallets[]` at all. Two consequences worth stating plainly, because the old
 *  wording implied the opposite:
 *
 *    - This function can further-exclude an address, but it CANNOT recover one
 *      dropped at scan time. Reclassification is one-directional for anything
 *      the scan already discarded.
 *    - An address that was in the CEX/DEX config on a past run but has since
 *      been removed from it is invisible from both ends: stripped from every
 *      snapshot after that run, and unmatched by today's set in every snapshot
 *      before it. No amount of re-running fixes that; it needs a changelog
 *      entry instead.
 *
 *  Corollary: a discontinuity this script leaves untouched is not thereby
 *  "already correct" — check whether the metric's DEFINITION changed (as the
 *  2026-08-07 staking-attribution fix did) before concluding the data is fine. */
const metricsForSnapshot = (snapshot, excluded, dropped = EMPTY_SET) => {
  const chainKeys = Object.keys(snapshot?.chains ?? {});
  const perChainHolders = Object.fromEntries(chainKeys.map((k) => [k, []]));
  const combinedHolders = [];

  for (const w of snapshot?.wallets ?? []) {
    const a = normalizeAddress(w?.address);
    if (!a || excluded.has(a) || dropped.has(a)) continue;
    for (const key of chainKeys) {
      const balance = Number(w?.[`${key}_balance`]);
      if (!Number.isFinite(balance) || balance <= 0) continue;
      const holder = { address: a, balance };
      perChainHolders[key].push(holder);
      combinedHolders.push(holder);
    }
  }

  const chains = {};
  for (const key of chainKeys) {
    chains[key] = computeChainMetrics(perChainHolders[key], { retailThreshold: RETAIL_THRESHOLD });
  }
  const combined = computeChainMetrics(combinedHolders, { retailThreshold: RETAIL_THRESHOLD });
  return { chains, combined, chainHolders: perChainHolders, combinedHolders };
};

/** Buckets holders (each `{ address, balance }`) into DISTRIBUTION_RANGES,
 *  matching the shape generate-holders-history.js's mapDistribution() writes
 *  (label/count/totalBalance only, zero-rows dropped — same filter
 *  buildDistributionRows in scripts/lib/holdersView.js already applies). */
const buildDistribution = (holders) =>
  DISTRIBUTION_RANGES.map((range) => {
    const bucket = holders.filter((h) => h.balance >= range.min && h.balance < range.max);
    const totalBalance = bucket.reduce((sum, h) => sum + h.balance, 0);
    return { label: range.label, count: bucket.length, totalBalance: Math.round(totalBalance) };
  }).filter((row) => row.count > 0 || row.totalBalance > 0);

/** Top-N balance sums for each CONCENTRATION_BUCKETS size, matching
 *  generate-holders-history.js's roundConcentration() output shape. */
const buildConcentrationTop = (holders) => {
  const sorted = [...holders].sort((a, b) => b.balance - a.balance);
  const top = {};
  for (const bucket of CONCENTRATION_BUCKETS) {
    const slice = sorted.slice(0, bucket);
    top[bucket] = Math.round(slice.reduce((sum, h) => sum + h.balance, 0));
  }
  return top;
};

/** Every address currently classified as a retail holder in this snapshot
 *  (balance > 0 on any chain, not in the CURRENT non-retail set) — used to
 *  rebuild newHolders/cumulativeHolders chronologically. Schema-tolerant:
 *  snapshots from 2025-12-31 onward have a top-level `wallets[]` (used
 *  elsewhere in this file); snapshots before that (back to 2025-10-12) only
 *  have `combined.holders[]` with `{address, balance, chain}` — no
 *  per-chain-balance breakdown, but sufficient to know an address held TEL. */
const extractHeldAddresses = (snapshot, excluded, dropped = EMPTY_SET) => {
  const addrs = new Set();
  if (Array.isArray(snapshot?.wallets) && snapshot.wallets.length) {
    const chainKeys = Object.keys(snapshot?.chains ?? {});
    for (const w of snapshot.wallets) {
      const a = normalizeAddress(w?.address);
      if (!a || excluded.has(a) || dropped.has(a)) continue;
      if (chainKeys.some((k) => Number(w?.[`${k}_balance`]) > 0)) addrs.add(a);
    }
  } else {
    for (const h of snapshot?.combined?.holders ?? []) {
      const a = normalizeAddress(h?.address);
      if (a && !excluded.has(a) && !dropped.has(a) && Number(h?.balance) > 0) addrs.add(a);
    }
  }
  return addrs;
};

/** Sum of every wallet's total_telcoin_balance grouped by CEX label, using
 *  the historical snapshot's top-level `wallets` array + the CURRENT
 *  cex-wallets.json — same computation pull-cex-wallets.js does for "today",
 *  applied to a past date's balances instead. */
const exchangeBalancesForSnapshot = (snapshot, cexWallets) => {
  const balanceMap = new Map();
  for (const w of snapshot?.wallets ?? []) {
    const a = normalizeAddress(w?.address);
    if (!a) continue;
    const bal = Number(w?.total_telcoin_balance ?? w?.totalBalance ?? 0);
    if (Number.isFinite(bal)) balanceMap.set(a, bal);
  }
  const exchanges = {};
  let total = 0;
  for (const wallet of cexWallets?.wallets ?? []) {
    const a = normalizeAddress(wallet?.address);
    if (!a) continue;
    const bal = balanceMap.get(a) ?? 0;
    if (bal <= 0) continue;
    const label = typeof wallet?.label === "string" && wallet.label.trim() ? wallet.label.trim() : "Unknown";
    exchanges[label] = (exchanges[label] ?? 0) + bal;
    total += bal;
  }
  return { exchanges, total };
};

/** Newest date in `dates` that is <= `date`, or null. `dates` must be sorted
 *  ascending. funding-wallets.json is not committed on exactly the same days as
 *  tel-holders.json, so a snapshot's attribution is whichever funding-wallets
 *  blob was current when that snapshot was taken — not a same-day match. */
const asOfDate = (sortedDates, date) => {
  let match = null;
  for (const d of sortedDates) {
    if (d > date) break;
    match = d;
  }
  return match;
};

const main = async () => {
  const { set: excluded, sizes } = await loadNonRetailSet();
  console.log(`Current non-retail set: ${sizes.total} addresses (exclusions ${sizes.exclusions}, CEX ${sizes.cex}, DEX ${sizes.dex}).`);

  const cexWallets = await readJson(CEX_CONFIG_PATH);
  const snapCommits = commitsByDate(HOLDERS_SNAPSHOT_FILE);
  console.log(`${HOLDERS_SNAPSHOT_FILE}: ${snapCommits.size} distinct dated commits available for recompute.`);

  // Phantom-staker correction (see file header). The current funding-wallets.json
  // is stakedBy()-derived and is the authority on who actually stakes; each
  // historical date is compared against the attribution in effect on that date.
  const currentStakes = stakedAmountsByAddress(await readJson(FUNDING_WALLETS_PATH));
  const fundingCommits = commitsByDate(FUNDING_WALLETS_FILE);
  const fundingDates = [...fundingCommits.keys()].sort();
  const fundingCache = new Map();
  const stakesAsOf = (date) => {
    const key = asOfDate(fundingDates, date);
    if (!key) return new Map();
    if (!fundingCache.has(key)) {
      let stakes = new Map();
      try { stakes = stakedAmountsByAddress(showJson(fundingCommits.get(key), FUNDING_WALLETS_FILE)); }
      catch (e) { console.warn(`  funding-wallets ${key}: unreadable — ${e.message}`); }
      // Only the most recent lookup is retained: dates are processed in
      // ascending order, so an older blob is never needed again, and these
      // documents are large enough that keeping all ~190 is wasteful.
      fundingCache.clear();
      fundingCache.set(key, stakes);
    }
    return fundingCache.get(key);
  };
  console.log(`Current staking attribution: ${currentStakes.size} wallets; ${fundingDates.length} dated funding-wallets commits available.`);

  const holdersHistory = await readJson(HOLDERS_HISTORY_PATH);
  const cexHistory = await readJson(CEX_HISTORY_PATH);
  const holdersByDate = new Map((holdersHistory.entries ?? []).map((e) => [e.date, e]));
  const cexByDate = new Map((cexHistory.entries ?? []).map((e) => [e.date, e]));
  const allDates = [...new Set([...holdersByDate.keys(), ...cexByDate.keys()])].sort();

  // cex-balance-history.json's own dated entries are the authoritative CEX
  // total — confirmed stable/unchanged by this same script's own recompute
  // of them below. exchangeBalancesForSnapshot(snap, cexWallets), by
  // contrast, looks CEX addresses up in that date's git-committed
  // tel-holders.json wallets[] — which is NOT a reliable source for CEX
  // presence: CEX/DEX wallets get stripped from wallets[] before
  // serializing on most (not all) scan runs (see lessons.md's "load-bearing
  // code comment was false" entry), so a snapshot that happens to have
  // stripped them yields a false 0 for that date. Using it for totalHeld
  // (as this script previously did) produced a toggling 0/~20B square wave
  // across the whole archive instead of a stable CEX figure. cex-balance-
  // history.json is sparse (built on a slower, weekly-ish cadence), so carry
  // forward the nearest dated entry at or before the target date — same
  // as-of pattern already used for funding-wallets/staking above.
  const cexHistoryDates = [...cexByDate.keys()].sort();
  // A date before cex-balance-history.json's first entry (2026-01-18) has no
  // "as of" match, and falling back to 0 fabricates a fake CEX balance step
  // from 0 -> ~19.6B exactly on that date — CEX custody didn't spring into
  // existence then, the archive just doesn't go back further. That fake step
  // inflated every totalHeld delta whose baseline predates 01-18 (e.g. the
  // hero's YTD "Total TEL Held" tile). Carry the earliest known balance
  // backward instead — an approximation, but a vastly less wrong one than a
  // fabricated zero.
  const cexTotalAsOf = (date) => {
    const key = asOfDate(cexHistoryDates, date) ?? cexHistoryDates[0];
    if (!key) return 0;
    return Number(cexByDate.get(key)?.total ?? 0) || 0;
  };

  // Seed the "ever held TEL" running set from every dated snapshot strictly
  // before the archive's first date, so that date's newHolders isn't
  // misattributed (counting wallets that already existed since 2025-10-12,
  // the earliest git-committed snapshot, as if they were new on day one of
  // the archive).
  const everSeen = new Set();
  const archiveStart = allDates[0];
  const seedDates = [...snapCommits.keys()].filter((d) => !archiveStart || d < archiveStart).sort();
  console.log(`Seeding ever-held set from ${seedDates.length} pre-archive dated snapshots (back to ${seedDates[0] ?? "n/a"})...`);
  for (const date of seedDates) {
    const commit = snapCommits.get(date);
    let snap = null;
    try { snap = showJson(commit, HOLDERS_SNAPSHOT_FILE); }
    catch (e) { console.warn(`  ${date} (${commit.slice(0, 8)}): unparseable during seed — ${e.message}`); continue; }
    const { phantoms } = classifySnapshot(snap, stakesAsOf(date), currentStakes);
    for (const a of extractHeldAddresses(snap, excluded, phantoms)) everSeen.add(a);
  }
  console.log(`Ever-held set seeded: ${everSeen.size} addresses as of ${archiveStart ?? "n/a"}.`);
  let latestEverDate = seedDates[seedDates.length - 1] ?? null;

  // Each tel-holders.json snapshot is ~30MB+ parsed. The previous version of
  // this script cached every distinct date's snapshot in a Map and only
  // released them after BOTH output files were fully processed — for the
  // ~160+ dates in this archive that's several GB resident at once, which
  // reliably crashed the process with an OOM before it ever reached
  // fs.writeFile. Every date this script "backfilled" in the console output
  // of a run that then crashed was never actually written to disk — the
  // classification-changelog.json entries marking events "backfillStatus:
  // complete" were wrong for exactly that reason. Fix: one pass over the
  // union of dates, one snapshot loaded and discarded per date, both output
  // files updated for that date before moving to the next — peak memory is
  // one snapshot, not the whole archive.
  let totalHeldChanged = 0;
  let distributionChanged = 0;
  let everChanged = 0;
  let cexChanged = 0;
  let phantomDates = 0;

  /**
   * Writes the two fields that need no snapshot at all: cexBalance (straight
   * from cex-balance-history.json) and the totalHeld derived from it plus the
   * entry's own log-replay totalBalance.
   *
   * Every date must get a cexBalance, including ones whose snapshot is missing
   * or unusable. The frontend derives its Total line as
   * `retail + (cex ?? 0) + (dex ?? 0)`, so an entry with NO cexBalance silently
   * reads as "CEX held nothing that day" and draws a ~-18B cliff — which is
   * exactly what 2026-02-24 (the known-empty snapshot, skipped by the guard
   * below) did to the chart. A missing balance is unknown, not zero.
   */
  const patchCexOnly = (holdersEntry, date, reason) => {
    if (!holdersEntry?.combined) return;
    // Round ONCE and reuse. Deriving totalHeld from the raw total while
    // publishing a rounded cexBalance left the two out of step by 1 unit on 44
    // entries, so `totalBalance + cexBalance + dexLiquidity === totalHeld` — the
    // invariant a consumer reads off the published fields — did not hold exactly.
    const cexBalance = Math.round(cexTotalAsOf(date));
    holdersEntry.combined.cexBalance = cexBalance;
    if (!Number.isFinite(holdersEntry.combined.totalHeld)) return;
    if (!Number.isFinite(holdersEntry.combined.totalBalance)) return;
    const dex = Number(holdersEntry.combined.dexLiquidity) || 0;
    const before = holdersEntry.combined.totalHeld;
    const after = Math.round(holdersEntry.combined.totalBalance + cexBalance + dex);
    if (before === after) return;
    holdersEntry.combined.totalHeld = after;
    totalHeldChanged++;
    console.log(`  ${date}: totalHeld ${before.toLocaleString()} -> ${after.toLocaleString()} (${reason} — CEX-only patch)`);
  };
  let phantomPeak = 0;
  let ambiguousPeak = 0;
  for (const date of allDates) {
    const commit = snapCommits.get(date);
    if (!commit) {
      // No git-committed tel-holders.json snapshot for this date — most of the
      // archive now falls here, since rebuild-history-from-logs.js (2026-08-21)
      // derives every date directly from chain state at a resolved block
      // boundary, independent of whether a scan was ever committed that day.
      // Can't recompute holderCount/distribution/etc. without a snapshot to
      // replay, but totalHeld only needs totalBalance (already correct, from
      // the log replay) + the CEX total — no snapshot required for that half.
      // Without this, only the sparse subset of dates that DO have a git
      // snapshot ever get totalHeld corrected, producing exactly the
      // 0/~20B toggle this fix exists to eliminate.
      patchCexOnly(holdersByDate.get(date), date, "no git snapshot");
      continue;
    }
    let snap = null;
    try { snap = showJson(commit, HOLDERS_SNAPSHOT_FILE); }
    catch (e) { console.warn(`  ${date} (${commit.slice(0, 8)}): unparseable — ${e.message}`); continue; }

    const { phantoms, ambiguous } = classifySnapshot(snap, stakesAsOf(date), currentStakes);
    if (phantoms.size) {
      phantomDates++;
      phantomPeak = Math.max(phantomPeak, phantoms.size);
      ambiguousPeak = Math.max(ambiguousPeak, ambiguous);
      console.log(`  ${date}: ${phantoms.size} phantom stakers removed (${ambiguous} de-attributed wallets kept — real balances)`);
    }

    const holdersEntry = holdersByDate.get(date);
    if (holdersEntry) {
      const { combined, chainHolders, combinedHolders } = metricsForSnapshot(snap, excluded, phantoms);
      // Some git-committed tel-holders.json blobs are known-empty (e.g. 2026-02-24 —
      // see tasks/todo.md's "pre-2026-03-01 archive is a different measurement regime"
      // note), not a parse failure but a genuinely empty wallets[]. Recomputing from
      // one would overwrite a real, non-empty history entry with zeros — the same
      // failure mode generate-holders-history.js's upsertEntry() already guards
      // against going forward ("Never record empty snapshots ... they create
      // zero-value entries that corrupt every chart they touch"). Skip the whole
      // entry rather than write a fabricated zero-holder day.
      if (combined.holderCount === 0 && holdersEntry.combined?.holderCount > 0) {
        console.warn(`  ${date}: snapshot has 0 holders (known-empty git blob) — skipping snapshot-derived fields`);
        // Still patch the snapshot-independent fields. Skipping them entirely
        // left this date as the only entry in the archive with no cexBalance,
        // which the frontend's `?? 0` fallback then rendered as a ~-18B cliff.
        patchCexOnly(holdersEntry, date, "empty snapshot");
        continue;
      }
      const before = {
        totalHeld: holdersEntry.combined?.totalHeld,
        distributionCount: (holdersEntry.distribution ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0),
      };
      if (holdersEntry.combined) {
        // holderCount / retailHolderCount / totalBalance are DELIBERATELY not
        // written here — see "Two measurement regimes" in the file header.
        // rebuild-history-from-logs.js owns them for every date; a git-committed
        // tel-holders.json scan is a different (and strictly weaker) measurement
        // of the same day, so writing it onto the ~176 snapshot-backed dates while
        // the other ~57 keep their log-replay value interleaved two incompatible
        // series and manufactured up to 5.2B of fake single-day swings.
        //
        // cexBalance is a standalone field (not just a totalHeld ingredient) so
        // the frontend can plot Retail/CEX/DEX as independent series and derive
        // Total client-side, instead of trusting a separately-computed blended
        // number that three different generator scripts can disagree on.
        // Rounded once and reused, same as patchCexOnly above — keep these two
        // in step, or the published `totalBalance + cexBalance + dexLiquidity
        // === totalHeld` invariant drifts by a unit depending on which path a
        // date happened to take.
        const cexBalance = Math.round(cexTotalAsOf(date));
        holdersEntry.combined.cexBalance = cexBalance;
        if (Number.isFinite(holdersEntry.combined.totalHeld)) {
          // Derive from the entry's OWN (log-replay) totalBalance, not the
          // snapshot-derived `combined.totalBalance`, so totalHeld stays
          // consistent with the retail line the chart plots beside it.
          const dex = Number(holdersEntry.combined.dexLiquidity) || 0;
          holdersEntry.combined.totalHeld = Math.round(holdersEntry.combined.totalBalance + cexBalance + dex);
        }
      }
      // distribution/concentration are just as much a function of "which
      // addresses are excluded right now" as the fields above — rebuild them
      // from the same holder lists instead of leaving them frozen at the old
      // classification (see file header).
      if (holdersEntry.distribution) {
        holdersEntry.distribution = buildDistribution(combinedHolders);
      }
      if (holdersEntry.concentration) {
        holdersEntry.concentration = buildConcentrationTop(combinedHolders);
      }
      for (const [key, list] of Object.entries(chainHolders)) {
        const chainEntry = holdersEntry.chains?.[key];
        if (!chainEntry) continue;
        if (chainEntry.distribution) chainEntry.distribution = buildDistribution(list);
        if (chainEntry.concentration) chainEntry.concentration = buildConcentrationTop(list);
      }
      // No holder-count comparison here any more: this script no longer writes
      // holderCount/retailHolderCount (see the block above), so reporting a
      // snapshot-vs-entry difference would name a change that never gets applied.
      if (before.totalHeld !== holdersEntry.combined?.totalHeld) {
        totalHeldChanged++;
        console.log(`  ${date}: totalHeld ${before.totalHeld?.toLocaleString?.() ?? before.totalHeld} -> ${holdersEntry.combined.totalHeld.toLocaleString()}`);
      }
      const afterDistributionCount = (holdersEntry.distribution ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0);
      if (before.distributionCount !== afterDistributionCount) {
        distributionChanged++;
        console.log(`  ${date}: distribution Σcount ${before.distributionCount} -> ${afterDistributionCount}`);
      }

      // newHolders/cumulativeHolders: chronological, CURRENT-classification
      // "wallets that have ever held TEL" running count (see file header) —
      // same bidirectional-correction requirement as every other field above,
      // applied uniformly to every date instead of only going forward.
      if (holdersEntry.newHolders != null || holdersEntry.cumulativeHolders != null) {
        const beforeNew = holdersEntry.newHolders;
        const beforeCumulative = holdersEntry.cumulativeHolders;
        const heldAddrs = extractHeldAddresses(snap, excluded, phantoms);
        let newCount = 0;
        for (const a of heldAddrs) {
          if (!everSeen.has(a)) {
            everSeen.add(a);
            newCount++;
          }
        }
        holdersEntry.newHolders = newCount;
        holdersEntry.cumulativeHolders = everSeen.size;
        latestEverDate = date;
        if (beforeNew !== newCount || beforeCumulative !== everSeen.size) {
          everChanged++;
          console.log(`  ${date}: newHolders ${beforeNew} -> ${newCount}, cumulativeHolders ${beforeCumulative} -> ${everSeen.size}`);
        }
      }
    }

    const cexEntry = cexByDate.get(date);
    if (cexEntry) {
      const before = cexEntry.total;
      const { exchanges, total } = exchangeBalancesForSnapshot(snap, cexWallets);
      cexEntry.exchanges = exchanges;
      cexEntry.total = Math.round(total * 100) / 100;
      if (Math.round(before) !== Math.round(cexEntry.total)) {
        cexChanged++;
        console.log(`  ${date}: total ${before?.toLocaleString?.() ?? before} -> ${cexEntry.total.toLocaleString()}`);
      }
    }
  }
  console.log(`holders-history.json (${holdersHistory.entries?.length ?? 0} dated entries): ${totalHeldChanged} totalHeld values changed, ${distributionChanged} distribution bucket sets changed, ${everChanged} newHolders/cumulativeHolders values changed. holderCount/retailHolderCount/totalBalance are owned by rebuild-history-from-logs.js and are never written here.`);
  console.log(`cex-balance-history.json: ${cexChanged} of ${cexHistory.entries?.length ?? 0} dated entries changed.`);
  console.log(
    `Phantom stakers: ${phantomDates} dates affected, peak ${phantomPeak} removed on a single date; ` +
      `peak ${ambiguousPeak} de-attributed wallets kept as real holders (see scripts/lib/phantomStakers.js — ` +
      `a wallet that genuinely staked then genuinely unstaked is indistinguishable and counts in the removed total).`,
  );
  console.log(`Ever-held set: ${everSeen.size} addresses as of ${latestEverDate ?? "n/a"}.`);

  // distribution was just rebuilt directly from wallets[] above (>=1 TEL
  // floor, per DISTRIBUTION_RANGES), but holderCount still counts sub-1-TEL
  // dust wallets that floor deliberately excludes from any bucket — a real,
  // small, expected gap, not a reclassification artifact. Reconcile folds
  // just that residual into the lowest bucket so holderCount === Σ
  // distribution[].count stays true.
  const reconciled = (holdersHistory.entries ?? []).map((entry) => reconcileHistoryEntry(entry));
  const reconcileFixed = reconciled.filter((e, i) => e !== holdersHistory.entries[i]).length;
  holdersHistory.entries = reconciled;
  console.log(`holders-history.json: reconcileHistoryEntry fixed ${reconcileFixed} entries' distribution counts.`);

  if (dryRun) {
    console.log("--dry-run: nothing written.");
    return;
  }

  holdersHistory.generatedAt = new Date().toISOString();
  await fs.writeFile(HOLDERS_HISTORY_PATH, `${JSON.stringify(holdersHistory, null, 2)}\n`, "utf8");
  console.log(`Wrote ${HOLDERS_HISTORY_PATH}`);

  cexHistory.generatedAt = new Date().toISOString();
  await fs.writeFile(CEX_HISTORY_PATH, `${JSON.stringify(cexHistory, null, 2)}\n`, "utf8");
  console.log(`Wrote ${CEX_HISTORY_PATH}`);

  // Persist the corrected running set so the daily incremental script
  // continues from a correctly-classified baseline instead of the old,
  // CEX-polluted one it would otherwise keep adding to.
  await fs.writeFile(
    EVER_CHECKPOINT_PATH,
    JSON.stringify({
      generatedAt: latestEverDate ?? new Date().toISOString().slice(0, 10),
      cumulativeHolders: everSeen.size,
      addresses: Array.from(everSeen).sort(),
    }),
    "utf8",
  );
  console.log(`Wrote ${EVER_CHECKPOINT_PATH}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
