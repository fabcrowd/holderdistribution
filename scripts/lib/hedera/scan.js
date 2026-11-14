/**
 * Full-network scans of the mirror node, paged by entity id.
 *
 * The id space is cut into fixed ranges; each range is paged sequentially
 * (`gt:<last id>` inside `[lo, hi)`), and ranges run concurrently under the
 * client's rate limiter. A page that still fails after the client's retries
 * rejects the whole scan, so a partial result can never be returned. Finished
 * ranges, and each full page of a range still in progress, are reported through
 * `onProgress`. The next run continues that pinned snapshot only while it is still
 * close to the snapshot a fresh run would use (`resumeStaleReason`): within one
 * drift limit when pinned, within a few hours when unpinned. Anything older is rescanned.
 *
 * mainnet-public load-balances independent mirror clusters (response header
 * `x-cluster-id`), and each writes snapshots on its own grid: a stamp S exists on
 * one cluster only, and the other answers `timestamp=S` with its latest snapshot at
 * or before S. The scan holds S and the cluster that answered it. A non-empty page
 * with any other stamp, or an empty page from another cluster, is a wrong-cluster
 * answer: it is retried until the wall-clock budget runs out, never accepted.
 */
export const HEDERA_PAGE_LIMIT = 100;
/**
 * Ranges paged at once, under the client's 30 rps limiter. Memory is not the limit (about 60 MB rss measured): each lane keeps
 * only its range's rows at or above the floor, as [id, tinybar text], plus a running total of every balance. 8 lanes measured
 * 11 rps, which would not fit a 6 h job.
 */
export const HEDERA_SCAN_CONCURRENCY = 30;
export const HEDERA_RANGE_WIDTH = 250_000;
/** How long one request keeps retrying while the load balancer sends it to the wrong cluster. */
export const HEDERA_SNAPSHOT_WAIT_MS = 20 * 60 * 1000;
const SNAPSHOT_BACKOFF_CAP_MS = 30_000;
/** Resolutions tried for a pinned finished state before it counts as a miss (2 requests each); an unpinned run tries once. */
export const HEDERA_FINISHED_ATTEMPTS = 8;
/** How long the /contracts pass keeps retrying a 404 before it fails the scan. */
export const HEDERA_LIST_404_WAIT_MS = 2 * 60 * 1000;

import { backoffMs } from "../rpcLimiter.js";
import { nanosOf } from "./flowScan.js";

class SnapshotMismatchError extends Error {
  constructor(message, clusterId = null) {
    super(message);
    this.clusterId = clusterId;
  }
}
const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** { body, clusterId } for a GET; a client without getPage (test stubs) reports no cluster. */
const pageOf = async (client, path, passStatus = []) =>
  client.getPage ? client.getPage(path, { passStatus }) : { body: await client.getJson(path), clusterId: null };

/** A pinned snapshot query: a 404 is the answer of a cluster that does not hold the stamp, so it is passed through to be retried. */
const pinnedPageOf = (client, path) => pageOf(client, path, [404]);

const ID_RE = /^0\.0\.([1-9]\d{0,15})$/;
const numOf = (id, what) => {
  const m = typeof id === "string" ? ID_RE.exec(id) : null;
  if (!m) throw new Error(`mirror returned an unexpected ${what} id ${JSON.stringify(id)}`);
  return Number(m[1]);
};

/** Half-open ranges [lo, hi) covering ids 0..maxId. */
export function idRanges(maxId, width) {
  const out = [];
  for (let lo = 0; lo <= maxId; lo += width) out.push({ lo, hi: Math.min(lo + width, maxId + 1) });
  return out;
}

/**
 * Runs `attempt` until it stops throwing SnapshotMismatchError, backing off (capped) between tries. The budget is
 * wall-clock (`retry.waitMs`), counted as the larger of elapsed time and the sum of waits so an injected sleep
 * cannot spin forever. Any other error propagates at once.
 */
async function holdingSnapshot(retry, attempt) {
  const startedAt = retry.now();
  let waited = 0;
  for (let n = 0; ; n += 1) {
    try {
      return await attempt();
    } catch (e) {
      if (!(e instanceof SnapshotMismatchError)) throw e;
      const spent = Math.max(waited, retry.now() - startedAt);
      if (spent >= retry.waitMs) throw new SnapshotMismatchError(`${e.message} (still wrong after ${Math.round(spent / 1000)} s of retrying)`);
      const wait = backoffMs(n, { baseMs: 1000, capMs: SNAPSHOT_BACKOFF_CAP_MS, random: retry.random });
      waited += wait;
      retry.stats.mismatchRetries += 1;
      const who = e.clusterId ?? "unknown";
      retry.stats.byCluster[who] ??= { retries: 0, waitedMs: 0 };
      retry.stats.byCluster[who].retries += 1;
      retry.stats.byCluster[who].waitedMs += wait;
      await retry.sleep(wait);
    }
  }
}

/**
 * Validates one response and returns { rows, next }. `held` is { stamp, cluster } (null for endpoints without a snapshot).
 * A non-empty page must carry the held stamp; the mirror reports timestamp null on an empty page, which proves nothing
 * unless the held cluster sent it. A non-empty page answering the held stamp refreshes the held cluster.
 */
function pageRows({ body, clusterId, status }, { rowsKey, held, label }) {
  if (status === 404) throw new SnapshotMismatchError(`${label}: HTTP 404 from cluster ${clusterId ?? "unknown"}${held ? ` for snapshot ${held.stamp}` : " (a list query never has no answer: a transient mirror fault)"}`, clusterId);
  if (!body || typeof body !== "object" || !Array.isArray(body[rowsKey])) throw new Error(`${label}: response has no ${rowsKey} array`);
  if (!body.links || typeof body.links !== "object" || !("next" in body.links)) {
    throw new Error(`${label}: response has no links object, so the end of the range cannot be told`);
  }
  const rows = body[rowsKey];
  if (held) {
    if (rows.length === 0 && body.timestamp === null) {
      // An empty page proves nothing unless the held cluster sent it; an unknown cluster (no header) never counts.
      if (clusterId === null || clusterId !== held.cluster) {
        throw new SnapshotMismatchError(`${label}: an empty page came from cluster ${clusterId ?? "unknown"}, not the held snapshot's cluster ${held.cluster}; it may not hold snapshot ${held.stamp}`, clusterId);
      }
    } else if (body.timestamp !== held.stamp) {
      throw new SnapshotMismatchError(`${label}: snapshot moved from ${held.stamp} to ${body.timestamp} mid-scan (cluster ${clusterId}); the pages are no longer one moment`, clusterId);
    } else if (rows.length > 0 && clusterId) {
      held.cluster = clusterId;
    }
  }
  return { rows, next: body.links.next };
}

/**
 * Pages one range to its end and returns mapped rows in id order (`mapRow` may return undefined to drop a row).
 * A range is complete only when a final probe (`gt:<last id>`, limit 1, same filters and timestamp) comes back
 * empty from the held cluster, so a short page, a null `next`, or an empty page with rows behind it can never
 * pass as the end.
 */
async function pageRange(client, { path, rowsKey, idParam, idField, params, lo, hi, held, mapRow, label, snapshotExists = null, retry, start = null, onPage = null }) {
  // `start` is a page already accepted on a previous run. Its first `count` rows are copied so the caller's checkpoint is
  // not mutated; rows past `count` were pushed after that page was saved and are fetched again.
  const rows = start ? start.rows.slice(0, start.count).map((row) => [...row]) : [];
  let op = start?.op ?? "gte";
  let cursor = start?.from ?? lo;
  let previous = start?.previous ?? lo - 1;
  const url = (limit, cursorOp, from) =>
    `${path}?${[`limit=${limit}`, "order=asc", ...params, `${idParam}=${cursorOp}:0.0.${from}`, `${idParam}=lt:0.0.${hi}`].join("&")}`;
  const fetchPage = (limit, cursorOp, from) =>
    holdingSnapshot(retry, async () => pageRows(await pinnedPageOf(client, url(limit, cursorOp, from)), { rowsKey, held, label }));
  for (;;) {
    const { rows: page, next } = await fetchPage(HEDERA_PAGE_LIMIT, op, cursor);
    for (const row of page) {
      const num = numOf(row[idField], label);
      if (num <= previous || num >= hi) throw new Error(`${label}: id 0.0.${num} out of order or outside [${lo}, ${hi})`);
      previous = num;
      const mapped = mapRow(row, num);
      if (mapped !== undefined) rows.push(mapped);
    }
    // The live mirror also sends next null on a full page when nothing follows it, so a full page without
    // next is not an error by itself: the confirming probe below decides whether the range really ended.
    if (page.length === HEDERA_PAGE_LIMIT && next) {
      op = "gt";
      cursor = previous;
      // A full page is a safe resume point. The short page that ends a range is not saved until the probe passes.
      // `rows` is the live array (copying it per page is quadratic); `count` marks how much of it this cursor covers.
      onPage?.({ op, from: cursor, previous, count: rows.length, rows });
      continue;
    }
    if (next && page.length < HEDERA_PAGE_LIMIT) throw new Error(`${label}: short page of ${page.length} rows with a next link in [${lo}, ${hi})`);
    const after = previous >= lo ? { op: "gt", from: previous } : { op: "gte", from: lo };
    const probe = (await fetchPage(1, after.op, after.from)).rows;
    if (probe.length > 0) throw new Error(`${label}: range [${lo}, ${hi}) ended early; the mirror still has rows after 0.0.${after.from}`);
    // An empty answer is also what a timestamp with no snapshot returns, so prove the snapshot has accounts at all.
    if (held && snapshotExists) await snapshotExists();
    return rows;
  }
}

/**
 * Returns the body of a query pinned to the held stamp once it answers that stamp with accounts. An unknown timestamp
 * answers 200 with an empty page: from the held cluster that means the snapshot lists no accounts (rejects); from
 * another cluster, or with another stamp, it is a wrong-cluster answer and is retried.
 */
async function requireSnapshot(client, held, retry, extra = "") {
  return holdingSnapshot(retry, async () => {
    const { body, clusterId, status } = await pinnedPageOf(client, `/balances?limit=1${extra}&timestamp=${held.stamp}`);
    if (status === 404) throw new SnapshotMismatchError(`hedera /balances: HTTP 404 from cluster ${clusterId ?? "unknown"} for snapshot ${held.stamp}`, clusterId);
    if (Array.isArray(body?.balances) && body.balances.length > 0 && body.timestamp === held.stamp) {
      if (clusterId) held.cluster = clusterId;
      return body;
    }
    if (Array.isArray(body?.balances) && body.balances.length === 0 && body.timestamp === null && clusterId !== null && clusterId === held.cluster) {
      throw new Error(`hedera /balances: snapshot ${held.stamp} lists no accounts (got timestamp ${body?.timestamp}); empty ranges cannot be trusted`);
    }
    throw new SnapshotMismatchError(`hedera /balances: asked for snapshot ${held.stamp}, cluster ${clusterId} answered ${body?.timestamp}`, clusterId);
  });
}

/** Runs `worker(range)` over all ranges with bounded concurrency; the first failure stops new work and rejects. */
async function runRanges(ranges, concurrency, worker) {
  let next = 0;
  let failure = null;
  const lane = async () => {
    while (!failure && next < ranges.length) {
      const range = ranges[next];
      next += 1;
      try {
        await worker(range);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, lane));
  if (failure) throw failure;
}

/** Version of the saved scan state; a state of another version is unusable (see `resumeProblem`). */
export const HEDERA_SCAN_STATE_VERSION = 2;
const RAW_RE = /^\d+$/;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isTally = (t) => isPlainObject(t) && typeof t.allRaw === "string" && RAW_RE.test(t.allRaw) && Number.isInteger(t.nonzero) && t.nonzero >= 0;

/** Why a checkpoint cannot be resumed with this floor/width, or null when it can. Shape and version only; whether an in-progress state is too old is `resumeStaleReason`. */
export function resumeProblem(resume, { floor, width }) {
  if (!isPlainObject(resume)) return "checkpoint is malformed";
  if (resume.version !== HEDERA_SCAN_STATE_VERSION) return `unknown checkpoint version ${resume.version}`;
  if (resume.floor !== String(floor)) return `floor ${resume.floor} differs from ${floor}`;
  if (resume.width !== width) return `range width ${resume.width} differs from ${width}`;
  if (typeof resume.timestamp !== "string" || !Number.isInteger(resume.maxId) || !isPlainObject(resume.ranges) || !isPlainObject(resume.totals) || !isPlainObject(resume.open)) {
    return "checkpoint is malformed";
  }
  if (!Number.isFinite(Number(resume.timestamp.split(".")[0]))) return `snapshot age is not a number (timestamp ${JSON.stringify(resume.timestamp)})`;
  for (const lo of Object.keys(resume.ranges)) if (!Array.isArray(resume.ranges[lo]) || !isTally(resume.totals[lo])) return "checkpoint is malformed";
  for (const [lo, cur] of Object.entries(resume.open)) {
    const start = Number(lo);
    if (!Number.isInteger(start) || start % width !== 0 || lo in resume.ranges) return "checkpoint is malformed";
    if (!isPlainObject(cur) || (cur.op !== "gt" && cur.op !== "gte") || !Number.isInteger(cur.from) || !Number.isInteger(cur.previous) || !Array.isArray(cur.rows)) return "checkpoint is malformed";
    if (!Number.isInteger(cur.count) || cur.count < 0 || cur.count > cur.rows.length || !isTally(cur)) return "checkpoint is malformed";
  }
  // `complete` marks a finished scan; an in-progress state has no such field. A finished state must hold every range and no open one.
  if (resume.complete !== undefined) {
    if (resume.complete !== true || Object.keys(resume.open).length > 0) return "checkpoint is malformed";
    if (idRanges(resume.maxId, width).some((r) => !(r.lo in resume.ranges))) return "checkpoint is malformed";
  }
  return null;
}

// Mirror balance snapshots are ~15 min apart (902 s measured, see settle.js) and each cluster resolves "newest at or
// before the pin end", so two resolutions of the same pin differ by at most one snapshot interval, whichever cluster
// grid answers. 1800 s is twice that: jitter and one skipped snapshot fit, a previous night's state (~86,400 s older
// than the snapshot a fresh run resolves) does not. The limit is measured between two snapshot stamps, never against
// the pin end or the wall clock, so a mirror that lags near midnight cannot make a same-night state stale.
export const HEDERA_RESUME_PINNED_MAX_DRIFT_SECONDS = 1800;
// A same-run resume is at most the scan step (120 min) plus the retry step (35 min), the whole job is capped at
// 270 min and the schedule is daily, so 6 h keeps every same-run resume and excludes any earlier night.
export const HEDERA_RESUME_UNPINNED_MAX_AGE_SECONDS = 21600;
const NANOS_PER_SECOND = 1_000_000_000n;
const STAMP_RE = /^\d+(\.\d+)?$/;

/**
 * Why an in-progress saved scan state is too old to resume, or null when it may be resumed. Finished states
 * (`complete: true`), a missing state and a stamp this function cannot read are not its business (null: the age rule
 * is skipped and the state is handled as it was before this rule existed). `freshStamp` is the snapshot a fresh run resolved just now (a mirror
 * "seconds.nanos" stamp). Pinned: stale when the state is more than HEDERA_RESUME_PINNED_MAX_DRIFT_SECONDS older
 * than it (a state later than it, from the other cluster's grid, is fine). Unpinned: stale when more than
 * HEDERA_RESUME_UNPINNED_MAX_AGE_SECONDS older than the newest snapshot. Limits are inclusive. The text completes
 * the sentence "saved in-progress scan state at <stamp> is <reason>".
 */
export function resumeStaleReason(resume, { freshStamp, pinned }) {
  if (!resume || resume.complete === true) return null;
  if (!STAMP_RE.test(String(resume.timestamp)) || !STAMP_RE.test(String(freshStamp))) return null;
  const older = nanosOf(freshStamp) - nanosOf(resume.timestamp);
  const limit = pinned ? HEDERA_RESUME_PINNED_MAX_DRIFT_SECONDS : HEDERA_RESUME_UNPINNED_MAX_AGE_SECONDS;
  if (older <= BigInt(limit) * NANOS_PER_SECOND) return null;
  const seconds = older / NANOS_PER_SECOND;
  return pinned
    ? `${seconds}s older than the snapshot a fresh scan would use, ${freshStamp} (limit ${limit}s)`
    : `${(Number(seconds) / 3600).toFixed(1)}h older than the newest snapshot ${freshStamp} (limit ${limit / 3600}h), and no pin is available`;
}

/**
 * One consistent snapshot of every account holding at least `floor` tinybar.
 * The snapshot is asked for once (the newest at or before "now") and its stamp and answering cluster are held; every
 * page is pinned to the stamp. The floor is applied here, from unfiltered pages: the server-side `account.balance`
 * filter is applied before the mirror picks each account's latest row, so it can return a stale balance. Every row,
 * below the floor and contracts included, is added to a per-range total, so the whole snapshot can be checked
 * against total supply without keeping the dust.
 * A `resume` checkpoint that does not fit (other floor/width, malformed) rejects. An in-progress state is first
 * compared with the snapshot a fresh run resolves (one attempt, `atOrBefore` when pinned, else the newest): if it is
 * more than the limit older (`resumeStaleReason`) it is dropped and the scan starts on the stamp just resolved
 * (`resumeDropped` holds the reason, `onResumeDropped(reason, { savedStamp, freshStamp })` fires before any paging);
 * otherwise it is resumed as given and its cluster is learned from the first response answering its stamp.
 * A finished checkpoint (`complete: true`) is different: the stamp this run resolves (newest at or before `atOrBefore`,
 * else the newest) must equal its stamp and highest id, and then the rows are served with no paging. Otherwise it is
 * discarded and a fresh scan runs (`finishedState: "discarded"`); it is never served as an older snapshot.
 * Returns { timestamp, maxId, rows: [[num, tinybarString]], allRaw (BigInt), nonzero, mismatchRetries } in id order.
 */
export async function scanBalanceSnapshot(
  client,
  {
    floor,
    width = HEDERA_RANGE_WIDTH,
    concurrency = HEDERA_SCAN_CONCURRENCY,
    resume = null,
    onProgress = null,
    nowMs = Date.now,
    sleep = sleepReal,
    random = Math.random,
    snapshotWaitMs = HEDERA_SNAPSHOT_WAIT_MS,
    // A mirror "seconds.nanos" stamp: pin the newest snapshot at or before it instead of the newest one.
    atOrBefore = null,
    // Called once, before any paging, when an in-progress state is dropped as stale.
    onResumeDropped = null,
  },
) {
  const floorText = String(floor);
  const floorRaw = BigInt(floor);
  if (floorRaw <= 0n) throw new Error(`hedera floor ${floorText} must be positive`);
  const retry = { sleep, random, now: nowMs, waitMs: snapshotWaitMs, stats: { mismatchRetries: 0, byCluster: {} } };
  let state;
  let held;
  const progress = () => ({ ...state, ranges: { ...state.ranges }, totals: { ...state.totals }, open: { ...state.open } });
  // "reused": a finished state served with no paging; "discarded": one that no longer matches the stamp this run resolves.
  let finishedState = null;
  if (resume) {
    const problem = resumeProblem(resume, { floor, width });
    if (problem) throw new Error(`hedera resume checkpoint unusable: ${problem}`);
  }
  // With no timestamp the mirror reports "now", which is not a snapshot. Asking at that time resolves to a
  // real snapshot on the cluster that answers; its stamp and cluster are held, and asking for the stamp by
  // name must answer with itself.
  const resolveHead = async () => {
    const target = atOrBefore ? `lte:${atOrBefore}` : (await pageOf(client, "/balances?limit=1&order=desc")).body.timestamp;
    if (!target) throw new Error("hedera /balances returned no timestamp");
    const resolved = await pageOf(client, `/balances?limit=1&order=desc&timestamp=${target}`);
    if (!resolved.body.balances?.length || !resolved.body.timestamp) throw new Error("hedera /balances returned no snapshot");
    held = { stamp: resolved.body.timestamp, cluster: resolved.clusterId };
    const answer = await requireSnapshot(client, held, retry, "&order=desc");
    return { head: answer, maxId: numOf(answer.balances[0].account, "balances") };
  };
  const freshState = (maxId) => ({ version: HEDERA_SCAN_STATE_VERSION, timestamp: held.stamp, maxId, floor: floorText, width, ranges: {}, totals: {}, open: {} });
  let resumeDropped = null;
  if (resume && !resume.complete) {
    // Resolve what a fresh run would use (one attempt) BEFORE adopting the saved stamp: a saved state is only as
    // good as its distance from that snapshot, not from the pin end or the clock.
    const inProgressFresh = await resolveHead();
    resumeDropped = resumeStaleReason(resume, { freshStamp: held.stamp, pinned: Boolean(atOrBefore) });
    if (resumeDropped) {
      onResumeDropped?.(resumeDropped, { savedStamp: resume.timestamp, freshStamp: held.stamp });
      state = freshState(inProgressFresh.maxId);
    } else {
      state = {
        version: resume.version,
        timestamp: resume.timestamp,
        maxId: resume.maxId,
        floor: resume.floor,
        width: resume.width,
        ranges: { ...resume.ranges },
        totals: { ...resume.totals },
        open: { ...resume.open },
      };
      held = { stamp: state.timestamp, cluster: null };
      await requireSnapshot(client, held, retry, "&order=desc");
    }
  } else {
    const matchesFinished = (maxId) => resume?.complete === true && resume.timestamp === held.stamp && resume.maxId === maxId;
    // Pinned finished state: the clusters write snapshots on their own grids, so which stamp "newest at or before the pin"
    // resolves to depends on the cluster that answers. The saved stamp is right if ANY attempt resolves exactly to it
    // (same stamp and highest id); a bounded number of attempts decides a miss. An unpinned run is newest-wins: one attempt.
    const attempts = resume?.complete && atOrBefore ? HEDERA_FINISHED_ATTEMPTS : 1;
    let resolvedHead = await resolveHead();
    for (let n = 1; n < attempts && !matchesFinished(resolvedHead.maxId); n += 1) {
      await sleep(backoffMs(n - 1, { baseMs: 500, capMs: 5000, random }));
      resolvedHead = await resolveHead();
    }
    const { head, maxId } = resolvedHead;
    // A finished scan is served only for the very stamp (and highest id) this run resolved; any other stamp is an old snapshot.
    const sameSnapshot = matchesFinished(maxId);
    if (resume?.complete) finishedState = sameSnapshot ? "reused" : "discarded";
    state = sameSnapshot
      ? { version: resume.version, timestamp: resume.timestamp, maxId, floor: resume.floor, width: resume.width, ranges: { ...resume.ranges }, totals: { ...resume.totals }, open: {}, complete: true }
      : freshState(maxId);
  }
  // One check per scan is enough: whether a snapshot exists does not change.
  let existence = null;
  const snapshotExists = () => (existence ??= requireSnapshot(client, held, retry));
  const allRanges = idRanges(state.maxId, width);
  const todo = allRanges.filter((r) => !(r.lo in state.ranges));
  await runRanges(todo, concurrency, async ({ lo, hi }) => {
    const start = state.open[lo] ?? null;
    let allRaw = start ? BigInt(start.allRaw) : 0n;
    let nonzero = start?.nonzero ?? 0;
    const rows = await pageRange(client, {
      path: "/balances",
      rowsKey: "balances",
      idParam: "account.id",
      idField: "account",
      params: [`timestamp=${state.timestamp}`],
      lo,
      hi,
      held,
      label: "hedera /balances",
      snapshotExists,
      retry,
      start,
      onPage: (cursor) => {
        state.open[lo] = { ...cursor, allRaw: String(allRaw), nonzero };
        onProgress?.(progress());
      },
      mapRow: (row, num) => {
        const raw = BigInt(row.balance);
        if (raw < 0n) throw new Error(`hedera /balances: 0.0.${num} has a negative balance ${row.balance}`);
        if (raw > 0n) {
          allRaw += raw;
          nonzero += 1;
        }
        return raw >= floorRaw ? [num, String(row.balance)] : undefined;
      },
    });
    delete state.open[lo];
    state.ranges[lo] = rows;
    state.totals[lo] = { allRaw: String(allRaw), nonzero };
    // The last range landing marks the state finished; no other lane is paging then, so no later in-progress report can follow.
    if (allRanges.every((r) => r.lo in state.ranges)) state.complete = true;
    onProgress?.(progress());
  });
  const ranges = idRanges(state.maxId, width);
  const rows = ranges.flatMap((r) => state.ranges[r.lo]);
  const allRaw = ranges.reduce((sum, r) => sum + BigInt(state.totals[r.lo].allRaw), 0n);
  const nonzero = ranges.reduce((sum, r) => sum + state.totals[r.lo].nonzero, 0);
  return {
    timestamp: state.timestamp,
    maxId: state.maxId,
    rows,
    allRaw,
    nonzero,
    mismatchRetries: retry.stats.mismatchRetries,
    waitByCluster: retry.stats.byCluster,
    clusterId: held.cluster,
    finishedState,
    resumeDropped,
  };
}

/**
 * One account's tinybar balance in the held snapshot `stamp` (as a BigInt; 0 when the snapshot has no row for it).
 * Answers from another cluster's grid are retried, like every pinned page.
 */
export async function balanceAtSnapshot(client, { id, stamp, cluster, sleep = sleepReal, random = Math.random, nowMs = Date.now, snapshotWaitMs = HEDERA_SNAPSHOT_WAIT_MS }) {
  const held = { stamp, cluster };
  const retry = { sleep, random, now: nowMs, waitMs: snapshotWaitMs, stats: { mismatchRetries: 0, byCluster: {} } };
  const { rows } = await holdingSnapshot(retry, async () =>
    pageRows(await pinnedPageOf(client, `/balances?account.id=${id}&timestamp=${stamp}`), { rowsKey: "balances", held, label: `hedera /balances ${id}` }),
  );
  return BigInt(rows[0]?.balance ?? 0);
}

/** Ids of every contract up to `maxId`. The mirror's balance rows do not say account vs contract; this list does. */
export async function scanContractIds(client, { maxId, width = HEDERA_RANGE_WIDTH, concurrency = HEDERA_SCAN_CONCURRENCY }) {
  const byRange = new Map();
  // A list endpoint answers 200 with an empty list, never 404; one 404 in a 66-minute run is a transient mirror fault (seen live 2026-11-13), so it is retried briefly.
  const retry = { sleep: sleepReal, random: Math.random, now: Date.now, waitMs: HEDERA_LIST_404_WAIT_MS, stats: { mismatchRetries: 0, byCluster: {} } };
  await runRanges(idRanges(maxId, width), concurrency, async ({ lo, hi }) => {
    byRange.set(
      lo,
      await pageRange(client, {
        path: "/contracts",
        rowsKey: "contracts",
        idParam: "contract.id",
        idField: "contract_id",
        params: [],
        lo,
        hi,
        held: null,
        label: "hedera /contracts",
        retry,
        mapRow: (_row, num) => num,
      }),
    );
  });
  return new Set(idRanges(maxId, width).flatMap((r) => byRange.get(r.lo)));
}
