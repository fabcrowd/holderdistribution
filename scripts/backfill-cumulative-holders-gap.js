#!/usr/bin/env node
/**
 * backfill-cumulative-holders-gap.js
 *
 * Fills `cumulativeHolders` / `newHolders` on the holders-history rows that were
 * reconstructed by `pull-holders-rpc.js --as-of` (2026-08-22..09-09), which ship
 * without those two fields because they cannot be derived from a single day's
 * snapshot — the metric is a running set ("wallets that have ever held TEL").
 *
 * THE SEED IS THE WHOLE PROBLEM. Two lineages of that running set exist:
 *
 *   - the daily incremental one in public/data/holders-ever-checkpoint.json, and
 *   - the log-replay one written by rebuild-history-from-logs.js, which is what
 *     the committed history rows actually carry.
 *
 * The checkpoint blob committed ON 2026-08-21 predates that rebuild (105,305
 * addresses) and disagrees with the 2026-08-21 history row (114,888) by ~9,500.
 * Seeding a backfill from it produces a 9.5k cliff down and back up — an
 * artifact of the seed, not adoption. The blob committed the NEXT day
 * (SEED_COMMIT below) is the post-rebuild one: 114,893 addresses, still dated
 * 2026-08-21, and exactly the 114,888 of the history row plus the five escrow
 * vaults that backfill-escrow-vault-reclassification.js later removed from the
 * set. Dropping those five reproduces the row's number exactly, which is what
 * makes this seed provably the right lineage rather than a plausible one.
 *
 * Membership follows rebuild-history-from-logs.js: at each date boundary an
 * address counts if it is not in the current non-retail set and holds a positive
 * balance on any chain, after Polygon staking attribution. Balances come from
 * the same anchored replay --as-of uses (anchor checkpoint + cached Transfer
 * logs), so the set is consistent with the holderCount already published for
 * these days.
 *
 * Run: node scripts/backfill-cumulative-holders-gap.js [--dry-run]
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { loadNonRetailSet, normalizeAddress } from "./lib/nonRetailSet.js";
import { readCommittedJson } from "./lib/holdersAsOfReplay.js";
import { residualCustodyBalance } from "./lib/stakingCustody.js";

const ROOT = process.cwd();
const HISTORY_PATH = path.resolve(ROOT, "public/data/holders-history.json");
const BLOCKS_PATH = path.resolve(ROOT, "data/holders-asof-blocks.json");
const EVER_CHECKPOINT_PATH = path.resolve(ROOT, "public/data/holders-ever-checkpoint.json");
const ANCHOR_DATE = "2026-08-21";
const STAKING_CONTRACT = "0x92e43aec69207755cb1e6a8dc589aae630476330";
const MIN_TEL_RAW = 1n;
const DRY_RUN = process.argv.includes("--dry-run");

// Post-rebuild ever-checkpoint, committed 2026-08-22, dated 2026-08-21.
const SEED_COMMIT = "5de26bbaa47d1ff0a4b02aba550389549264eb1b";
// Removed from the ever-set by backfill-escrow-vault-reclassification.js.
const ESCROW_VAULTS = [
  "0x60b1f621736fa7091bad2dc20c0467083f010f57",
  "0xd6040319acdc191e485b2e103b9b4405ea8a30b0",
  "0x222d9b3875d7c37d5037896d9b8b0fb3a19180bf",
  "0x043a163912c680dd2b490b409e8d4ad399e97bf8",
  "0x9184aae0983e5ffbe06e41ca13c24033857b56cb",
];

/**
 * The tel-holders.json committed FOR that exact date, or null. A point-in-time
 * scan sees wallets an end-of-day replay cannot: one that received TEL and sent
 * it on within the same day held it, and "has ever held" must count it. So on a
 * date that has a real snapshot, both sources are unioned.
 */
const snapshotForDate = (date) => {
  try {
    const snapshot = readCommittedJson("public/data/tel-holders.json", date);
    return snapshot?.source?.snapshotDate === date ? snapshot : null;
  } catch {
    return null;
  }
};

const walletAddresses = (snapshot) => {
  const chainKeys = Object.keys(snapshot.chains ?? {});
  const out = [];
  for (const wallet of snapshot.wallets ?? []) {
    const address = normalizeAddress(wallet?.address);
    if (!address) continue;
    if (!chainKeys.some((k) => Number(wallet?.[`${k}_balance`]) > 0)) continue;
    out.push(address);
  }
  return out;
};

const main = async () => {
  const history = JSON.parse(await fs.readFile(HISTORY_PATH, "utf8"));
  const blocks = JSON.parse(await fs.readFile(BLOCKS_PATH, "utf8"));
  const dates = Object.keys(blocks).sort();
  const { set: nonRetail } = await loadNonRetailSet();

  const seedRaw = JSON.parse(
    execFileSync("git", ["show", `${SEED_COMMIT}:public/data/holders-ever-checkpoint.json`], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
    }),
  );
  const everSet = new Set(seedRaw.addresses.map((a) => a.toLowerCase()));
  for (const vault of ESCROW_VAULTS) everSet.delete(vault);
  const anchorRow = history.entries.find((e) => e.date === ANCHOR_DATE);
  if (everSet.size !== anchorRow?.cumulativeHolders) {
    throw new Error(
      `Seed check failed: ${everSet.size} addresses vs the ${ANCHOR_DATE} row's ` +
        `${anchorRow?.cumulativeHolders}. Refusing to write a different lineage.`,
    );
  }
  console.log(`Seed: ${everSet.size} addresses at ${ANCHOR_DATE} (matches the committed row).`);

  const anchor = readCommittedJson("public/data/holders-checkpoint.json", ANCHOR_DATE);
  const chainKeys = Object.keys(anchor.chains);

  // date -> address -> raw balance, replayed forward one chain at a time.
  const balancesByDate = new Map(dates.map((d) => [d, new Map()]));
  for (const chainKey of chainKeys) {
    const anchorChain = anchor.chains[chainKey];
    // Deltas bucketed by date: balances are additive, so within-day ordering is
    // irrelevant and the ~6M-row Polygon cache never has to be held in memory.
    const deltas = new Map(dates.map((d) => [d, new Map()]));
    const rl = createInterface({
      input: createReadStream(path.resolve(ROOT, `data/rebuild-transfers-${chainKey}.ndjson`)),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      const row = JSON.parse(line);
      const block = parseInt(row.blockNumber, 16);
      if (block <= anchorChain.lastBlock) continue;
      const date = dates.find((d) => block <= blocks[d][chainKey]);
      if (!date) continue;
      const bucket = deltas.get(date);
      const value = BigInt(row.value);
      if (row.to) bucket.set(row.to, (bucket.get(row.to) ?? 0n) + value);
      if (row.from) bucket.set(row.from, (bucket.get(row.from) ?? 0n) - value);
    }
    const running = new Map(
      Object.entries(anchorChain.rawBalances).map(([a, v]) => [a.toLowerCase(), BigInt(v)]),
    );
    for (const date of dates) {
      for (const [address, delta] of deltas.get(date)) {
        running.set(address, (running.get(address) ?? 0n) + delta);
      }
      const dayTotals = balancesByDate.get(date);
      for (const [address, value] of running) {
        if (value < MIN_TEL_RAW) continue;
        dayTotals.set(address, (dayTotals.get(address) ?? 0n) + value);
      }
    }
    console.log(`  ${chainKey}: replayed to ${dates[dates.length - 1]}`);
  }

  // Staking attribution, matching --as-of: the stakers' TEL sits on the contract
  // in the Transfer ledger, so a staker with no liquid TEL is only a holder once
  // it is credited back. Uses the funding-wallets snapshot committed on or before
  // each date, never today's staker set.
  for (const date of dates) {
    const funding = readCommittedJson("public/data/funding-wallets.json", date);
    const dayTotals = balancesByDate.get(date);
    let attributed = 0;
    for (const { fundingWallet, stakedAmount } of funding?.wallets ?? []) {
      const address = normalizeAddress(fundingWallet);
      if (!address || !Number.isFinite(stakedAmount) || stakedAmount <= 0) continue;
      const raw = BigInt(Math.round(stakedAmount * 100));
      dayTotals.set(address, (dayTotals.get(address) ?? 0n) + raw);
      attributed += stakedAmount;
    }
    const custody = Number(dayTotals.get(STAKING_CONTRACT) ?? 0n) / 100;
    if (custody > 0) {
      const residual = residualCustodyBalance(custody, attributed);
      dayTotals.set(STAKING_CONTRACT, BigInt(Math.round(residual * 100)));
    }
  }

  const byDate = new Map();
  for (const date of dates) {
    let added = 0;
    for (const [address, value] of balancesByDate.get(date)) {
      if (value <= 0n || nonRetail.has(address) || everSet.has(address)) continue;
      everSet.add(address);
      added++;
    }
    const snapshot = snapshotForDate(date);
    for (const address of snapshot ? walletAddresses(snapshot) : []) {
      if (nonRetail.has(address) || everSet.has(address)) continue;
      everSet.add(address);
      added++;
    }
    byDate.set(date, { cumulative: everSet.size, added });
  }

  // Dates after the replay window keep their own snapshots as the source, so the
  // running set stays continuous through to today rather than ending at 09-09.
  const lastReplayDate = dates[dates.length - 1];
  for (const entry of history.entries) {
    if (entry.date <= lastReplayDate) continue;
    const snapshot = readCommittedJson("public/data/tel-holders.json", entry.date);
    let added = 0;
    for (const address of walletAddresses(snapshot)) {
      if (nonRetail.has(address) || everSet.has(address)) continue;
      everSet.add(address);
      added++;
    }
    byDate.set(entry.date, { cumulative: everSet.size, added });
  }

  // The committed values for dates inside and after the window came from the
  // DAILY INCREMENTAL path, which only ever saw the days the pipeline actually
  // ran: a wallet that appeared and left between two runs was never counted.
  // A continuous daily replay finds those, so the computed series must come out
  // at or above every committed value — below would mean the replay LOST
  // addresses, which is the failure worth refusing to write.
  const regressions = [];
  for (const entry of history.entries) {
    const computed = byDate.get(entry.date);
    if (!computed || typeof entry.cumulativeHolders !== "number") continue;
    const delta = computed.cumulative - entry.cumulativeHolders;
    console.log(`  ${entry.date}: committed ${entry.cumulativeHolders} -> ${computed.cumulative} (${delta >= 0 ? "+" : ""}${delta})`);
    if (delta < 0) regressions.push(`${entry.date}: ${computed.cumulative} < committed ${entry.cumulativeHolders}`);
  }
  for (const date of dates) {
    const c = byDate.get(date);
    console.log(`  ${date}: cumulative ${c.cumulative} (+${c.added})`);
  }
  if (regressions.length) {
    throw new Error(`${regressions.length} date(s) lost addresses — not writing:\n  ${regressions.join("\n  ")}`);
  }
  const liveEver = JSON.parse(await fs.readFile(EVER_CHECKPOINT_PATH, "utf8"));
  const missing = liveEver.addresses.filter((a) => !everSet.has(a.toLowerCase()));
  if (missing.length) {
    throw new Error(`Recomputed set drops ${missing.length} address(es) the live checkpoint holds — not writing.`);
  }

  // newHolders is a difference against the PREVIOUS row in the file, so filling
  // the gap changes it for the first row after each gap too: what used to be
  // "new since 2026-08-21" is now "new since 2026-08-27".
  let filled = 0;
  let renumbered = 0;
  let previousCumulative = null;
  for (const entry of history.entries) {
    const computed = byDate.get(entry.date);
    if (computed && entry.cumulativeHolders !== computed.cumulative) {
      entry.cumulativeHolders = computed.cumulative;
      filled++;
    }
    const cumulative = entry.cumulativeHolders;
    // Only inside the window this script owns. Earlier rows carry their own
    // newHolders from whichever rebuild produced them, and 20 of them already
    // disagree with their own cumulative delta — an older interleaving of
    // lineages that is not this change's to rewrite.
    if (typeof cumulative === "number" && previousCumulative !== null && entry.date >= dates[0]) {
      const newHolders = cumulative - previousCumulative;
      if (entry.newHolders !== newHolders) {
        entry.newHolders = newHolders;
        renumbered++;
      }
    }
    if (typeof cumulative === "number") previousCumulative = cumulative;
  }

  console.log(`\nFilled ${filled} row(s); recomputed newHolders on ${renumbered} row(s).`);
  if (DRY_RUN) {
    console.log("--dry-run: nothing written.");
    return;
  }
  await fs.writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  console.log(`Wrote ${HISTORY_PATH}`);

  // The daily pipeline continues from this file, so it has to carry the merged
  // set — otherwise tomorrow's run re-adds today's "missing" wallets as new.
  const latestDate = history.entries[history.entries.length - 1]?.date;
  await fs.writeFile(
    EVER_CHECKPOINT_PATH,
    JSON.stringify({
      generatedAt: latestDate,
      cumulativeHolders: everSet.size,
      addresses: [...everSet].sort(),
    }),
    "utf8",
  );
  console.log(`Wrote ${EVER_CHECKPOINT_PATH} (${everSet.size} addresses)`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
