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
  const live = stamped && Array.isArray(json.asOf.live) ? [...json.asOf.live] : [];
  const settled = stamped ? json.asOf.settled !== false : null;
  return { name, endDate, rawLastDate, generatedAt: json?.generatedAt ?? null, stamped, blocks, blockSource, settled, live };
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
 * Chains any feed lists in asOf.live are left out of the block comparison
 * ("live chain: block comparison skipped").
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

  for (const c of [...liveChains].sort()) skipped.push(`${c} blocks: live chain: block comparison skipped`);
  // A checkpoint lastBlock is a scan head, not a day cutoff: report it, never compare it.
  const comparable = feeds.filter((f) => f.blockSource !== "checkpoint");
  for (const f of feeds.filter((x) => x.blockSource === "checkpoint")) {
    for (const [c, b] of Object.entries(f.blocks ?? {})) info.push(`${f.name}: ${c} scan head ${b} (checkpoint, not a day cutoff): not compared`);
  }
  const chains = [...new Set(comparable.flatMap((f) => Object.keys(f.blocks ?? {})))].filter((c) => !liveChains.has(c)).sort();
  const blockSpread = {};
  for (const c of chains) {
    const vals = comparable.filter((f) => f.blocks?.[c] != null).map((f) => ({ name: f.name, b: f.blocks[c] }));
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
