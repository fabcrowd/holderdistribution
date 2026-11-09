/**
 * Full-network scans of the mirror node, paged by entity id.
 *
 * The id space is cut into fixed ranges; each range is paged sequentially
 * (`gt:<last id>` inside `[lo, hi)`), and ranges run concurrently under the
 * client's rate limiter. A page that still fails after the client's retries
 * rejects the whole scan, so a partial result can never be returned. Finished
 * ranges are reported through `onProgress` so a run can resume.
 */
export const HEDERA_PAGE_LIMIT = 100;
export const HEDERA_SCAN_CONCURRENCY = 12;
export const HEDERA_RANGE_WIDTH = 250_000;
/** A checkpoint whose snapshot is older than this is not resumed: its balances would be stale data. */
export const HEDERA_RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;

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

/** Validates one response body and returns { rows, next }. `snapshot` is the held timestamp (null for endpoints without one). */
function pageRows(body, { rowsKey, snapshot, label }) {
  if (!body || typeof body !== "object" || !Array.isArray(body[rowsKey])) throw new Error(`${label}: response has no ${rowsKey} array`);
  if (!body.links || typeof body.links !== "object" || !("next" in body.links)) {
    throw new Error(`${label}: response has no links object, so the end of the range cannot be told`);
  }
  const rows = body[rowsKey];
  // The mirror reports timestamp null (the key present) on an empty page; any non-empty page must come from the held snapshot.
  const emptyPage = rows.length === 0 && body.timestamp === null;
  if (snapshot && !emptyPage && body.timestamp !== snapshot) {
    throw new Error(`${label}: snapshot moved from ${snapshot} to ${body.timestamp} mid-scan; the pages are no longer one moment`);
  }
  return { rows, next: body.links.next };
}

/**
 * Pages one range to its end and returns mapped rows in id order. A range is
 * complete only when a final probe (`gt:<last id>`, limit 1, same filters and
 * timestamp) comes back empty, so a short page, a null `next`, or an empty page
 * with rows behind it can never pass as the end.
 */
async function pageRange(client, { path, rowsKey, idParam, idField, params, lo, hi, snapshot, mapRow, label, snapshotExists = null }) {
  const rows = [];
  let op = "gte";
  let cursor = lo;
  let previous = lo - 1;
  const url = (limit, cursorOp, from) =>
    `${path}?${[`limit=${limit}`, "order=asc", ...params, `${idParam}=${cursorOp}:0.0.${from}`, `${idParam}=lt:0.0.${hi}`].join("&")}`;
  for (;;) {
    const { rows: page, next } = pageRows(await client.getJson(url(HEDERA_PAGE_LIMIT, op, cursor)), { rowsKey, snapshot, label });
    for (const row of page) {
      const num = numOf(row[idField], label);
      if (num <= previous || num >= hi) throw new Error(`${label}: id 0.0.${num} out of order or outside [${lo}, ${hi})`);
      previous = num;
      rows.push(mapRow(row, num));
    }
    // The live mirror also sends next null on a full page when nothing follows it, so a full page without
    // next is not an error by itself: the confirming probe below decides whether the range really ended.
    if (page.length === HEDERA_PAGE_LIMIT && next) {
      op = "gt";
      cursor = previous;
      continue;
    }
    if (next && page.length < HEDERA_PAGE_LIMIT) throw new Error(`${label}: short page of ${page.length} rows with a next link in [${lo}, ${hi})`);
    const after = previous >= lo ? { op: "gt", from: previous } : { op: "gte", from: lo };
    const probe = pageRows(await client.getJson(url(1, after.op, after.from)), { rowsKey, snapshot, label }).rows;
    if (probe.length > 0) throw new Error(`${label}: range [${lo}, ${hi}) ended early; the mirror still has rows after 0.0.${after.from}`);
    // An empty answer is also what a timestamp with no snapshot returns, so prove the snapshot has accounts at all.
    if (snapshot && snapshotExists) await snapshotExists();
    return rows;
  }
}

/** Rejects unless the snapshot at `timestamp` really lists accounts (an unknown timestamp answers 200 with an empty page). */
async function requireSnapshot(client, timestamp) {
  const body = await client.getJson(`/balances?limit=1&timestamp=${timestamp}`);
  if (!Array.isArray(body?.balances) || body.balances.length === 0 || body.timestamp !== timestamp) {
    throw new Error(`hedera /balances: snapshot ${timestamp} lists no accounts (got timestamp ${body?.timestamp}); empty ranges cannot be trusted`);
  }
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

/** Why a checkpoint cannot be resumed with this floor/width/clock, or null when it can. */
export function resumeProblem(resume, { floor, width, nowMs }) {
  if (resume.version !== 1) return `unknown checkpoint version ${resume.version}`;
  if (resume.floor !== String(floor)) return `floor ${resume.floor} differs from ${floor}`;
  if (resume.width !== width) return `range width ${resume.width} differs from ${width}`;
  if (typeof resume.timestamp !== "string" || !Number.isInteger(resume.maxId) || !resume.ranges || typeof resume.ranges !== "object") return "checkpoint is malformed";
  const ageMs = nowMs - Number(resume.timestamp) * 1000;
  if (!Number.isFinite(ageMs)) return `snapshot age is not a number (timestamp ${JSON.stringify(resume.timestamp)})`;
  if (ageMs > HEDERA_RESUME_MAX_AGE_MS) return `snapshot ${resume.timestamp} is ${Math.round(ageMs / 3_600_000)} h old (limit ${HEDERA_RESUME_MAX_AGE_MS / 3_600_000} h)`;
  return null;
}

/**
 * One consistent snapshot of every account holding at least `floor` tinybar.
 * The snapshot timestamp is resolved once to the newest real snapshot and passed
 * explicitly on every page; a page answering with another timestamp rejects the scan.
 * A `resume` checkpoint that does not fit (other floor/width, too old) rejects.
 * Returns { timestamp, maxId, rows: [[num, tinybarString]] } in id order.
 */
export async function scanBalanceSnapshot(
  client,
  { floor, width = HEDERA_RANGE_WIDTH, concurrency = HEDERA_SCAN_CONCURRENCY, resume = null, onProgress = null, nowMs = Date.now },
) {
  const floorText = String(floor);
  let state;
  if (resume) {
    const problem = resumeProblem(resume, { floor, width, nowMs: nowMs() });
    if (problem) throw new Error(`hedera resume checkpoint unusable: ${problem}`);
    state = { ...resume, ranges: { ...resume.ranges } };
  } else {
    // With no timestamp the mirror reports "now", which is not a snapshot. Asking again at that
    // time resolves to the newest real snapshot; that one timestamp is then held for every page.
    const live = await client.getJson("/balances?limit=1&order=desc");
    if (!live.timestamp) throw new Error("hedera /balances returned no timestamp");
    const head = await client.getJson(`/balances?limit=1&order=desc&timestamp=${live.timestamp}`);
    if (!head.balances?.length || !head.timestamp) throw new Error("hedera /balances returned no snapshot");
    state = { version: 1, timestamp: head.timestamp, maxId: numOf(head.balances[0].account, "balances"), floor: floorText, width, ranges: {} };
  }
  // One check per scan is enough: whether a snapshot exists does not change.
  let existence = null;
  const snapshotExists = () => (existence ??= requireSnapshot(client, state.timestamp));
  const todo = idRanges(state.maxId, width).filter((r) => !(r.lo in state.ranges));
  await runRanges(todo, concurrency, async ({ lo, hi }) => {
    const rows = await pageRange(client, {
      path: "/balances",
      rowsKey: "balances",
      idParam: "account.id",
      idField: "account",
      params: [`timestamp=${state.timestamp}`, `account.balance=gte:${floorText}`],
      lo,
      hi,
      snapshot: state.timestamp,
      label: "hedera /balances",
      snapshotExists,
      mapRow: (row, num) => [num, String(row.balance)],
    });
    state.ranges[lo] = rows;
    onProgress?.({ ...state, ranges: { ...state.ranges } });
  });
  const rows = idRanges(state.maxId, width).flatMap((r) => state.ranges[r.lo]);
  return { timestamp: state.timestamp, maxId: state.maxId, rows };
}

/** Ids of every contract up to `maxId`. The mirror's balance rows do not say account vs contract; this list does. */
export async function scanContractIds(client, { maxId, width = HEDERA_RANGE_WIDTH, concurrency = HEDERA_SCAN_CONCURRENCY }) {
  const byRange = new Map();
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
        snapshot: null,
        label: "hedera /contracts",
        mapRow: (_row, num) => num,
      }),
    );
  });
  return new Set(idRanges(maxId, width).flatMap((r) => byRange.get(r.lo)));
}
