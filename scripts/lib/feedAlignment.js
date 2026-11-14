/**
 * Feed alignment: does every published feed of a project end at the same
 * settled day (and, where known, the same per-chain block)?
 *
 * Pure: callers pass parsed JSON; nothing here reads files.
 *
 * Settled end date of a feed:
 *   - asOf.date when the feed carries asOf (target convention).
 *   - otherwise the last row that is not partial. A row is partial when it
 *     says so (partial: true / partialDate), or when it is dated on/after the
 *     feed's generatedAt UTC day (an intraday snapshot of an unfinished day).
 * Blocks: asOf.blocks, else a checkpoint's chains.<c>.lastBlock (marked
 * source "checkpoint": a scan head, not a day cutoff).
 */

import { isComparableStamp } from "./cexFlows.js";

const day = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null);
const prevDate = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function lastSettledRow(rows, genDay) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (!r?.date || r.partial === true) continue;
    if (genDay && r.date >= genDay) continue;
    return r.date;
  }
  return null;
}

/** Normalised summary of one feed. `checkpoint` is the matching checkpoint JSON, if any. */
export function summarizeFeed(name, json, checkpoint = null) {
  const genDay = day(json?.generatedAt);
  let endDate = null;
  let rawLastDate = null;
  let blocks = null;
  let blockSource = null;
  // An asOf with date null is still a stamp: the writer declined to claim a day (incomplete scan).
  const stamped = json?.asOf != null && typeof json.asOf === "object";

  if (stamped) {
    endDate = json.asOf.date ?? null;
    rawLastDate = endDate;
    if (json.asOf.blocks) {
      blocks = { ...json.asOf.blocks };
      blockSource = "asOf";
    }
  } else if (Array.isArray(json?.entries)) {
    rawLastDate = json.entries.at(-1)?.date ?? null;
    endDate = lastSettledRow(json.entries, genDay);
  } else if (json?.latestDate) {
    rawLastDate = json.latestDate;
    const partial = json.partialDate === json.latestDate || (genDay && json.latestDate >= genDay);
    endDate = partial ? prevDate(json.latestDate) : json.latestDate;
  } else if (genDay) {
    // Snapshot feed (holders-lite): state at generatedAt, so the last settled day is the one before.
    rawLastDate = genDay;
    endDate = prevDate(genDay);
  }

  if (!blocks && checkpoint?.chains) {
    const b = {};
    for (const [c, v] of Object.entries(checkpoint.chains)) if (Number.isInteger(v?.lastBlock)) b[c] = v.lastBlock;
    if (Object.keys(b).length) {
      blocks = b;
      blockSource = "checkpoint";
    }
  }
  // Unpinned chains (read at head because their settled block was unavailable) are
  // not at a settled block either, so they are left out of block comparison like live ones.
  const live = stamped
    ? [...new Set([...(Array.isArray(json.asOf.live) ? json.asOf.live : []), ...(Array.isArray(json.asOf.unpinned) ? json.asOf.unpinned : [])])]
    : [];
  const noBlock = stamped && Array.isArray(json.asOf.noBlock) ? [...json.asOf.noBlock] : [];
  const settled = stamped ? json.asOf.settled !== false : null;
  return { name, endDate, rawLastDate, generatedAt: json?.generatedAt ?? null, stamped, blocks, blockSource, settled, live, noBlock };
}

/**
 * Compares feed summaries. Fails when settled end dates differ, or when two
 * feeds that both carry asOf blocks for a chain differ by more than
 * blockTolerance. Checkpoint-sourced blocks (scan heads) are listed in `info`,
 * never compared. Unstamped feeds and `missing` expected feeds are warnings
 * unless `strict`.
 * A feed stamped asOf.settled === false is read at run time (live chain, e.g.
 * Solana): its date is the run day, so it may sit up to 1 day past the
 * settled feeds. Beyond that it is a warning, a problem under `strict`.
 * A chain a feed lists in asOf.live is left out of the block comparison for
 * that feed only; settled feeds carrying a block for it (e.g. Solana flow
 * feeds stamped with their settled slot) are still compared with each other.
 * A stamp with asOf.noBlock (a chain without a recorded block) is a warning,
 * a problem under `strict`.
 */
const LIVE_DATE_TOLERANCE_DAYS = 1;
const dayDiff = (a, b) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export function compareFeeds(feeds, { blockTolerance = 0, strict = false, missing = [] } = {}) {
  const problems = [];
  const warnings = [];
  const skipped = [];
  const info = [];
  for (const name of missing) (strict ? problems : warnings).push(`missing feed: ${name}`);
  const liveChains = new Set(feeds.flatMap((f) => f.live ?? []));
  for (const f of feeds) if (f.settled === false && f.live?.length) skipped.push(`${f.name}: live chain: block comparison skipped (${f.live.join(", ")})`);
  const dated = feeds.filter((f) => f.endDate && f.settled !== false);
  const endDates = [...new Set(dated.map((f) => f.endDate))].sort();
  if (endDates.length > 1) {
    problems.push(`end dates differ: ${dated.map((f) => `${f.name}=${f.endDate}`).join(", ")}`);
  }
  const allDated = feeds.filter((f) => f.endDate);
  for (const f of allDated.filter((x) => x.settled === false)) {
    const others = allDated.filter((x) => x !== f);
    const worst = Math.max(0, ...others.map((x) => dayDiff(f.endDate, x.endDate)));
    if (worst > LIVE_DATE_TOLERANCE_DAYS) {
      const msg = `${f.name}: live feed date differs by ${worst} days (> ${LIVE_DATE_TOLERANCE_DAYS}): ${[f, ...others].map((x) => `${x.name}=${x.endDate}`).join(", ")}`;
      (strict ? problems : warnings).push(msg);
    }
  }
  for (const f of feeds) if (!f.endDate) problems.push(`${f.name}: no settled end date`);

  // A stamp that names a chain without a recorded block cannot be block-compared.
  for (const f of feeds) {
    if (f.noBlock?.length) (strict ? problems : warnings).push(`${f.name}: no block recorded for ${f.noBlock.join(", ")} (asOf.noBlock)`);
  }
  for (const c of [...liveChains].sort()) skipped.push(`${c} blocks: live feeds skipped; settled feeds with a ${c} block are still compared`);
  // A checkpoint lastBlock is a scan head, not a day cutoff: report it, never compare it.
  const comparable = feeds.filter((f) => f.blockSource !== "checkpoint");
  for (const f of feeds.filter((x) => x.blockSource === "checkpoint")) {
    for (const [c, b] of Object.entries(f.blocks ?? {})) info.push(`${f.name}: ${c} scan head ${b} (checkpoint, not a day cutoff): not compared`);
  }
  // A chain a feed lists as live is skipped for that feed only; feeds that
  // carry a settled block for it (e.g. stamped Solana flow feeds) still compare.
  const chains = [...new Set(comparable.flatMap((f) => Object.keys(f.blocks ?? {})))].sort();
  const blockSpread = {};
  for (const c of chains) {
    const vals = comparable.filter((f) => f.blocks?.[c] != null && !(f.live ?? []).includes(c)).map((f) => ({ name: f.name, b: f.blocks[c] }));
    if (vals.length < 2) continue;
    const min = Math.min(...vals.map((v) => v.b));
    const max = Math.max(...vals.map((v) => v.b));
    blockSpread[c] = max - min;
    if (max - min > blockTolerance) {
      problems.push(`${c} blocks differ by ${max - min} (> ${blockTolerance}): ${vals.map((v) => `${v.name}=${v.b}`).join(", ")}`);
    }
  }

  const unstamped = feeds.filter((f) => !f.stamped).map((f) => f.name);
  if (unstamped.length) (strict ? problems : warnings).push(`unstamped (no asOf): ${unstamped.join(", ")}`);

  return { ok: problems.length === 0, endDates, blockSpread, problems, warnings, skipped, info };
}

const CHAIN_COVERAGE_LOOKBACK_DAYS = 30;

const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Gate for cex-flows.json: its recorded comparison must name two ordered,
 * comparable snapshots exactly one day apart, and (where a transaction-level
 * exchange-flow-history row exists for the same day) its net must match that row.
 *
 * The structural part fails (it only checks what our own writer stamps, and
 * lib/cexFlows.js uses the same snapshotComparison). The amount part is a WARNING
 * only: it compares two independently produced feeds and they legitimately
 * diverge when the exchange wallet list changes (balances jump with no
 * transfers; no feed carries a reliable list-change stamp: cex-flows
 * `listUpdatedAt` is the run time, so only changelog dates are passed in), when
 * the history scans fewer chains than the balances cover, and for rebasing or
 * fee-on-transfer tokens, whose balances move without matching transfers. This
 * gate runs before the nightly commit, so a failure would cost the night's data.
 *
 * Amount rule: a token's balance moves only through transfers, so the balance
 * delta of the tracked wallets equals the day's transfer net up to rounding: the
 * history row rounds `in` and `out` to whole tokens (net error <= 1 token), so the
 * caller passes `tolerance` = 2 x the representable unit. The rule does not hold,
 * and is skipped with a reason, when: the asset is native (fees and staking rewards
 * move balances without transfers), the snapshot is read live (its window is
 * run-time to run-time, not the history row's calendar day), the history row is
 * partial or absent, or the wallet list changed that day (`walletSetChangeDates`:
 * the two feeds may then use different lists).
 *
 * Returns { problems, warnings, checks }.
 */
export function checkCexFlowsWindow(cex, flowHistory, { tolerance, nativeAsset = false, walletSetChangeDates = [] } = {}) {
  const out = { problems: [], warnings: [], checks: [] };
  if (!cex?.overall) return out;
  const cmp = cex.comparison;
  if (!cmp) {
    out.warnings.push("cex-flows has no comparison stamp (written before the previous/current asOf were recorded): window unverified until the next nightly rewrites it");
  } else {
    const cur = cmp.current;
    const prev = cmp.previous;
    if (cex.asOf?.date && cur?.date !== cex.asOf.date) {
      out.problems.push(`cex-flows comparison.current.date ${cur?.date ?? "(none)"} != asOf.date ${cex.asOf.date}`);
    }
    if (cmp.available === true) {
      if (!isComparableStamp(cur) || !isComparableStamp(prev)) {
        out.problems.push(`cex-flows compares snapshots that are not both settled/comparable: previous ${JSON.stringify(prev?.date ?? null)} (unpinned: ${prev?.unpinned?.length ?? 0}), current ${JSON.stringify(cur?.date ?? null)} (unpinned: ${cur?.unpinned?.length ?? 0})`);
      } else if (!(prev.date < cur.date)) {
        out.problems.push(`cex-flows previous asOf ${prev.date} is not before current asOf ${cur.date}`);
      } else if (nextDay(prev.date) !== cur.date) {
        out.problems.push(`cex-flows claims a one-day flow but compares ${prev.date} -> ${cur.date}`);
      } else {
        out.checks.push(`cex-flows compares settled snapshots ${prev.date} -> ${cur.date}`);
      }
    } else if (typeof cmp.reason !== "string" || cmp.reason === "") {
      out.problems.push("cex-flows comparison.available is false with no reason");
    } else {
      const o = cex.overall;
      if (o.net !== 0 || o.inflow !== 0 || o.outflow !== 0 || o.previousBalance !== o.currentBalance) {
        out.problems.push(`cex-flows has no comparison (${cmp.reason}) but still reports a delta (net ${o.net}, previous ${o.previousBalance}, current ${o.currentBalance})`);
      } else {
        out.checks.push(`cex-flows carries no comparison (${cmp.reason}); deltas read zero`);
      }
      return out;
    }
    if (out.problems.length) return out;
  }

  // Amount cross-check against the transaction-level feed for the same day.
  const date = cmp?.current?.date ?? cex.asOf?.date;
  const skip = (reason) => {
    out.checks.push(`cex-flows net not compared with exchange-flow-history${date ? `[${date}]` : ""}: ${reason}`);
    return out;
  };
  if (nativeAsset) return skip("native asset (fees and staking rewards move balances without transfers)");
  if (!date) return skip("cex-flows carries no day");
  if (cex.asOf?.settled === false) return skip("snapshot read live (its window is not the history row's calendar day)");
  const row = (flowHistory?.entries ?? []).find((e) => e?.date === date);
  if (!row) return skip("no exchange-flow-history row for that day");
  if (row.partial === true) return skip("the history row is partial");
  if (!Number.isFinite(row.net)) return skip("the history row has no net");
  if (walletSetChangeDates.some((d) => d === date || d === nextDay(date))) {
    return skip("the exchange wallet list changed that day");
  }
  // A row lists only chains with transfers, so what the history currently scans is
  // the union over its recent rows; the cex balances sum every chain the holder
  // snapshot covers. A chain with no transfers for the whole lookback is treated as
  // not scanned: the check is a warning, so skipping errs on the quiet side.
  const earliest = new Date(Date.parse(`${date}T00:00:00Z`) - CHAIN_COVERAGE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const dayRows = (flowHistory?.entries ?? []).filter((e) => typeof e?.date === "string" && e.date >= earliest && e.date <= date);
  const scanned = new Set(dayRows.flatMap((e) => Object.keys(e?.chains ?? {})));
  const noHistory = Object.keys(cex.asOf?.blocks ?? {}).filter((c) => !scanned.has(c));
  // The feed itself proves a chain contributes nothing when its exchange balances are
  // exactly 0 in both snapshots; absent, null or non-finite data proves nothing.
  const provenZero = (c) => {
    const b = cex.overall.byChain?.[c];
    return b?.previousBalance === 0 && b?.currentBalance === 0;
  };
  const unscanned = noHistory.filter((c) => !provenZero(c));
  if (unscanned.length) return skip(`the history has no rows for ${unscanned.join(", ")}, which the exchange balances include`);
  for (const c of noHistory) out.checks.push(`${c}: exchange wallets hold none in either snapshot, counted as zero`);
  const diff = Math.abs(cex.overall.net - row.net);
  if (diff > tolerance) {
    out.warnings.push(`cex-flows net ${Math.round(cex.overall.net).toLocaleString()} differs from exchange-flow-history[${date}] net ${row.net.toLocaleString()} by ${Math.round(diff).toLocaleString()} (tolerance ${tolerance}): the two feeds are produced independently; check for a wallet-list change, a rebasing or fee-on-transfer token, or a chain the history does not scan`);
  } else {
    out.checks.push(`cex-flows net agrees with exchange-flow-history[${date}] (${row.net.toLocaleString()})`);
  }
  return out;
}
