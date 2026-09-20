import { describe, expect, it } from "vitest";
import {
  balanceAsOfWorkingBackwards,
  buildTransferDeltas,
  collectDexAddresses,
  normalizeAddress,
  rawToTel,
  sumDexLiquidityAt,
} from "./dexLiquidityHistory.js";

describe("collectDexAddresses", () => {
  it("merges exclusions dex labels with pools and routers", () => {
    const set = collectDexAddresses(
      {
        labels: {
          "0xAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": { category: "dex" },
          "0xBBBBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": { category: "cex" },
        },
      },
      {
        pools: [{ address: "0xCCCCcccccccccccccccccccccccccccccccccccc" }],
        routers: [{ address: "0xDDDDdddddddddddddddddddddddddddddddddddd" }],
      },
    );
    expect(set.size).toBe(3);
    expect(set.has("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(set.has("0xcccccccccccccccccccccccccccccccccccccccc")).toBe(true);
    expect(set.has("0xdddddddddddddddddddddddddddddddddddddddd")).toBe(true);
    expect(set.has("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
  });
});

describe("normalizeAddress", () => {
  it("lowercases and rejects junk", () => {
    expect(normalizeAddress(" 0xAbCDef0123456789AbCDef0123456789AbCDef01 ")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
    expect(normalizeAddress("not-an-address")).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
  });
});

describe("buildTransferDeltas", () => {
  const pool = "0x1111111111111111111111111111111111111111";
  const other = "0x2222222222222222222222222222222222222222";

  it("records inflows and outflows and skips self-transfers / dupes", () => {
    const events = buildTransferDeltas(
      [
        { from: other, to: pool, value: "500", timeStamp: "100", hash: "0xh1", logIndex: "0" },
        { from: pool, to: other, value: "200", timeStamp: "200", hash: "0xh2", logIndex: "1" },
        { from: pool, to: pool, value: "999", timeStamp: "250", hash: "0xh3", logIndex: "0" },
        // dupe
        { from: other, to: pool, value: "500", timeStamp: "100", hash: "0xh1", logIndex: "0" },
      ],
      pool,
    );
    expect(events).toHaveLength(2);
    expect(events[0].delta).toBe(500n);
    expect(events[1].delta).toBe(-200n);
  });
});

describe("balanceAsOfWorkingBackwards", () => {
  it("reverses post-sample transfers from the current balance", () => {
    const day1 = Date.parse("2026-01-18") + 86400000 - 1;
    const day2 = Date.parse("2026-01-19") + 86400000 - 1;
    const timeline = [
      { ts: Date.parse("2026-01-18T12:00:00Z"), delta: 1000n },
      { ts: Date.parse("2026-01-19T12:00:00Z"), delta: -300n },
      { ts: Date.parse("2026-01-20T12:00:00Z"), delta: 50n },
    ];
    // Current balance after all events = 750
    const current = 750n;
    expect(balanceAsOfWorkingBackwards(timeline, day2, current)).toBe(700n); // before +50
    expect(balanceAsOfWorkingBackwards(timeline, day1, current)).toBe(1000n); // before -300 and +50
  });

  it("clamps negative reconstruction to zero", () => {
    const eod = Date.parse("2026-01-18") + 86400000 - 1;
    // Current is 0; an inflow after EOD implies reversing it would go negative
    // without a clamp (API dust / missing pre-window mint).
    const timeline = [{ ts: Date.parse("2026-01-19T00:00:00Z"), delta: 10n }];
    expect(balanceAsOfWorkingBackwards(timeline, eod, 0n)).toBe(0n);
  });
});

describe("rawToTel / sumDexLiquidityAt", () => {
  it("converts 2-decimal raw to rounded TEL", () => {
    expect(rawToTel(97321087100n, 2)).toBe(973210871);
    expect(rawToTel(150n, 2)).toBe(2); // 1.50 → 2
    expect(rawToTel(149n, 2)).toBe(1); // 1.49 → 1
  });

  it("sums multiple legs at a sample day", () => {
    const eod = Date.parse("2026-03-01") + 86400000 - 1;
    const legs = [
      {
        currentRaw: 10000n, // 100.00 TEL
        timeline: [{ ts: Date.parse("2026-03-02T00:00:00Z"), delta: 2000n }],
      },
      {
        currentRaw: 5000n,
        timeline: [],
      },
    ];
    // At Mar 1: first leg 80 TEL, second 50 TEL → 130
    expect(sumDexLiquidityAt(legs, eod, 2)).toBe(130);
  });
});
