import { describe, expect, it } from "vitest";
import { CHECK_NAMES, runConformance } from "./conformance.js";
import { createSyntheticAdapter } from "./synthetic.js";

const SHAPE = { seed: 21, accounts: 2000, changesPerDay: 150, days: 5, maxPageRows: 100, liveHeight: 0 };
const failing = (result) => result.checks.filter((c) => !c.ok).map((c) => c.name);
const options = (adapter) => ({ firstDay: "2026-01-01", days: 5, ranges: 4, advance: () => adapter.advanceLive() });
const conform = (adapter, extra = {}) => runConformance(adapter, null, { ...options(adapter), ...extra });
const check = (result, name) => result.checks.find((c) => c.name === name);

// The last page of a sequence states its total and sum; a wrapper that changes rows keeps them honest, so only
// the conformance check, not the reader, can see the damage.
const lastPageOf = (page, change) => (page.next === null && page.rows.length > 0 ? change(page) : page);

describe("the synthetic adapter conforms", () => {
  for (const pastReadable of [true, false]) {
    for (const listsTransfers of [true, false]) {
      it(`passes every check with pastReadable ${pastReadable} and listsTransfers ${listsTransfers}`, async () => {
        const adapter = createSyntheticAdapter({ ...SHAPE, pastReadable, listsTransfers });
        const result = await conform(adapter);
        expect(result.checks.filter((c) => !c.ok)).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.checks.map((c) => c.name)).toEqual(CHECK_NAMES);
        expect(check(result, "core-rule").detail.startsWith("skipped")).toBe(!pastReadable);
        expect(check(result, "live-mode").detail.startsWith("skipped")).toBe(pastReadable);
        expect(check(result, "transfers-explain-changes").detail.startsWith("skipped")).toBe(!(pastReadable && listsTransfers));
        expect(check(result, "positions-core-rule").detail).toBe("");
      });
    }
  }

  it("still passes when the ledger is faulty, because it reads through the retrying readers", async () => {
    const adapter = createSyntheticAdapter({ ...SHAPE, faults: { refuseEvery: 3, shortPageEvery: 4, repeatRowEvery: 5, shuffle: true } });
    expect(failing(await conform(adapter, { maxRetries: 25 }))).toEqual([]);
  });

  it("stops after validateAdapter when the adapter is incomplete", async () => {
    const result = await runConformance({ family: "x" }, null);
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "validateAdapter", ok: false });
    expect(result.checks[0].detail).toMatch(/adapter\.capabilities/);
  });

  it("fails the core rule, naming the range limit, when a range holds more rows than allowed", async () => {
    const adapter = createSyntheticAdapter(SHAPE);
    const result = await conform(adapter, { maxRangeRows: 50 });
    expect(failing(result)).toContain("core-rule");
    expect(check(result, "core-rule").detail).toMatch(/maxRangeRows/);
  });
});

describe("a deliberately broken adapter fails the matching check by name", () => {
  const base = () => createSyntheticAdapter(SHAPE);

  it("an adapter that drops a changed account fails core-rule", async () => {
    const good = base();
    const adapter = {
      ...good,
      changes: (a, f, t, page) => {
        const p = good.changes(a, f, t, page);
        const first = page === null || page === undefined;
        return { ...p, rows: first ? p.rows.slice(1) : p.rows, count: first ? p.count - 1 : p.count, ...(p.next === null ? { total: p.total - 1 } : {}) };
      },
    };
    const result = await conform(adapter);
    expect(failing(result)).toContain("core-rule");
    expect(check(result, "core-rule").detail).toMatch(/should be/);
  });

  it("an adapter whose ranges overlap fails ranges-cover", async () => {
    const good = base();
    const adapter = { ...good, ranges: (a, n) => (n > 1 ? [...good.ranges(a, n), good.ranges(a, n)[0]] : good.ranges(a, n)) };
    const result = await conform(adapter);
    expect(failing(result)).toContain("ranges-cover");
    expect(check(result, "ranges-cover").detail).toMatch(/overlap or leave a gap/);
  });

  it("an adapter that returns a negative balance fails balances-valid", async () => {
    const good = base();
    const adapter = {
      ...good,
      fullList: (a, at, range, page) =>
        lastPageOf(good.fullList(a, at, range, page), (p) => {
          const [row, ...rest] = p.rows;
          return { ...p, rows: [{ ...row, balance: -row.balance }, ...rest], sum: p.sum - 2n * row.balance };
        }),
    };
    const result = await conform(adapter);
    expect(failing(result)).toContain("balances-valid");
    expect(check(result, "balances-valid").detail).toMatch(/not positive/);
  });

  it("an adapter that is not deterministic fails deterministic", async () => {
    const good = base();
    let reads = 0;
    const adapter = {
      ...good,
      fullList: (a, at, range, page) => {
        if (page === null || page === undefined) reads += 1;
        return lastPageOf(good.fullList(a, at, range, page), (p) => (reads % 2 === 0 ? { ...p, rows: [{ ...p.rows[0], balance: p.rows[0].balance + 1n }, ...p.rows.slice(1)], sum: p.sum + 1n } : p));
      },
    };
    const result = await conform(adapter);
    expect(failing(result)).toContain("deterministic");
    expect(check(result, "deterministic").detail).toMatch(/different rows twice/);
  });

  it("an adapter whose supply is off fails supply", async () => {
    const good = base();
    const adapter = { ...good, discover: (a) => ({ ...good.discover(a), supply: good.discover(a).supply + 1n }) };
    expect(failing(await conform(adapter))).toContain("supply");
  });

  it("an adapter with a non-canonical account fails accounts-canonical", async () => {
    const good = base();
    const adapter = {
      ...good,
      capabilities: { ...good.capabilities, sortedPages: false },
      fullList: (a, at, range, page) => lastPageOf(good.fullList(a, at, range, page), (p) => ({ ...p, rows: [{ ...p.rows[0], account: p.rows[0].account.toUpperCase() }, ...p.rows.slice(1)] })),
    };
    expect(failing(await conform(adapter))).toContain("accounts-canonical");
  });

  it("an adapter whose transfers do not add up fails transfers-explain-changes", async () => {
    const good = base();
    const adapter = { ...good, changes: (a, f, t, page) => ({ ...good.changes(a, f, t, page), transfers: good.changes(a, f, t, page).transfers.map((x) => ({ ...x, amount: x.amount + 1n })) }) };
    const result = await conform(adapter);
    expect(failing(result)).toContain("transfers-explain-changes");
    expect(check(result, "core-rule").ok).toBe(true);
  });

  it("an adapter whose settledEnd goes backward, or has no id, fails settled-end-monotonic", async () => {
    const good = base();
    const backward = { ...good, settledEnd: (a, day) => good.settledEnd(a, day === "2026-01-04" ? "2026-01-01" : day) };
    expect(failing(await conform(backward))).toContain("settled-end-monotonic");
    const noId = { ...good, settledEnd: (a, day) => ({ height: good.settledEnd(a, day).height, id: "" }) };
    expect(failing(await conform(noId))).toContain("settled-end-monotonic");
  });

  it("an adapter whose live changes miss an account fails live-mode", async () => {
    const good = createSyntheticAdapter({ ...SHAPE, pastReadable: false });
    const adapter = { ...good, changes: (a, f, t, page) => { const p = good.changes(a, f, t, page); return { ...p, rows: p.rows.slice(1), count: Math.max(0, p.count - 1), ...(p.next === null ? { total: Math.max(0, p.total - 1) } : {}) }; } };
    const result = await conform(adapter);
    expect(failing(result)).toContain("live-mode");
  });

  it("an adapter whose position changes miss an account fails positions-core-rule", async () => {
    const good = createSyntheticAdapter({ ...SHAPE, stakeShare: 0.5 });
    const adapter = { ...good, positionChanges: (a, k, f, t, page) => { const p = good.positionChanges(a, k, f, t, page); return { ...p, rows: p.rows.slice(1), count: Math.max(0, p.count - 1), ...(p.next === null ? { total: Math.max(0, p.total - 1) } : {}) }; } };
    const result = await conform(adapter);
    expect(failing(result)).toContain("positions-core-rule");
  });
});

describe("a change row for an account that did not change", () => {
  const FIRST = "2026-01-01";
  const pagesOf = (read) => {
    const rows = [];
    for (let token = null; ; ) {
      const page = read(token);
      rows.push(...page.rows);
      if (page.next === null) return rows;
      token = page.next;
    }
  };
  // An account that holds a balance at the start and is not in any change row of the whole interval.
  const untouchedAccount = (good) => {
    const first = good.settledEnd(null, FIRST);
    const last = good.settledEnd(null, "2026-01-06");
    const changed = new Set(pagesOf((t) => good.changes(null, first, last, t)).map((r) => r.account));
    const [range] = good.ranges(null, 1);
    const holder = pagesOf((t) => good.fullList(null, first, range, t)).find((r) => !changed.has(r.account));
    return holder;
  };
  // Adds one claimed row (and optional transfers) to the first page of every changes call, keeping count and total honest.
  const withExtraRow = (good, row, transfers = []) => ({
    ...good,
    changes: (a, f, t, page) => {
      const p = good.changes(a, f, t, page);
      const firstPage = page === null || page === undefined;
      const rows = firstPage ? [...p.rows, row] : p.rows;
      return { ...p, rows, count: rows.length, transfers: firstPage ? [...p.transfers, ...transfers] : p.transfers, ...(p.next === null ? { total: p.total + 1 } : {}) };
    },
  });
  const settled = (good) => good.settledEnd(null, FIRST);

  it("the generated ledger reports no unchanged rows", async () => {
    const result = await conform(createSyntheticAdapter(SHAPE));
    expect(result.unchangedRows).toBe(0);
  });

  it("fails transfers-explain-changes by name when an untouched account is listed with its real balance", async () => {
    const good = createSyntheticAdapter({ ...SHAPE, seed: 22 });
    const holder = untouchedAccount(good);
    const result = await conform(withExtraRow(good, holder));
    expect(failing(result)).toEqual(["transfers-explain-changes"]);
    expect(check(result, "transfers-explain-changes").detail).toMatch(/no transfer touches it/);
    expect(result.unchangedRows).toBe(1);
    expect(settled(good).height).toBe(0);
  });

  it("passes, and counts the row, when the account sent and received the same amount", async () => {
    const good = createSyntheticAdapter({ ...SHAPE, seed: 22 });
    const holder = untouchedAccount(good);
    const other = "acct-ffffffffffff";
    const there = (height) => ({ from: holder.account, to: other, amount: 1n, height });
    const back = (height) => ({ from: other, to: holder.account, amount: 1n, height });
    const result = await conform(withExtraRow(good, holder, [there(1), back(2)]));
    expect(failing(result)).toEqual([]);
    expect(result.unchangedRows).toBe(1);
  });

  it("passes without listsTransfers and still reports the count", async () => {
    const good = createSyntheticAdapter({ ...SHAPE, seed: 22, listsTransfers: false });
    const result = await conform(withExtraRow(good, untouchedAccount(good)));
    expect(failing(result)).toEqual([]);
    expect(result.unchangedRows).toBe(1);
  });
});
