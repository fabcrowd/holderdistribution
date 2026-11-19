// One conformance suite for every adapter. It compares an adapter with itself (the day's changes applied to
// one full list give the next full list), so it proves the adapter is consistent, not that it is right; the
// outside check and the supply gate belong to the pipeline. Everything is read through the shared readers, so
// a faulty adapter fails here by name rather than by crashing a check.
//
// Memory: ranges are checked one at a time and hold that range's rows only (`options.maxRangeRows` bounds it;
// a larger range fails the check and asks for more ranges). The transfer map of one pass is bounded by the
// day's changes, the same C the design budgets. Whole-coin sums and counts are streamed, never held.

import { createHash } from "node:crypto";
import { validateAdapter } from "./contract.js";
import { readChanges, readFullList, readPositionChanges, readPositionsFull } from "./read.js";

export const CHECK_NAMES = Object.freeze([
  "validateAdapter",
  "ranges-cover",
  "supply",
  "core-rule",
  "deterministic",
  "accounts-canonical",
  "balances-valid",
  "transfers-explain-changes",
  "settled-end-monotonic",
  "live-mode",
  "positions-core-rule",
]);

const DAY_MS = 86_400_000;
const EXAMPLES = 3;
const DIGEST_MASK = (1n << 52n) - 1n;
const DEFAULTS = { firstDay: "2026-01-01", days: 3, ranges: 4, maxRangeRows: 200_000, maxRetries: 8, advance: null };

const addDays = (dayUtc, n) => new Date(Date.parse(`${dayUtc}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const once = (fn) => {
  let promise;
  return () => (promise ??= fn());
};
const skipped = (why) => ({ skipped: why });

/** A bounded list of problems: a count and the first few examples. */
const problemList = () => {
  const items = { count: 0, examples: [] };
  return {
    add(text) {
      items.count += 1;
      if (items.examples.length < EXAMPLES) items.examples.push(text);
    },
    get count() {
      return items.count;
    },
    text: (label) => `${label}: ${items.count} (e.g. ${items.examples.join("; ")})`,
  };
};

function operations(adapter, asset, kind, opts) {
  const { maxRetries } = opts;
  if (kind === null) {
    return {
      full: (at, ranges, onRows) => readFullList(adapter, asset, at, { ranges, onRows, maxRetries }),
      changes: (from, to, hooks) => readChanges(adapter, asset, from, to, { ...hooks, maxRetries }),
    };
  }
  return {
    full: (_at, ranges, onRows) => readPositionsFull(adapter, asset, kind, { ranges, onRows, maxRetries }),
    changes: (from, to, hooks) => readPositionChanges(adapter, asset, kind, from, to, { ...hooks, maxRetries }),
  };
}

async function profile(adapter, ops, at, ranges) {
  const out = { rows: 0, sum: 0n, badAccounts: problemList(), badBalances: problemList() };
  await ops.full(at, ranges, (rows) => {
    for (const { account, balance } of rows) {
      out.rows += 1;
      out.sum += balance;
      if (adapter.normalizeAccount(account) !== account || !adapter.isAccount(account)) out.badAccounts.add(account);
      if (balance <= 0n) out.badBalances.add(`${account} listed with balance ${balance}`);
    }
  });
  return out;
}

async function loadRange(ops, at, range, opts) {
  const map = new Map();
  let reflected = at;
  await ops.full(at, [range], (rows, meta) => {
    reflected = meta.at;
    for (const { account, balance } of rows) map.set(account, balance);
    if (map.size > opts.maxRangeRows) throw new RangeError(`a range holds more than maxRangeRows (${opts.maxRangeRows}) rows; use more ranges`);
  });
  return { map, at: reflected };
}

const digestOf = (text) => BigInt(`0x${createHash("sha1").update(text).digest("hex").slice(0, 13)}`);

async function rangeDigest(ops, at, range) {
  let digest = 0n;
  let rows = 0;
  await ops.full(at, [range], (page) => {
    for (const { account, balance } of page) {
      digest = (digest + digestOf(`${account}:${balance}`)) & DIGEST_MASK;
      rows += 1;
    }
  });
  return `${rows}:${digest}`;
}

async function changesScan(adapter, ops, from, to) {
  const scan = { digest: 0n, rows: 0, transfers: 0, badAccounts: problemList(), negatives: problemList() };
  await ops.changes(from, to, {
    onRows(rows) {
      for (const { account, balance } of rows) {
        scan.rows += 1;
        scan.digest = (scan.digest + digestOf(`${account}:${balance}`)) & DIGEST_MASK;
        if (adapter.normalizeAccount(account) !== account || !adapter.isAccount(account)) scan.badAccounts.add(account);
        if (balance < 0n) scan.negatives.add(`${account} changed to ${balance}`);
      }
    },
    onTransfers(transfers) {
      for (const t of transfers) scan.digest = (scan.digest + digestOf(`${t.from}>${t.to}:${t.amount}@${t.height}`)) & DIGEST_MASK;
      scan.transfers += transfers.length;
    },
  });
  return scan;
}

function applyChanges(before, claimedRows) {
  const derived = new Map(before);
  for (const { account, balance } of claimedRows) {
    if (balance === 0n) derived.delete(account);
    else derived.set(account, balance);
  }
  return derived;
}

function compareStates(derived, after, found, label) {
  for (const [account, balance] of after) {
    if (derived.get(account) !== balance) found.rule.add(`${label}: ${account} should be ${balance}, applying changes gives ${derived.get(account) ?? "absent"}`);
  }
  for (const account of derived.keys()) if (!after.has(account)) found.rule.add(`${label}: ${account} is still listed after the changes but not in the later list`);
}

// A row whose balance equals the old one is legal only for an account a transfer touched (it sent and received
// the same amount); `net` holds an entry for every account any transfer touched, even when it nets to zero.
function checkTransfers(before, claimedRows, net, found, label) {
  for (const { account, balance } of claimedRows) {
    const explained = (before.get(account) ?? 0n) + (net.get(account) ?? 0n);
    if (explained !== balance) found.transfers.add(`${label}: ${account} was ${before.get(account) ?? 0n}, transfers move it to ${explained}, changes say ${balance}`);
    else if (balance === (before.get(account) ?? 0n) && !net.has(account)) found.transfers.add(`${label}: ${account} is listed as changed with its balance unchanged (${balance}) and no transfer touches it`);
  }
}

const countUnchanged = (before, claimedRows) => claimedRows.filter(({ account, balance }) => (before.get(account) ?? 0n) === balance).length;

/**
 * The core rule for one kind of balance: the list at `fromAt`, with the changes applied, equals the list at
 * `toAt`, range by range. `between` runs after the first list of a range is read (live mode advances the ledger).
 */
async function verifyRule({ adapter, asset, ops, opts, explainTransfers }, { fromAt, toAt, between, label }) {
  const found = { rule: problemList(), transfers: problemList(), unchangedRows: 0 };
  const ranges = await adapter.ranges(asset, opts.ranges);
  const fixedCursors = fromAt !== "live";
  let claimed = 0;
  let rowsTotal = 0;
  for (const [index, range] of ranges.entries()) {
    const before = await loadRange(ops, fromAt, range, opts);
    await between?.();
    const after = await loadRange(ops, toAt, range, opts);
    const claimedRows = [];
    const net = new Map();
    const stats = await ops.changes(before.at, after.at, {
      onRows: (rows) => rows.forEach((row) => (before.map.has(row.account) || after.map.has(row.account)) && claimedRows.push(row)),
      onTransfers: (ts) => ts.forEach((t) => (net.set(t.from, (net.get(t.from) ?? 0n) - t.amount), net.set(t.to, (net.get(t.to) ?? 0n) + t.amount))),
    });
    rowsTotal = stats.rows;
    claimed += claimedRows.length;
    found.unchangedRows += countUnchanged(before.map, claimedRows);
    const where = `${label} range ${index}`;
    compareStates(applyChanges(before.map, claimedRows), after.map, found, where);
    if (explainTransfers) checkTransfers(before.map, claimedRows, net, found, where);
  }
  // With fixed cursors one reading of the changes serves every range, so each row must belong to exactly one.
  if (fixedCursors && claimed !== rowsTotal) found.rule.add(`${label}: ${rowsTotal} changed accounts delivered, ${claimed} found in the range lists (a row outside every range, or in two)`);
  return found;
}

const verdict = (problems, label) => (problems.count === 0 ? undefined : problems.text(label));

async function buildContext(adapter, asset, opts) {
  const info = await adapter.discover(asset);
  const dates = Array.from({ length: opts.days + 2 }, (_, i) => addDays(opts.firstDay, i));
  const settled = await Promise.all(dates.map((d) => adapter.settledEnd(asset, d)));
  const cursors = [info.start];
  for (const c of settled) if (c.height > cursors[cursors.length - 1].height) cursors.push(c);
  return { info, settled, cursors, first: cursors[0], last: cursors[cursors.length - 1], middle: cursors[Math.floor(cursors.length / 2)] };
}

function checkSettledEnd(settled) {
  const bad = problemList();
  settled.forEach((c, i) => {
    if (c === null || typeof c !== "object" || !Number.isSafeInteger(c.height) || typeof c.id !== "string" || c.id === "") bad.add(`day ${i}: not a cursor with a non-empty id`);
    else if (i > 0 && c.height < settled[i - 1].height) bad.add(`day ${i}: height ${c.height} is before day ${i - 1}'s ${settled[i - 1].height}`);
  });
  return verdict(bad, "settledEnd");
}

/**
 * @param {import("./contract.js").LedgerAdapter} adapter
 * @param {*} asset
 * @param {{ firstDay?: string, days?: number, ranges?: number, maxRangeRows?: number, maxRetries?: number, advance?: () => *,
 *   }} [options]  `advance` moves a live-only ledger forward; the live checks need it to see any change.
 * @returns {Promise<{ ok: boolean, checks: { name: string, ok: boolean, detail: string }[], unchangedRows: number }>}
 *   `unchangedRows`: change rows seen whose balance equals the old one (allowed only for a touched account).
 */
export async function runConformance(adapter, asset, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const checks = [];
  const run = async (name, body) => {
    try {
      const outcome = await body();
      const note = outcome?.skipped;
      checks.push({ name, ok: note !== undefined || outcome === undefined, detail: note ? `skipped: ${note}` : (outcome ?? "") });
    } catch (error) {
      checks.push({ name, ok: false, detail: `${error?.name ?? "Error"}: ${error?.message ?? error}` });
    }
  };
  await run("validateAdapter", () => void validateAdapter(adapter));
  if (!checks[0].ok) return { ok: false, checks };

  const past = adapter.capabilities.pastReadable;
  const context = once(() => buildContext(adapter, asset, opts));
  const balanceOps = operations(adapter, asset, null, opts);
  const env = { adapter, asset, ops: balanceOps, opts, explainTransfers: false };
  const rangesOf = (n) => adapter.ranges(asset, n);
  const atLast = async () => (past ? (await context()).last : "live");
  const lastProfile = once(async () => profile(adapter, balanceOps, await atLast(), await rangesOf(opts.ranges)));
  const firstScan = once(async () => {
    const { first, last } = await context();
    return changesScan(adapter, balanceOps, first, last);
  });
  let unchangedRows = 0; // rows seen in the last interval read by the core rule (the whole interval, when it passes)
  const ruleOverCursors = async (pairs) => {
    for (const [from, to] of pairs) {
      const found = await verifyRule(env, { fromAt: from, toAt: to, label: `${from.height}..${to.height}` });
      unchangedRows = found.unchangedRows;
      if (found.rule.count > 0) return found.rule;
    }
    return problemList();
  };

  await run("ranges-cover", async () => {
    const [one, many] = [await profile(adapter, balanceOps, await atLast(), await rangesOf(1)), await lastProfile()];
    if (one.rows !== many.rows || one.sum !== many.sum) return `1 range gives ${one.rows} rows summing to ${one.sum}; ${opts.ranges} ranges give ${many.rows} rows summing to ${many.sum} (ranges overlap or leave a gap)`;
  });
  await run("supply", async () => {
    const { info, first } = await context();
    const lists = past ? [await profile(adapter, balanceOps, first, await rangesOf(opts.ranges)), await lastProfile()] : [await lastProfile()];
    const off = lists.filter((l) => l.sum !== info.supply);
    if (off.length > 0) return `discover().supply is ${info.supply}; full lists sum to ${lists.map((l) => l.sum).join(" and ")}`;
  });
  await run("core-rule", async () => {
    if (!past) return skipped("ledger cannot be read in the past (see live-mode)");
    const { first, middle, last } = await context();
    const hops = middle.height === first.height || middle.height === last.height ? [[first, last]] : [[first, middle], [first, last]];
    return verdict(await ruleOverCursors(hops), "full list plus changes differs from the later full list");
  });
  await run("deterministic", async () => {
    const [range] = await rangesOf(opts.ranges);
    const at = await atLast();
    const { first, last } = await context();
    const [a, b] = [await rangeDigest(balanceOps, at, range), await rangeDigest(balanceOps, at, range)];
    if (a !== b) return `the same fullList call gave different rows twice (${a} then ${b})`;
    const [c, d] = [await firstScan(), await changesScan(adapter, balanceOps, first, last)];
    if (c.digest !== d.digest || c.rows !== d.rows) return `the same changes call gave different rows twice (${c.rows} rows, then ${d.rows})`;
  });
  await run("accounts-canonical", async () => {
    const [list, changed] = [await lastProfile(), await firstScan()];
    return verdict(list.badAccounts, "full list accounts not canonical") ?? verdict(changed.badAccounts, "changed accounts not canonical");
  });
  await run("balances-valid", async () => {
    const [list, changed] = [await lastProfile(), await firstScan()];
    return verdict(list.badBalances, "full list balances not positive") ?? verdict(changed.negatives, "negative balances in changes");
  });
  await run("transfers-explain-changes", async () => {
    const { listsTransfers, balanceMovesWithoutRecord } = adapter.capabilities;
    if (!listsTransfers) return skipped("adapter does not list transfers");
    if (balanceMovesWithoutRecord) return skipped("balances move without a record");
    if (!past) return skipped("ledger cannot be read in the past (see live-mode)");
    const { first, last } = await context();
    const found = await verifyRule({ ...env, explainTransfers: true }, { fromAt: first, toAt: last, label: `${first.height}..${last.height}` });
    return verdict(found.transfers, "changed balances not explained by transfers");
  });
  await run("settled-end-monotonic", async () => checkSettledEnd((await context()).settled));
  await run("live-mode", async () => {
    if (past) return skipped("ledger can be read in the past");
    const found = await verifyRule(env, { fromAt: "live", toAt: "live", between: opts.advance, label: "live" });
    unchangedRows = found.unchangedRows;
    return verdict(found.rule, "live list plus changes differs from the later live list");
  });
  await run("positions-core-rule", async () => {
    if (adapter.positionKinds.length === 0) return skipped("adapter has no position kinds");
    for (const kind of adapter.positionKinds) {
      const ops = operations(adapter, asset, kind, opts);
      const found = await verifyRule({ ...env, ops }, { fromAt: "live", toAt: "live", between: opts.advance, label: kind });
      const problem = verdict(found.rule, `${kind}: positions plus changes differ from the later positions`);
      if (problem) return problem;
    }
  });
  return { ok: checks.every((c) => c.ok), checks, unchangedRows };
}
