#!/usr/bin/env node
/**
 * append-exchange-flows-from-cache.js
 *
 * Extends public/data/exchange-flow-history.json to the present by replaying
 * the local data/rebuild-transfers-<chain>.ndjson caches, instead of scanning
 * eth_getLogs.
 *
 * WHY THIS EXISTS
 *
 * scan-exchange-flows.js walks blocks with eth_getLogs, which the Alchemy FREE
 * tier caps at a 10-BLOCK range per request (scripts/lib/rpc.js re-issues a
 * wider request as serial 10-block sub-chunks). Catching up a week measured at
 * ~96,000 requests for this artifact alone. The same tail read through
 * alchemy_getAssetTransfers took 44 requests — see extend-transfer-caches.js,
 * which tops the caches up and must be run first.
 *
 * Nothing about the flow numbers depends on logs specifically: the
 * classification only needs {from, to, value, blockNumber} plus the CEX and DEX
 * address sets, which is exactly what the caches store. This mirrors
 * scan-exchange-flows.js's own classification block verbatim (deposit vs
 * withdrawal, DEX in/out, the CEX-counterparty exclusion) so both paths produce
 * the same shape.
 *
 * TAIL-ONLY, BY DATE — deliberately not a full rebuild
 *
 * Only the last existing date and everything after it is (re)derived, because a
 * full replay would silently DROP six months of real history: the artifact
 * starts 2025-06-28 but public/data/date-blocks.json only reaches back to
 * 2026-01-01, and the result would still look like a successful rebuild.
 *
 * The last existing date is REPLACED, not skipped. scan-exchange-flows.js stops
 * at whatever block its checkpoint reached, which is normally mid-day, so its
 * final entry covers only part of that date and understates it — measured at
 * 2026-08-21, the stored entry held 64.0M of the day's real 104.1M inflow (the
 * scan reached eth block 25,803,690 of a day ending ~25,806,900). Left alone
 * that partial day would stay wrong forever, since every later run only ever
 * appends after it.
 *
 * Replacement, never accumulation, is also what makes re-running safe:
 * scan-exchange-flows.js seeds its day buckets from the existing history and
 * `+=`s into them, so a script that re-derived a present date additively would
 * double-count it. This one overwrites the bucket outright.
 *
 * Verified exact: derived vs stored for 2026-08-17 through 2026-08-20 (four
 * fully-scanned days) matched to 0.0% on in/out/dexIn/dexOut.
 *
 * Requires ENV_PASSPHRASE (RPC, only to resolve new date boundaries).
 *
 * Run: node scripts/append-exchange-flows-from-cache.js [--dry-run]
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import { getUsableRpcUrls, rpcCall } from "./lib/rpc.js";
import { normalizeAddress } from "./lib/nonRetailSet.js";
import { findBlockAtTime } from "./lib/historicalReplay.js";
import {
  selectPipelineProject,
  projectPaths,
  projectChains,
  projectWork,
  projectWorkDir,
  projectClassificationPath,
} from "./lib/projects.js";
import { exchangeFlowChains } from "./lib/exchangeFlowChains.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: the project's
// data dir, chain map, CEX/DEX lists and transfer caches (TEL: public/data/ +
// data/rebuild-transfers-<chain>.ndjson; others: public/data/<slug>/ + data/<slug>/).
const project = selectPipelineProject("append-exchange-flows-from-cache", { ported: true });

await loadEnv();

const ROOT = process.cwd();
const data = projectPaths(project, ROOT);
const HISTORY_PATH = data("exchange-flow-history.json");
const DATE_BLOCKS_PATH = data("date-blocks.json");
const work = projectWork(project, ROOT);
const cachePath = (chainKey) => work(`rebuild-transfers-${chainKey}.ndjson`);

// Same table scan-exchange-flows.js scans (TEL: ethereum, polygon, base; divisor 100).
const FLOW_CHAINS = exchangeFlowChains(project, projectChains(project, ROOT), process.env);
const CHAIN_KEYS = Object.keys(FLOW_CHAINS);
const MAX_SANE_TEL = 2 * (Number(project.config?.supply?.target) || 100e9); // same guard scan-exchange-flows.js applies

const dryRun = process.argv.includes("--dry-run");

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

/** UTC date string for a unix-ms instant. */
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

const main = async () => {
  const history = await readJson(HISTORY_PATH);
  const dateBlocks = await readJson(DATE_BLOCKS_PATH);
  const entries = history.entries ?? [];
  if (entries.length === 0) throw new Error("exchange-flow-history.json has no entries — refusing to guess a start.");

  const lastDate = entries[entries.length - 1].date;
  // Start AT the last stored date, not after it — see the header: that entry is
  // normally a partial day and gets replaced with the complete one.
  // Yesterday, not today: a partial current day would be written as if final,
  // then never revisited (this script only ever appends dates after the last).
  const endDate = isoDate(Date.now() - 86_400_000);
  if (endDate <= lastDate) {
    console.log(`Already current: history ends ${lastDate}, target end ${endDate}. Nothing to do.`);
    return;
  }

  const wanted = [];
  for (let t = Date.parse(`${lastDate}T00:00:00Z`); t <= Date.parse(`${endDate}T00:00:00Z`); t += 86_400_000) {
    wanted.push(isoDate(t));
  }
  console.log(`History ends ${lastDate}; deriving ${wanted.length} date(s): ${wanted[0]}..${wanted[wanted.length - 1]} (first replaces a likely-partial day)`);

  // --- 1. Resolve each new date's start block per chain, extending date-blocks.
  for (const chainKey of CHAIN_KEYS) {
    const known = dateBlocks[chainKey] ?? {};
    const rpcUrls = await getUsableRpcUrls(chainKey);
    if (rpcUrls.length === 0) throw new Error(`${chainKey}: no RPC URLs (is ENV_PASSPHRASE set?)`);
    const rpcUrl = rpcUrls[0];

    const knownDates = Object.keys(known).sort();
    let low = known[knownDates[knownDates.length - 1]];
    const head = Number.parseInt(await rpcCall(rpcUrl, "eth_blockNumber", []), 16);

    const getTimestamp = async (block) =>
      Number.parseInt((await rpcCall(rpcUrl, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false]))?.timestamp, 16);

    // Resolve one day PAST the range too: a day's bucket is [boundary(d),
    // boundary(d+1)), so without the upper edge the final day would absorb
    // every later transfer.
    const needed = [...wanted, isoDate(Date.parse(`${wanted[wanted.length - 1]}T00:00:00Z`) + 86_400_000)];
    for (const date of needed) {
      if (known[date] != null) continue;
      const block = await findBlockAtTime(Date.parse(`${date}T00:00:00Z`) / 1000, { low, high: head, getTimestamp });
      if (block == null) {
        console.log(`  ${chainKey} ${date}: boundary not resolvable — stopping this chain here.`);
        break;
      }
      known[date] = block;
      low = block;
    }
    dateBlocks[chainKey] = known;
    console.log(`  ${chainKey}: date-blocks now covers through ${Object.keys(known).sort().pop()}`);
  }

  // --- 2. Stream each cache, bucketing transfers into the new dates.
  const { cexSet, dexSet } = await loadFlowSets();
  const buckets = new Map(); // date -> { in, out, dexIn, dexOut, chains }
  const firstWantedMs = Date.parse(`${wanted[0]}T00:00:00Z`);

  for (const chainKey of CHAIN_KEYS) {
    const known = dateBlocks[chainKey] ?? {};
    // Ascending [block, date] for the dates we are deriving, so a transfer's
    // date is the last boundary at or below its block.
    const bounds = wanted
      .filter((d) => known[d] != null)
      .map((d) => ({ block: known[d], date: d }))
      .sort((a, b) => a.block - b.block);
    // Exclusive upper edge, so the last day is a real day rather than
    // "everything from here on".
    const endBoundary = known[isoDate(Date.parse(`${wanted[wanted.length - 1]}T00:00:00Z`) + 86_400_000)] ?? Infinity;
    if (bounds.length === 0) {
      console.log(`  ${chainKey}: no resolved boundaries — skipping.`);
      continue;
    }
    const startBlock = bounds[0].block;

    let scanned = 0;
    let matched = 0;
    const rl = createInterface({ input: createReadStream(cachePath(chainKey)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const block = Number.parseInt(rec.blockNumber, 16);
      if (!Number.isFinite(block) || block < startBlock || block >= endBoundary) continue;
      scanned += 1;

      const fromAddr = normalizeAddress(rec.from ?? "");
      const toAddr = normalizeAddress(rec.to ?? "");
      const fromCex = fromAddr && cexSet.has(fromAddr);
      const toCex = toAddr && cexSet.has(toAddr);
      const fromDex = fromAddr && dexSet.has(fromAddr);
      const toDex = toAddr && dexSet.has(toAddr);
      if (!fromCex && !toCex && !fromDex && !toDex) continue;

      const value = Number(BigInt(rec.value ?? "0")) / FLOW_CHAINS[chainKey].divisor;
      if (!Number.isFinite(value) || value <= 0 || value > MAX_SANE_TEL) continue;

      // Last boundary at or below this block.
      let date = null;
      for (let i = bounds.length - 1; i >= 0; i--) {
        if (block >= bounds[i].block) {
          date = bounds[i].date;
          break;
        }
      }
      if (!date) continue;

      const bucket = buckets.get(date) ?? { in: 0, out: 0, dexIn: 0, dexOut: 0, chains: {} };
      const cb = bucket.chains[chainKey] ?? { in: 0, out: 0, dexIn: 0, dexOut: 0 };
      // Verbatim from scan-exchange-flows.js so both paths agree by construction.
      if (toCex && !fromCex) { bucket.in += value; cb.in += value; matched++; }
      else if (fromCex && !toCex) { bucket.out += value; cb.out += value; matched++; }
      if (toDex && !fromDex && !fromCex) { bucket.dexIn += value; cb.dexIn += value; matched++; }
      else if (fromDex && !toDex && !toCex) { bucket.dexOut += value; cb.dexOut += value; matched++; }
      bucket.chains[chainKey] = cb;
      buckets.set(date, bucket);
    }
    console.log(`  ${chainKey}: ${scanned.toLocaleString()} cached transfers in range, ${matched} classified`);
  }

  // --- 3. Emit entries in the same shape scan-exchange-flows.js writes.
  const newEntries = wanted
    .filter((date) => buckets.has(date))
    .map((date) => {
      const b = buckets.get(date);
      return {
        date,
        chains: b.chains,
        in: b.in,
        out: b.out,
        net: b.in - b.out,
        dexIn: b.dexIn,
        dexOut: b.dexOut,
        dexNet: b.dexIn - b.dexOut,
      };
    });

  if (newEntries.length === 0) {
    console.log("No classifiable flows in the new date range — writing nothing.");
    return;
  }
  for (const e of newEntries) {
    console.log(`  ${e.date}: in ${Math.round(e.in).toLocaleString()} out ${Math.round(e.out).toLocaleString()} net ${Math.round(e.net).toLocaleString()}`);
  }

  if (dryRun) {
    console.log("--dry-run: nothing written.");
    return;
  }

  // Replace any existing entry for a derived date (the partial tail), then append.
  const derivedDates = new Set(newEntries.map((e) => e.date));
  history.entries = [...entries.filter((e) => !derivedDates.has(e.date)), ...newEntries]
    .sort((a, b) => a.date.localeCompare(b.date));
  history.generatedAt = new Date().toISOString();
  // Records how the tail was produced, so a later reader can tell these dates
  // came from the cached replay rather than the live scan.
  history.backfills = {
    ...(history.backfills ?? {}),
    cachedTransferAppend: {
      at: new Date().toISOString(),
      dates: newEntries.map((e) => e.date),
      source: `${projectWorkDir(project)}/rebuild-transfers-<chain>.ndjson via alchemy_getAssetTransfers`,
    },
  };
  await fs.writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`);
  await fs.writeFile(DATE_BLOCKS_PATH, `${JSON.stringify(dateBlocks, null, 2)}\n`);
  console.log(`Wrote ${newEntries.length} entries; history now ${history.entries.length} through ${history.entries[history.entries.length - 1].date}.`);
};

/**
 * CEX and DEX address sets, built exactly as scan-exchange-flows.js:203-217
 * builds them — from config/cex-wallets.json's `wallets[]` and
 * config/dex-contracts.json's `pools[]`, as two SEPARATE sets.
 *
 * Deliberately not loadNonRetailSet(): that returns one merged non-retail set
 * (exclusions + CEX + DEX, 27,323 addresses). The flow classification needs to
 * tell a CEX leg from a DEX leg — a deposit is not a swap — so a merged set
 * cannot express it.
 */
const loadFlowSets = async () => {
  const cexPath = projectClassificationPath(project, "cexWallets", ROOT);
  const dexPath = projectClassificationPath(project, "dexContracts", ROOT);
  if (!cexPath) throw new Error(`project ${project.slug} declares no classification.cexWallets — no flows to classify.`);
  const cexConfig = JSON.parse(await fs.readFile(cexPath, "utf8"));
  const cexSet = new Set(
    (cexConfig.wallets ?? [])
      .map((w) => (typeof w.address === "string" ? w.address.trim().toLowerCase() : null))
      .filter(Boolean),
  );
  let dexSet = new Set();
  try {
    if (!dexPath) throw Object.assign(new Error("no DEX list declared"), { code: "ENOENT" });
    const dexConfig = JSON.parse(await fs.readFile(dexPath, "utf8"));
    dexSet = new Set(
      (dexConfig.pools ?? [])
        .map((p) => (typeof p.address === "string" ? p.address.trim().toLowerCase() : null))
        .filter(Boolean),
    );
  } catch {
    // Same optional treatment scan-exchange-flows.js gives it.
  }
  if (cexSet.size === 0) throw new Error("CEX set is empty — refusing to write flows that would all read as zero.");
  console.log(`Sets: ${cexSet.size} CEX, ${dexSet.size} DEX addresses`);
  return { cexSet, dexSet };
};

await main();
