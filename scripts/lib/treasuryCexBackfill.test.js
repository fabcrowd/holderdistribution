import { describe, expect, it } from "vitest";
import {
  buildCexEntry,
  buildTreasuryEntry,
  categoryAddressMap,
  cumulativeNetByBoundary,
  enumerateDates,
  exchangeAddressMap,
  mergeBackfilledEntries,
  missingDates,
  priorEntry,
  applyAnchorAdjustments,
  categoryMapForDate,
  reconstructHistory,
  relativeDrift,
  trustedAnchor,
  worstDrift,
} from "./treasuryCexBackfill.js";

const T1 = "0x" + "a1".repeat(20); // treasury
const T2 = "0x" + "a2".repeat(20); // council
const CEX = "0x" + "c1".repeat(20); // exchange "Kraken"
const USER = "0x" + "99".repeat(20);
const UPGRADE = "0x" + "e5".repeat(20); // escrow upgrade contract
const LEGACY = "0x" + "11".repeat(20);
const V3 = "0x" + "33".repeat(20);

const hex = (n) => "0x" + n.toString(16);
const tr = (from, to, value, block) => ({ from, to, value: BigInt(value), blockNumber: hex(block) });

describe("dates and lookups", () => {
  it("enumerates inclusive ranges and rejects bad input", () => {
    expect(enumerateDates("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(() => enumerateDates("2026-10-05", "2026-10-01")).toThrow(/after/);
    expect(() => enumerateDates("10/05", "2026-10-06")).toThrow(/YYYY-MM-DD/);
  });
  it("finds missing dates and prior entries", () => {
    const entries = [{ date: "2026-10-02" }, { date: "2026-10-05" }];
    expect(missingDates(entries, ["2026-10-02", "2026-10-03", "2026-10-05"])).toEqual(["2026-10-03"]);
    expect(priorEntry(entries, "2026-10-04").date).toBe("2026-10-02");
    expect(priorEntry(entries, "2026-10-02")).toBeNull();
  });
});

describe("address maps", () => {
  it("keeps only requested categories and lowercases", () => {
    const map = categoryAddressMap(
      { labels: { [T1.toUpperCase().replace("0X", "0x")]: { category: "treasury" }, [USER]: { category: "cex" } } },
      ["treasury", "council"],
    );
    expect([...map]).toEqual([[T1, "treasury"]]);
  });
  it("maps cex wallets to labels and skips non-EVM", () => {
    const map = exchangeAddressMap({ wallets: [{ address: CEX, label: "Kraken" }, { address: "So1anaAddr", label: "X" }] });
    expect([...map]).toEqual([[CEX, "Kraken"]]);
  });
});

describe("cumulativeNetByBoundary", () => {
  const boundaries = [
    { date: "d1", block: 100 },
    { date: "d2", block: 200 },
  ];
  const watched = new Set([T1, T2, UPGRADE]);

  it("accumulates per boundary and cancels internal transfers", () => {
    const out = cumulativeNetByBoundary({
      transfers: [tr(USER, T1, 500, 50), tr(T1, T2, 200, 150), tr(T2, USER, 30, 160), tr(USER, T1, 7, 999)],
      boundaries,
      watched,
    });
    expect(out.get("d1").get(T1)).toBe(500n);
    expect(out.get("d2").get(T1)).toBe(300n);
    expect(out.get("d2").get(T2)).toBe(170n);
    expect(out.get("d2").get(T1) + out.get("d2").get(T2)).toBe(470n);
  });

  it("includes a transfer exactly at the boundary block and ignores later ones", () => {
    const out = cumulativeNetByBoundary({ transfers: [tr(USER, T1, 1, 100), tr(USER, T1, 1, 101)], boundaries, watched });
    expect(out.get("d1").get(T1)).toBe(1n);
    expect(out.get("d2").get(T1)).toBe(2n);
  });

  it("ignores credits to retired-legacy upgrade contracts but still debits them", () => {
    const out = cumulativeNetByBoundary({
      transfers: [tr(USER, UPGRADE, 900, 10), tr(UPGRADE, USER, 100, 20)],
      boundaries,
      watched,
      ignoreCreditTo: new Set([UPGRADE]),
    });
    expect(out.get("d1").get(UPGRADE)).toBe(-100n);
  });

  it("treats mint/burn legs (null) safely and yields empty maps for quiet days", () => {
    const out = cumulativeNetByBoundary({ transfers: [tr(null, T1, 5, 120), tr(T1, null, 2, 130)], boundaries, watched });
    expect(out.get("d1").size).toBe(0);
    expect(out.get("d2").get(T1)).toBe(3n);
  });
});

describe("row builders", () => {
  it("builds a flagged treasury row from anchor + delta", () => {
    const row = buildTreasuryEntry({
      date: "2026-10-03",
      anchor: { date: "2026-10-02", categories: { treasury: 1000, council: 50 } },
      delta: new Map([["council", -20.4]]),
      categories: ["treasury", "council"],
    });
    expect(row).toEqual({ date: "2026-10-03", categories: { treasury: 1000, council: 30 }, backfilled: true });
  });
  it("rejects a negative reconstructed balance", () => {
    expect(() =>
      buildTreasuryEntry({
        date: "d",
        anchor: { date: "a", categories: { treasury: 10 } },
        delta: new Map([["treasury", -50]]),
        categories: ["treasury"],
      }),
    ).toThrow(/not a valid balance/);
  });
  it("builds cex rows, dropping zero balances and adding new exchanges", () => {
    const row = buildCexEntry({
      date: "d",
      anchor: { date: "a", exchanges: { Kraken: 100.5, Gone: 10 } },
      delta: new Map([["Kraken", 1.25], ["Gone", -10], ["New", 5]]),
    });
    expect(row.exchanges).toEqual({ Kraken: 101.75, New: 5 });
    expect(row.total).toBe(106.75);
    expect(row.backfilled).toBe(true);
  });
  it("computes drift with a floor", () => {
    expect(relativeDrift(100, 100)).toBe(0);
    expect(relativeDrift(90, 100)).toBeCloseTo(0.1);
    expect(relativeDrift(0, 0)).toBe(0);
  });
});

describe("mergeBackfilledEntries", () => {
  it("never replaces an existing date and keeps order", () => {
    const existing = [{ date: "2026-10-02", v: "real" }, { date: "2026-10-05", v: "real" }];
    const { entries, added, skipped } = mergeBackfilledEntries(existing, [
      { date: "2026-10-03", v: "new" },
      { date: "2026-10-05", v: "new" },
    ]);
    expect(added).toEqual(["2026-10-03"]);
    expect(skipped).toEqual(["2026-10-05"]);
    expect(entries.map((e) => `${e.date}:${e.v}`)).toEqual(["2026-10-02:real", "2026-10-03:new", "2026-10-05:real"]);
  });
  it("is idempotent", () => {
    const rows = [{ date: "2026-10-03" }];
    const once = mergeBackfilledEntries([{ date: "2026-10-02" }], rows).entries;
    const twice = mergeBackfilledEntries(once, rows);
    expect(twice.added).toEqual([]);
    expect(twice.entries).toEqual(once);
  });
});

describe("reconstructHistory (fake client)", () => {
  // Decimals 2 (legacy) and 18 (v3). Block per day: d = 100 * day-of-month.
  const blockOf = (date) => Number(date.slice(8)) * 100;
  const calls = { blocks: [], fetches: [] };
  const makeClient = (transfersByToken) => ({
    async blockAtEndOfDate(chainKey, date) {
      calls.blocks.push(`${chainKey}:${date}`);
      return blockOf(date);
    },
    async fetchTransfers({ tokenAddress, fromBlock, toBlock }) {
      calls.fetches.push({ tokenAddress, fromBlock, toBlock });
      return (transfersByToken[tokenAddress] ?? []).filter((t) => parseInt(t.blockNumber, 16) >= fromBlock);
    },
  });

  const chains = [
    {
      key: "eth",
      tokens: [
        { address: LEGACY, decimals: 2, generation: "legacy" },
        { address: V3, decimals: 18, generation: "v3", deployBlock: 150 },
      ],
      upgradeContracts: [UPGRADE],
    },
  ];
  const categoryByAddress = new Map([[T1, "treasury"], [T2, "council"], [UPGRADE, "escrow"]]);
  const exchangeByAddress = new Map([[CEX, "Kraken"]]);
  const categories = ["treasury", "council", "escrow"];
  const treasuryHistory = {
    entries: [
      { date: "2026-10-02", categories: { treasury: 1000, council: 500, escrow: 8000 } },
      // true value after 10-03..10-04 flows below
      { date: "2026-10-05", categories: { treasury: 1100, council: 450, escrow: 7990 } },
    ],
  };
  const cexHistory = {
    entries: [
      { date: "2026-10-02", exchanges: { Kraken: 50 }, total: 50 },
      { date: "2026-10-05", exchanges: { Kraken: 70 }, total: 70 },
    ],
  };
  const transfers = {
    [LEGACY]: [
      tr(USER, T1, 10000, 250), // +100.00 TEL treasury, day 3 (blocks 201..300)
      tr(CEX, USER, 500, 260), // -5.00 TEL cex
      tr(USER, UPGRADE, 99900, 270), // retired legacy: ignored
      tr(T2, USER, 5000, 350), // -50.00 council, day 4
      tr(USER, CEX, 2500, 360), // +25.00 cex
    ],
    [V3]: [
      tr(UPGRADE, USER, 10n ** 19n, 380), // -10 TEL escrow (v3 released), day 4
    ],
  };
  const base = {
    treasuryHistory,
    cexHistory,
    from: "2026-10-03",
    to: "2026-10-04",
    categories,
    categoryByAddress,
    exchangeByAddress,
    chains,
  };

  it("reconstructs rows across legacy+v3 and validates against the next real row", async () => {
    const result = await reconstructHistory({ ...base, client: makeClient(transfers) });
    expect(result.treasuryRows).toEqual([
      { date: "2026-10-03", categories: { treasury: 1100, council: 500, escrow: 8000 }, backfilled: true },
      { date: "2026-10-04", categories: { treasury: 1100, council: 450, escrow: 7990 }, backfilled: true },
    ]);
    expect(result.cexRows.map((r) => [r.date, r.exchanges.Kraken])).toEqual([
      ["2026-10-03", 45],
      ["2026-10-04", 70],
    ]);
    expect(result.cexRows.every((r) => r.backfilled)).toBe(true);
    expect(worstDrift(result.drift)).toBe(0);
    expect(result.drift.treasury.date).toBe("2026-10-05");
  });

  it("skips v3 fetches before its deploy block and starts after the anchor block", async () => {
    calls.fetches.length = 0;
    await reconstructHistory({ ...base, client: makeClient(transfers) });
    const legacy = calls.fetches.find((f) => f.tokenAddress === LEGACY);
    expect(legacy.fromBlock).toBe(201); // anchor 10-02 boundary 200, +1
    expect(legacy.toBlock).toBe(500); // validation row 10-05
    expect(calls.fetches.find((f) => f.tokenAddress === V3).fromBlock).toBe(201);
  });

  it("reports large drift when the replay disagrees with the next real row", async () => {
    const skewed = { ...transfers, [LEGACY]: transfers[LEGACY].slice(0, 1) };
    const result = await reconstructHistory({ ...base, client: makeClient(skewed) });
    expect(worstDrift(result.drift)).toBeGreaterThan(0.02);
  });

  it("uses cached blocks without asking the client and only fills missing dates", async () => {
    calls.blocks.length = 0;
    const blockCache = Object.fromEntries(
      ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"].map((d) => [d, { eth: blockOf(d) }]),
    );
    const partial = {
      ...base,
      treasuryHistory: { entries: [...treasuryHistory.entries, { date: "2026-10-03", categories: { treasury: 1100, council: 500, escrow: 8000 } }] },
      client: makeClient(transfers),
      blockCache,
    };
    const result = await reconstructHistory(partial);
    expect(calls.blocks).toEqual([]);
    expect(result.treasuryRows.map((r) => r.date)).toEqual(["2026-10-04"]);
  });

  it("skips a date with no earlier anchor and does nothing when nothing is missing", async () => {
    const early = await reconstructHistory({ ...base, from: "2026-10-01", to: "2026-10-01", client: makeClient(transfers) });
    expect(early.skipped.map((s) => s.kind).sort()).toEqual(["cex", "treasury"]);
    expect(early.treasuryRows).toEqual([]);
    const none = await reconstructHistory({ ...base, from: "2026-10-02", to: "2026-10-02", client: makeClient(transfers) });
    expect(none.treasuryRows).toEqual([]);
    expect(none.cexRows).toEqual([]);
  });

  it("records newly resolved blocks for the cache", async () => {
    const result = await reconstructHistory({ ...base, client: makeClient(transfers) });
    expect(result.resolvedBlocks["2026-10-03"]).toEqual({ eth: 300 });
  });
});

describe("trustedAnchor", () => {
  const cats = ["treasury", "holdings"];
  const row = (date, holdings) => ({ date, categories: { treasury: 100, holdings } });
  const entries = [row("09-27", 1230), row("09-28", 1230), row("09-29", 1230), row("10-01", 955), row("10-02", 955), row("10-23", 1230)];

  it("walks past snapshots missing a wallet (deviate from both neighbours)", () => {
    const { anchor, rejected } = trustedAnchor(entries, "10-10", cats);
    expect(anchor.date).toBe("09-29");
    expect(rejected).toEqual(["10-02", "10-01"]);
  });
  it("keeps a genuine step change that matches the later neighbour", () => {
    const stepped = [row("10-01", 1230), row("10-02", 955), row("10-23", 955)];
    expect(trustedAnchor(stepped, "10-10", cats).anchor.date).toBe("10-02");
  });
  it("returns null when every earlier row is untrusted", () => {
    expect(trustedAnchor([row("10-01", 955), row("10-23", 1230)], "10-10", cats).anchor).toBeNull();
  });
});

describe("categoryMapForDate", () => {
  const base = new Map([[T1, "treasury"]]);
  const eras = [{ before: "2026-10-29", categories: { [T2.toUpperCase().replace("0X", "0x")]: "council" } }];
  it("applies old labels only before the boundary", () => {
    expect(categoryMapForDate(base, eras, "2026-10-28").map.get(T2)).toBe("council");
    expect(categoryMapForDate(base, eras, "2026-10-29")).toEqual({ era: "current", map: base });
  });
});

describe("reconstructHistory anchors and label eras", () => {
  const blockOf = (date) => Number(date.slice(8)) * 100;
  const client = (transfers) => ({
    async blockAtEndOfDate(_c, date) {
      return blockOf(date);
    },
    async fetchTransfers({ fromBlock }) {
      return transfers.filter((t) => parseInt(t.blockNumber, 16) >= fromBlock);
    },
  });
  const chains = [{ key: "eth", tokens: [{ address: LEGACY, decimals: 2, generation: "legacy" }] }];
  const categories = ["treasury", "council"];
  const REWARD = "0x" + "77".repeat(20); // relabelled council -> staking
  const categoryByAddress = new Map([[T1, "treasury"], [T2, "council"], [REWARD, "staking"]]);
  const row = (date, treasury, council) => ({ date, categories: { treasury, council } });
  const args = {
    cexHistory: { entries: [] },
    from: "2026-10-05",
    to: "2026-10-05",
    categories,
    categoryByAddress,
    exchangeByAddress: new Map(),
    chains,
    categoryEras: [{ before: "2026-10-29", categories: { [REWARD]: "council" } }],
  };
  // 10-02 lacks 275 treasury (missing wallet); real 09-29 and 10-10 agree. REWARD pays T2 50.00 TEL on day 4.
  const history = { entries: [row("2026-10-01", 1000, 500), row("2026-10-02", 725, 500), row("2026-10-10", 1000, 550)] };
  const transfers = [tr(USER, REWARD, 3000, 350), tr(USER, T2, 1000, 650)]; // REWARD +30 (day 3.5), T2 +10 (day 6)

  it("anchors on the trustworthy row and compares in the anchor era's labels", async () => {
    const result = await reconstructHistory({ ...args, treasuryHistory: history, client: client([tr(USER, REWARD, 3000, 350), tr(USER, T2, 2000, 650)]) });
    expect(result.treasuryRows[0].categories).toEqual({ treasury: 1000, council: 530 });
    expect(worstDrift(result.drift)).toBeLessThan(0.02);
  });
  it("without era labels the reward contract is ignored and drift appears", async () => {
    const result = await reconstructHistory({ ...args, categoryEras: [], treasuryHistory: history, client: client([tr(USER, REWARD, 3000, 350), tr(USER, T2, 2000, 650)]) });
    expect(result.treasuryRows[0].categories.council).toBe(500);
    expect(worstDrift(result.drift)).toBeGreaterThan(0.02);
  });
  it("refuses to replay across a label era boundary", async () => {
    const crossing = { entries: [row("2026-10-27", 1000, 500), row("2026-10-30", 1000, 500)] };
    await expect(
      reconstructHistory({ ...args, from: "2026-10-29", to: "2026-10-29", treasuryHistory: crossing, client: client([]) }),
    ).rejects.toThrow(/label era/);
  });
});

describe("anchor adjustments", () => {
  const adj = [{ date: "2026-10-01", category: "council", add: 50 }];
  it("adds to a copy of the matching row only", () => {
    const e = { date: "2026-10-01", categories: { treasury: 1000, council: 500 } };
    expect(applyAnchorAdjustments(e, adj).categories).toEqual({ treasury: 1000, council: 550 });
    expect(e.categories.council).toBe(500);
    expect(applyAnchorAdjustments({ date: "2026-10-02", categories: { council: 1 } }, adj).categories.council).toBe(1);
    expect(applyAnchorAdjustments(null, adj)).toBeNull();
  });
  it("rejects a malformed adjustment", () => {
    expect(() => applyAnchorAdjustments({ date: "2026-10-01", categories: {} }, adj)).toThrow(/finite/);
  });
  it("closes drift caused by an anchor row that omitted a wallet", async () => {
    const MISSING = "0x" + "58".repeat(20);
    const blockOf = (d) => Number(d.slice(8)) * 100;
    const client = {
      async blockAtEndOfDate(_c, d) {
        return blockOf(d);
      },
      async fetchTransfers() {
        return [tr(MISSING, USER, 1000, 350)]; // -10.00 TEL council on day 3
      },
    };
    const run = (anchorAdjustments) =>
      reconstructHistory({
        treasuryHistory: { entries: [{ date: "2026-09-29", categories: { council: 100 } }, { date: "2026-10-01", categories: { council: 100 } }, { date: "2026-10-05", categories: { council: 190 } }] },
        cexHistory: { entries: [] },
        from: "2026-10-03",
        to: "2026-10-04",
        categories: ["council"],
        categoryByAddress: new Map([[MISSING, "council"]]),
        exchangeByAddress: new Map(),
        chains: [{ key: "eth", tokens: [{ address: LEGACY, decimals: 2, generation: "legacy" }] }],
        client,
        anchorAdjustments,
      });
    expect(worstDrift((await run([])).drift)).toBeGreaterThan(0.4);
    const fixed = await run([{ date: "2026-10-01", category: "council", add: 100 }]);
    expect(worstDrift(fixed.drift)).toBe(0);
    expect(fixed.treasuryRows.map((r) => r.categories.council)).toEqual([200, 190]);
  });
});
