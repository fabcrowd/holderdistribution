import { describe, expect, it } from "vitest";
import { RESUME_REJECTED, validateAdapter } from "./contract.js";
import { createSyntheticAdapter } from "./synthetic.js";
import { createModel, mulmod, modInverse } from "./syntheticMath.js";

const EPOCH_MS = Date.parse("2026-01-01T00:00:00Z");
const dayText = (d) => new Date(EPOCH_MS + d * 86_400_000).toISOString().slice(0, 10);
const cursorAt = (adapter, d) => adapter.settledEnd(null, dayText(d));

const pagesOf = (fetch) => {
  const pages = [];
  let token = null;
  do {
    const page = fetch(token);
    pages.push(page);
    token = page.next;
  } while (token !== null);
  return pages;
};
const fullMap = (adapter, at, n = 3) => {
  const state = new Map();
  for (const range of adapter.ranges(null, n)) for (const page of pagesOf((t) => adapter.fullList(null, at, range, t))) for (const r of page.rows) state.set(r.account, r.balance);
  return state;
};
const sumOf = (state) => [...state.values()].reduce((a, b) => a + b, 0n);
const sortedEntries = (state) => [...state].sort(([a], [b]) => (a < b ? -1 : 1));

describe("synthetic ledger, small and checked by brute force", () => {
  const simulate = (seed) => {
    const adapter = createSyntheticAdapter({ seed, accounts: 500, changesPerDay: 60, days: 6, maxPageRows: 50 });
    const supply = adapter.discover(null).supply;
    const state = fullMap(adapter, cursorAt(adapter, 0));
    const presence = new Map([...state.keys()].map((a) => [a, [true]]));
    for (let d = 1; d <= 6; d++) {
      for (const page of pagesOf((t) => adapter.changes(null, cursorAt(adapter, d - 1), cursorAt(adapter, d), t))) {
        for (const t of page.transfers) {
          state.set(t.from, (state.get(t.from) ?? 0n) - t.amount);
          state.set(t.to, (state.get(t.to) ?? 0n) + t.amount);
        }
      }
      for (const [account, balance] of state) {
        expect(balance, `${account} on day ${d}`).toBeGreaterThanOrEqual(0n);
        if (balance === 0n) state.delete(account);
      }
      expect(sortedEntries(state)).toEqual(sortedEntries(fullMap(adapter, cursorAt(adapter, d))));
      expect(sumOf(state)).toBe(supply);
      for (const account of new Set([...presence.keys(), ...state.keys()])) {
        if (!presence.has(account)) presence.set(account, Array(d).fill(false));
        presence.get(account).push(state.has(account));
      }
    }
    return presence;
  };

  it("applying the adapter's own transfers keeps supply, never goes negative and matches every full list", () => {
    simulate(1);
  });

  it("has accounts that reach zero and later return", () => {
    const returns = (days) => {
      const left = days.findIndex((held, d) => !held && days.slice(0, d).includes(true));
      return left > 0 && days.slice(left).includes(true);
    };
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8].filter((seed) => [...simulate(seed).values()].some(returns));
    expect(seeds.length).toBeGreaterThan(0);
  });

  it("changes rows carry the balance at `to`, with zero for an account that left", () => {
    const adapter = createSyntheticAdapter({ seed: 3, accounts: 500, changesPerDay: 60, days: 6, maxPageRows: 50 });
    const [a, b] = [fullMap(adapter, cursorAt(adapter, 0)), fullMap(adapter, cursorAt(adapter, 6))];
    const rows = pagesOf((t) => adapter.changes(null, cursorAt(adapter, 0), cursorAt(adapter, 6), t)).flatMap((p) => p.rows);
    expect(new Set(rows.map((r) => r.account)).size).toBe(rows.length);
    for (const { account, balance } of rows) {
      expect(b.get(account) ?? 0n).toBe(balance);
      expect(a.get(account) ?? 0n).not.toBe(balance);
    }
    const changed = new Set(rows.map((r) => r.account));
    for (const account of new Set([...a.keys(), ...b.keys()])) if (!changed.has(account)) expect(a.get(account) ?? 0n).toBe(b.get(account) ?? 0n);
  });
});

describe("page shape", () => {
  it("states count on every page and total and sum on the last", () => {
    const adapter = createSyntheticAdapter({ accounts: 700, changesPerDay: 80, days: 3, maxPageRows: 64 });
    const [range] = adapter.ranges(null, 1);
    const pages = pagesOf((t) => adapter.fullList(null, cursorAt(adapter, 3), range, t));
    expect(pages.length).toBeGreaterThan(5);
    for (const p of pages) expect(p.count).toBe(p.rows.length);
    const last = pages.at(-1);
    expect(last.total).toBe(pages.flatMap((p) => p.rows).length);
    expect(last.sum).toBe(sumOf(new Map(pages.flatMap((p) => p.rows).map((r) => [r.account, r.balance]))));
    expect(pages.slice(0, -1).every((p) => p.total === undefined && typeof p.next === "string")).toBe(true);
    expect(pages.every((p) => p.rows.length <= 64)).toBe(true);
  });

  it("states a total on the last page of changes and keeps transfers with their pages", () => {
    const adapter = createSyntheticAdapter({ accounts: 700, changesPerDay: 80, days: 3, maxPageRows: 20 });
    const pages = pagesOf((t) => adapter.changes(null, cursorAt(adapter, 0), cursorAt(adapter, 3), t));
    expect(pages.at(-1).total).toBe(pages.flatMap((p) => p.rows).length);
    expect(pages.flatMap((p) => p.transfers).length).toBeGreaterThan(0);
    expect(pages.flatMap((p) => p.transfers).every((t) => t.amount > 0n && t.height >= 1 && t.height <= 3)).toBe(true);
  });

  it("returns an empty single page for an empty interval", () => {
    const adapter = createSyntheticAdapter({ days: 3 });
    const page = adapter.changes(null, cursorAt(adapter, 2), cursorAt(adapter, 2));
    expect(page).toMatchObject({ rows: [], transfers: [], count: 0, next: null, total: 0 });
  });

  it("lists transfers only when it says it does", () => {
    const adapter = createSyntheticAdapter({ listsTransfers: false, days: 3 });
    expect(adapter.capabilities.listsTransfers).toBe(false);
    expect(pagesOf((t) => adapter.changes(null, cursorAt(adapter, 0), cursorAt(adapter, 3), t)).flatMap((p) => p.transfers)).toEqual([]);
  });
});

describe("arithmetic", () => {
  it("finds the day's accounts and inverts them in O(1), for even, odd, tiny and prime sizes", () => {
    for (const [H, C] of [[1, 5], [2, 1], [16, 16], [97, 30], [100, 40], [1000, 1]]) {
      const m = createModel({ seed: 4, accounts: H, changesPerDay: C, days: 3, stakeShare: 0.5 });
      for (let day = 1; day <= 3; day++) {
        const byIndex = new Map();
        for (let k = 0; k < m.changesPerDay; k++) byIndex.set(m.balanceIndex(day, k), k);
        expect(byIndex.size, `H=${H} day ${day} repeats an index`).toBe(m.changesPerDay);
        for (let i = 0; i < H; i++) expect(m.balanceSlot(day, i)).toBe(byIndex.get(i) ?? -1);
      }
    }
  });

  it("agrees with brute force on supply for sizes that are not a multiple of the weight cycle", () => {
    for (const H of [1, 7, 16, 17, 100, 333]) {
      const m = createModel({ seed: 9, accounts: H, changesPerDay: 3, days: 2, stakeShare: 0 });
      let total = 0n;
      for (let i = 0; i < H; i++) total += m.balanceAt(i, 0);
      expect(m.supply).toBe(total);
    }
  });

  it("stays exact beyond the size where a double product overflows", () => {
    const H = 300_000_007; // above 94 million, so a * k passes 2^53
    expect(mulmod(299_999_999, 299_999_990, H)).toBe(Number((299_999_999n * 299_999_990n) % BigInt(H)));
    expect((modInverse(123_456_789, H) * 123_456_789) % H === 1 || mulmod(modInverse(123_456_789, H), 123_456_789, H) === 1).toBe(true);
    const m = createModel({ seed: 2, accounts: H, changesPerDay: 1000, days: 2, stakeShare: 0 });
    for (const k of [0, 1, 500, 999]) expect(m.balanceSlot(2, m.balanceIndex(2, k))).toBe(k);
    expect(m.balanceSlot(2, (m.balanceIndex(2, 0) + 1) % H)).toBe(-1);
  });
});

describe("cursors, days and live", () => {
  it("derives the cursor id from the seed and the day, and refuses a cursor from another history", () => {
    const a = createSyntheticAdapter({ seed: 1, days: 3 });
    const b = createSyntheticAdapter({ seed: 2, days: 3 });
    expect(cursorAt(a, 1).id).not.toBe(cursorAt(b, 1).id);
    expect(cursorAt(a, 1)).toEqual(cursorAt(createSyntheticAdapter({ seed: 1, days: 3 }), 1));
    expect(() => a.changes(null, cursorAt(b, 0), cursorAt(a, 2))).toThrow(/reorganized/);
  });

  it("clamps settledEnd to the days the ledger has and never goes backward", () => {
    const a = createSyntheticAdapter({ days: 3 });
    const heights = ["2025-12-01", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-03-01"].map((d) => a.settledEnd(null, d).height);
    expect(heights).toEqual([0, 0, 1, 2, 3, 3]);
    expect(() => a.settledEnd(null, "yesterday")).toThrow(/YYYY-MM-DD/);
  });

  it("serves only live when it cannot be read in the past, and says which cursor the page reflects", () => {
    const a = createSyntheticAdapter({ pastReadable: false, days: 4, liveHeight: 1, accounts: 50 });
    const [range] = a.ranges(null, 1);
    expect(() => a.fullList(null, cursorAt(a, 1), range)).toThrow(/live/);
    expect(a.fullList(null, "live", range).at).toEqual(cursorAt(a, 1));
    a.advanceLive();
    expect(a.fullList(null, "live", range).at).toEqual(cursorAt(a, 2));
  });

  it("splits [0, H) into n ranges that cover it once", () => {
    const a = createSyntheticAdapter({ accounts: 1003 });
    for (const n of [1, 2, 7, 1003, 5000]) {
      const ranges = a.ranges(null, n);
      expect(ranges[0].from).toBe(0);
      expect(ranges.at(-1).to).toBe(1003);
      ranges.slice(1).forEach((r, i) => expect(r.from).toBe(ranges[i].to));
    }
  });
});

describe("account rules and positions", () => {
  it("passes validateAdapter and normalizes accounts", () => {
    const a = createSyntheticAdapter({});
    expect(validateAdapter(a)).toBe(a);
    expect(a.normalizeAccount("  ACCT-00000000000A ")).toBe("acct-00000000000a");
    expect(a.isAccount("acct-00000000000a")).toBe(true);
    expect(a.isAccount("ACCT-00000000000A")).toBe(false);
    expect(a.explorerUrl("account", "acct-1")).toContain("/account/acct-1");
  });

  it("serves one position kind, stake, and refuses another", () => {
    const a = createSyntheticAdapter({ accounts: 800, days: 3, stakeShare: 0.25 });
    expect(a.positionKinds).toEqual(["stake"]);
    const [range] = a.ranges(null, 1);
    const rows = pagesOf((t) => a.positionsFull(null, "stake", range, t)).flatMap((p) => p.rows);
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.length).toBeLessThan(400);
    expect(rows.every((r) => r.balance > 0n)).toBe(true);
    expect(() => a.positionsFull(null, "lock", range)).toThrow(/unknown position kind/);
    expect(createSyntheticAdapter({ stakeShare: 0 }).positionKinds).toEqual([]);
  });
});

describe("faults", () => {
  const first = (a) => [a.ranges(null, 1)[0], cursorAt(a, 3)];

  it("refuses with a retryable error every nth call", () => {
    const a = createSyntheticAdapter({ faults: { refuseEvery: 2 }, accounts: 100, days: 3 });
    const [range, at] = first(a);
    expect(() => a.fullList(null, at, range)).not.toThrow();
    expect(() => a.fullList(null, at, range)).toThrow(expect.objectContaining({ retryable: true }));
  });

  it("cuts a page short but still states the right count", () => {
    const a = createSyntheticAdapter({ faults: { shortPageEvery: 1 }, accounts: 100, days: 3 });
    const [range, at] = first(a);
    const page = a.fullList(null, at, range);
    expect(page.rows.length).toBe(page.count - 1);
  });

  it("repeats a row inside a page without changing its length", () => {
    const a = createSyntheticAdapter({ faults: { repeatRowEvery: 1 }, accounts: 100, days: 3 });
    const [range, at] = first(a);
    const page = a.fullList(null, at, range);
    expect(page.rows.length).toBe(page.count);
    expect(new Set(page.rows.map((r) => r.account)).size).toBe(page.count - 1);
  });

  it("shuffles rows, declares its pages unsorted, and rejects a page token with the restart code", () => {
    const a = createSyntheticAdapter({ faults: { shuffle: true }, accounts: 100, days: 3 });
    const [range, at] = first(a);
    const names = a.fullList(null, at, range).rows.map((r) => r.account);
    expect(names).not.toEqual([...names].sort());
    expect(a.capabilities.sortedPages).toBe(false);
    const b = createSyntheticAdapter({ faults: { rejectResumeEvery: 1 }, accounts: 100, days: 3, maxPageRows: 10 });
    const [r2, at2] = first(b);
    const page = b.fullList(null, at2, r2);
    expect(() => b.fullList(null, at2, r2, page.next)).toThrow(expect.objectContaining({ code: RESUME_REJECTED }));
  });

  it("repeats the same faults on the same seed", () => {
    const run = () => {
      const a = createSyntheticAdapter({ seed: 5, faults: { shuffle: true, shortPageEvery: 2 }, accounts: 200, days: 3 });
      const [range, at] = first(a);
      return [a.fullList(null, at, range), a.fullList(null, at, range)].map((p) => p.rows.map((r) => r.account));
    };
    expect(run()).toEqual(run());
  });
});

describe("ranges asks for a whole number of ranges", () => {
  it("rejects a fractional, zero, negative or non-numeric n with a named error", () => {
    const a = createSyntheticAdapter({ accounts: 5 });
    for (const n of [2.5, 0, -1, Number.NaN, "2", undefined]) expect(() => a.ranges(null, n), String(n)).toThrow(/ranges: n must be an integer of at least 1/);
    expect(a.ranges(null, 2)).toHaveLength(2);
  });
});
