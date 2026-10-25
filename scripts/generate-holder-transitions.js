#!/usr/bin/env node
/**
 * generate-holder-transitions.js
 *
 * Builds tier-to-tier transition matrices for the distribution flow diagram:
 * of the wallets in balance-tier X at the start of each timeframe, which tier
 * are they in now? Tracks the SAME address across snapshots (from the git
 * archive), so it shows real wallet movement between tiers — the visible
 * symptom of holders growing, shrinking, or splitting positions.
 *
 * NOT proof of intra-owner splitting (that needs the transfer graph) — a
 * wallet moving down a tier means its balance fell, by any cause.
 *
 * Output: public/data/holder-transitions.json
 *   { generatedAt, latestDate, ranges: { "<days|ytd>": { from, to, matrix } } }
 *   matrix[fromTier][toTier] = { count, tel }  (movers only; tel = current total)
 *
 * Reads PAST snapshots from the committed git history of tel-holders.json +
 * funding-wallets.json (so baselines work in CI with no RPC), but reads the
 * CURRENT ("to") snapshot straight off disk. This step runs in the same CI
 * job as pull-holders-rpc.js, before that job's own commit step — so at the
 * time this runs, today's freshly-pulled snapshot exists on disk but isn't
 * in git history yet. Resolving "latest" via git (as this used to) meant the
 * "to" boundary was always one full day stale, silently missing every
 * transition that happened on the most recent day. Excludes exchange wallets
 * (a hot wallet isn't a retail tier), matching the distribution methodology.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadNonRetailSet } from "./lib/nonRetailSet.js";
import { selectPipelineProject, projectPaths, projectNonRetailPaths } from "./lib/projects.js";
import { projectHolderTiers, rangeLabelOf } from "./lib/holderTiers.js";
import { normalizeAnyAddress } from "./lib/address.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: the project's
// data dir (on disk and in git history) and its own non-retail lists. Tier
// RANGES are the project's `holders.distributionTiers` (TEL: the historical 10
// buckets, unchanged) — see docs/MULTI-TOKEN.md.
const project = selectPipelineProject("generate-holder-transitions", { ported: true });
const data = projectPaths(project);

const OUT_PATH = data("holder-transitions.json");
const TEL_HOLDERS_PATH = data("tel-holders.json");
const FUNDING_WALLETS_PATH = data("funding-wallets.json");
const HOLDERS_HISTORY_PATH = data("holders-history.json");
// Repo-relative paths for git-history reads (TEL: public/data/<file>).
const SNAP_REL = data.rel("tel-holders.json");
const FUND_REL = data.rel("funding-wallets.json");

const RANGES = projectHolderTiers(project).distributionTiers;
const bucketOf = (v) => rangeLabelOf(RANGES, v);

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

const commitsByDate = (file) => {
  const out = git(["log", "--format=%H %ad", "--date=short", "--", file]);
  const map = new Map();
  for (const line of out.trim().split("\n")) {
    const [h, d] = line.split(" ");
    if (h && d && !map.has(d)) map.set(d, h);
  }
  return map;
};

const showJson = (commit, file) => JSON.parse(git(["show", `${commit}:${file}`]));

const main = async () => {
  const { set: excl, sizes } = await loadNonRetailSet(projectNonRetailPaths(project));
  console.log(
    `Non-retail set: ${sizes.total} addresses ` +
      `(exclusions ${sizes.exclusions}, CEX config ${sizes.cex}, DEX config ${sizes.dex}).`,
  );

  const snapCommits = commitsByDate(SNAP_REL);
  const fundCommits = commitsByDate(FUND_REL);
  const snapDates = [...snapCommits.keys()].sort();
  const fundDates = [...fundCommits.keys()].sort();
  if (snapDates.length === 0) { console.warn("No snapshots."); return; }

  const nearestOnOrBefore = (dates, target) => {
    let best = null;
    for (const d of dates) { if (d <= target) best = d; else break; }
    if (best == null) {
      // No snapshot exists on or before the target date (e.g. a shallow
      // clone whose git history doesn't reach that far back) — every
      // window silently collapses onto the earliest available date instead
      // of the intended baseline. Warn so that's discoverable without
      // having to re-derive it from the artifact's own from/to fields.
      console.warn(`  nearestOnOrBefore: no snapshot on/before ${target}; falling back to earliest available (${dates[0]}).`);
      return dates[0];
    }
    return best;
  };

  // Aggregates one tel-holders.json + funding-wallets.json pair (whatever
  // their source) into a per-wallet balance map, combined ACROSS chains by
  // address — matching the "Combined" tier methodology used everywhere else
  // (the KPI hero, the distribution table, generate-tier-outflows.js). This
  // used to key by `${chain}:${address}`, so a wallet bridging its TEL from
  // one chain to another vanished from its old per-chain key (bucketOf(0) →
  // skipped) and reappeared as a brand-new "wallet" under the new chain key
  // (no baseline entry → also skipped) — completely invisible to the
  // transitions matrix despite its combined tier genuinely changing.
  const aggregateBalances = (snap, fund) => {
    const bal = new Map();
    for (const chain of Object.values(snap.chains ?? {})) {
      for (const h of chain.holders ?? []) {
        const a = normalizeAnyAddress(h.address ?? "");
        if (!a || excl.has(a)) continue;
        bal.set(a, (bal.get(a) ?? 0) + Number(h.balance ?? 0));
      }
    }
    for (const w of fund.wallets ?? []) {
      const a = normalizeAnyAddress(w.fundingWallet ?? "");
      const s = Number(w.stakedAmount ?? 0);
      if (!a || s <= 0 || excl.has(a)) continue;
      bal.set(a, (bal.get(a) ?? 0) + s);
    }
    return bal;
  };

  const balancesAt = (date) => {
    const sd = nearestOnOrBefore(snapDates, date);
    const snap = showJson(snapCommits.get(sd), SNAP_REL);
    const fd = nearestOnOrBefore(fundDates, date);
    const fund = fd ? showJson(fundCommits.get(fd), FUND_REL) : { wallets: [] };
    return { bal: aggregateBalances(snap, fund), snapshotDate: (snap.source ?? {}).snapshotDate ?? sd };
  };

  const readOptionalJson = async (p) => {
    try { return JSON.parse(await fs.readFile(p, "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  };

  // Prefer the on-disk snapshot for the CURRENT balances — it reflects this
  // run's just-pulled data, which git history won't see until this job's
  // later commit step. Falls back to the last git-committed snapshot only if
  // the on-disk file is somehow missing (e.g. run outside the normal job).
  const onDiskSnap = await readOptionalJson(TEL_HOLDERS_PATH);
  const onDiskFund = (await readOptionalJson(FUNDING_WALLETS_PATH)) ?? { wallets: [] };
  const today = new Date().toISOString().slice(0, 10);
  const { b1, toDate } = onDiskSnap
    ? { b1: aggregateBalances(onDiskSnap, onDiskFund), toDate: (onDiskSnap.source ?? {}).snapshotDate ?? today }
    : (() => {
        const latest = snapDates[snapDates.length - 1];
        const r = balancesAt(latest);
        return { b1: r.bal, toDate: r.snapshotDate };
      })();
  const latestMs = Date.parse(toDate);
  const ytdCandidate = `${new Date(latestMs).getUTCFullYear()}-01-01`;
  // Clamp to holders-history.json's own earliest entry so this generator's
  // "ytd" window can't reach further back than what pickBaseline (the
  // frontend's shared baseline resolver) can ever match against
  // holders-history — otherwise the transitions tick count and the
  // holders-history net describe two different windows even though the UI
  // places them side by side. holders-history.json is generally shallower
  // than tel-holders.json's own git history (this script's other source),
  // so this only ever pulls ytdStart forward, never back.
  const holdersHistory = await readOptionalJson(HOLDERS_HISTORY_PATH);
  const holdersHistoryEarliest = Array.isArray(holdersHistory?.entries) && holdersHistory.entries.length > 0
    ? holdersHistory.entries.map((e) => e.date).filter(Boolean).sort()[0]
    : null;
  const ytdStart = holdersHistoryEarliest && holdersHistoryEarliest > ytdCandidate
    ? holdersHistoryEarliest
    : ytdCandidate;
  // Includes "1" so this matches tier-outflows.json's window set — the
  // frontend's transitionsKeyFor/outflowsKeyFor both need a "1" key to
  // resolve consistently for the 1D view (see useHolderTransitions.ts).
  const windows = { "1": 1, "7": 7, "30": 30, "90": 90, "365": 365, ytd: null };

  const ranges = {};
  for (const [key, days] of Object.entries(windows)) {
    const startDate = days == null ? ytdStart : new Date(latestMs - days * 86400000).toISOString().slice(0, 10);
    const { bal: b0, snapshotDate: fromDate } = balancesAt(startDate);
    const matrix = {};
    const keys = new Set([...b0.keys(), ...b1.keys()]);
    for (const k of keys) {
      const fb = bucketOf(b0.get(k) ?? 0);
      const tb = bucketOf(b1.get(k) ?? 0);
      if (!fb || !tb || fb === tb) continue;
      (matrix[fb] ??= {});
      const cell = (matrix[fb][tb] ??= { count: 0, tel: 0 });
      cell.count += 1;
      cell.tel += b1.get(k) ?? 0;
    }
    for (const fb of Object.keys(matrix))
      for (const tb of Object.keys(matrix[fb])) matrix[fb][tb].tel = Math.round(matrix[fb][tb].tel);
    ranges[key] = { from: fromDate, to: toDate, matrix };
  }

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), latestDate: toDate, ranges }, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUT_PATH} (${Object.keys(ranges).length} ranges)`);
};

main().catch((e) => { console.error(e); process.exit(1); });
