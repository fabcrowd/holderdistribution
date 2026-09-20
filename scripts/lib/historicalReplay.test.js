import { describe, expect, it } from "vitest";
import {
  createReplayLedger,
  createStakeLedger,
  dailyBoundaries,
  findBlockAtTime,
  partitionLogsByBoundary,
  shardRange,
} from "./historicalReplay.js";

const log = (block) => ({ blockNumber: "0x" + block.toString(16), block });

describe("partitionLogsByBoundary", () => {
  it("splits a batch at each boundary, inclusive of the boundary block", () => {
    const logs = [log(1), log(5), log(10), log(11)];
    const runs = partitionLogsByBoundary(logs, [{ date: "d1", block: 5 }, { date: "d2", block: 10 }]);
    expect(runs.map((r) => r.logs.map((l) => l.block))).toEqual([[1, 5], [10], [11]]);
    expect(runs.map((r) => r.boundary?.date ?? null)).toEqual(["d1", "d2", null]);
  });

  it("emits an empty run for a boundary with no logs before it", () => {
    // A quiet day must still produce a snapshot, or that date silently vanishes.
    const runs = partitionLogsByBoundary([log(9)], [{ date: "d1", block: 3 }, { date: "d2", block: 9 }]);
    expect(runs[0]).toEqual({ logs: [], boundary: { date: "d1", block: 3 } });
    expect(runs[1].logs.map((l) => l.block)).toEqual([9]);
  });

  it("sorts out-of-order logs before splitting", () => {
    const runs = partitionLogsByBoundary([log(10), log(2), log(7)], [{ date: "d1", block: 7 }]);
    expect(runs[0].logs.map((l) => l.block)).toEqual([2, 7]);
    expect(runs[1].logs.map((l) => l.block)).toEqual([10]);
  });

  it("accepts decimal blockNumber and drops malformed logs", () => {
    const runs = partitionLogsByBoundary(
      [{ blockNumber: 4 }, { blockNumber: null }, { foo: 1 }],
      [{ date: "d1", block: 4 }],
    );
    expect(runs[0].logs).toHaveLength(1);
  });

  it("returns no trailing run when every log falls inside a boundary", () => {
    const runs = partitionLogsByBoundary([log(1)], [{ date: "d1", block: 5 }]);
    expect(runs).toHaveLength(1);
  });

  it("handles empty input", () => {
    expect(partitionLogsByBoundary([], [])).toEqual([]);
    expect(partitionLogsByBoundary(null, null)).toEqual([]);
  });
});

describe("findBlockAtTime", () => {
  // Synthetic chain: block N has timestamp N * 12.
  const getTimestamp = async (block) => block * 12;

  it("finds the last block at or before the target", async () => {
    expect(await findBlockAtTime(1200, { low: 0, high: 500, getTimestamp })).toBe(100);
  });

  it("returns the block itself when the target lands exactly on one", async () => {
    expect(await findBlockAtTime(120, { low: 0, high: 500, getTimestamp })).toBe(10);
  });

  it("returns null when the chain has not reached the target time", async () => {
    expect(await findBlockAtTime(5, { low: 10, high: 500, getTimestamp })).toBeNull();
  });

  it("clamps to the high end when the target is past chain head", async () => {
    expect(await findBlockAtTime(999_999, { low: 0, high: 500, getTimestamp })).toBe(500);
  });

  it("terminates when the range is a single block", async () => {
    expect(await findBlockAtTime(120, { low: 10, high: 10, getTimestamp })).toBe(10);
  });
});

describe("dailyBoundaries", () => {
  it("emits one entry per UTC day, inclusive of both ends", () => {
    const out = dailyBoundaries("2026-01-01", "2026-01-04");
    expect(out.map((b) => b.date)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
    expect(out[0].seconds).toBe(Date.parse("2026-01-01T00:00:00Z") / 1000);
  });

  it("handles a single-day range", () => {
    expect(dailyBoundaries("2026-01-01", "2026-01-01")).toHaveLength(1);
  });
});

describe("shardRange", () => {
  it("splits an evenly-divisible range into equal contiguous shards", () => {
    expect(shardRange(0, 99, 4)).toEqual([
      { fromBlock: 0, toBlock: 24 },
      { fromBlock: 25, toBlock: 49 },
      { fromBlock: 50, toBlock: 74 },
      { fromBlock: 75, toBlock: 99 },
    ]);
  });

  it("covers every block exactly once with no gaps or overlaps", () => {
    for (const n of [1, 2, 3, 5, 7]) {
      const shards = shardRange(1000, 1050, n);
      const covered = new Set();
      for (const { fromBlock, toBlock } of shards) {
        for (let b = fromBlock; b <= toBlock; b++) {
          expect(covered.has(b)).toBe(false); // no overlap
          covered.add(b);
        }
      }
      expect(covered.size).toBe(51); // no gaps
    }
  });

  it("produces fewer shards than requested when the range is smaller than n", () => {
    // 3 blocks split 10 ways can't yield 10 non-empty shards.
    const shards = shardRange(0, 2, 10);
    expect(shards.length).toBeLessThanOrEqual(3);
    expect(shards[shards.length - 1].toBlock).toBe(2);
  });

  it("handles a single-block range", () => {
    expect(shardRange(5, 5, 3)).toEqual([{ fromBlock: 5, toBlock: 5 }]);
  });

  it("throws for n < 1", () => {
    expect(() => shardRange(0, 10, 0)).toThrow();
  });
});

describe("createReplayLedger", () => {
  const A = "0xaaa";
  const B = "0xbbb";

  it("accumulates transfers and scales by decimals", () => {
    const ledger = createReplayLedger({ decimals: 2 });
    ledger.apply([{ from: null, to: A, value: 5000n }]);
    expect(ledger.snapshot().get(A)).toBe(50);
  });

  it("snapshots without destroying state, so the replay can continue", () => {
    // buildBalanceMap()'s finalize() clears its map; a replay must not.
    const ledger = createReplayLedger();
    ledger.apply([{ from: null, to: A, value: 100n }]);
    const first = ledger.snapshot();
    ledger.apply([{ from: null, to: A, value: 100n }]);
    const second = ledger.snapshot();
    expect(first.get(A)).toBe(1);
    expect(second.get(A)).toBe(2);
  });

  it("drops balances below the dust floor", () => {
    const ledger = createReplayLedger({ minRaw: 10n });
    ledger.apply([{ from: null, to: A, value: 9n }, { from: null, to: B, value: 10n }]);
    const snap = ledger.snapshot();
    expect(snap.has(A)).toBe(false);
    expect(snap.has(B)).toBe(true);
  });

  it("excludes a wallet that has been fully spent", () => {
    const ledger = createReplayLedger();
    ledger.apply([{ from: null, to: A, value: 500n }]);
    ledger.apply([{ from: A, to: B, value: 500n }]);
    expect(ledger.snapshot().has(A)).toBe(false);
    expect(ledger.snapshot().get(B)).toBe(5);
  });

  it("round-trips through serialize/restore for resume", () => {
    const ledger = createReplayLedger();
    ledger.apply([{ from: null, to: A, value: 12345n }]);
    const revived = createReplayLedger();
    revived.restore(ledger.serialize());
    expect(revived.snapshot().get(A)).toBe(123.45);
  });
});

describe("createStakeLedger", () => {
  const A = "0xaaa";

  it("takes newStake as absolute, latest event wins", () => {
    const ledger = createStakeLedger();
    ledger.apply([{ account: A, newStake: 1000n }]);
    ledger.apply([{ account: A, newStake: 300n }]);
    expect(ledger.snapshot().get(A)).toBe(3);
  });

  it("drops an account that has fully unstaked", () => {
    const ledger = createStakeLedger();
    ledger.apply([{ account: A, newStake: 1000n }]);
    ledger.apply([{ account: A, newStake: 0n }]);
    expect(ledger.snapshot().has(A)).toBe(false);
  });

  it("round-trips through serialize/restore", () => {
    const ledger = createStakeLedger();
    ledger.apply([{ account: A, newStake: 4200n }]);
    const revived = createStakeLedger();
    revived.restore(ledger.serialize());
    expect(revived.snapshot().get(A)).toBe(42);
  });
});
