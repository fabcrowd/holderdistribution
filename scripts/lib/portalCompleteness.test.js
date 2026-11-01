import { describe, expect, it, vi } from "vitest";
import {
  PortalCompletenessError,
  assertPortalComplete,
  completenessSampleConfig,
  compareLogSets,
  describeCompleteness,
  logKey,
  sampleWindows,
  verifyPortalCompleteness,
} from "./portalCompleteness.js";

const TOKEN = "0x" + "ab".repeat(20);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const URLS = ["https://rpc-a.test", "https://rpc-b.test"];
const SAMPLE = { blocks: 100, windows: 2 };
const hash = (n) => "0x" + n.toString(16).padStart(64, "0");
const hexOf = (n) => "0x" + n.toString(16);

/** An RPC-shaped log (what eth_getLogs and mapPortalLog both return). */
function logAt(block, logIndex, tx = hash(block * 1000 + logIndex)) {
  return {
    address: TOKEN,
    topics: [TRANSFER, hash(1), hash(2)],
    data: "0x" + "00".repeat(31) + "0a",
    transactionHash: tx,
    blockNumber: hexOf(block),
    logIndex: hexOf(logIndex),
  };
}

/** A fake RPC failover: answers each filter from `chainLogs` by its block bounds. */
function rpcFrom(chainLogs) {
  return vi.fn(async (_urls, _preferredIdx, filter) => {
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = Number.parseInt(filter.toBlock, 16);
    return chainLogs.filter((l) => {
      const n = Number.parseInt(l.blockNumber, 16);
      return n >= from && n <= to;
    });
  });
}

const FILTER = { address: [TOKEN], topics: [TRANSFER] };

function verifyArgs(overrides = {}) {
  return {
    chain: "base",
    urls: URLS,
    filterBase: FILTER,
    portalLogs: [],
    fromBlock: 1,
    toBlock: 1000,
    failover: rpcFrom([]),
    sample: SAMPLE,
    ...overrides,
  };
}

describe("sampleWindows", () => {
  it("places one window at the start and one at the end of the range", () => {
    expect(sampleWindows(1, 1000, { blocks: 100, windows: 2 })).toEqual([
      { from: 1, to: 100 },
      { from: 901, to: 1000 },
    ]);
  });

  it("uses a single window covering the whole range when the range is shorter than a window", () => {
    expect(sampleWindows(50, 80, { blocks: 100, windows: 2 })).toEqual([{ from: 50, to: 80 }]);
  });

  it("uses only the start window when windows is 1", () => {
    expect(sampleWindows(1, 1000, { blocks: 100, windows: 1 })).toEqual([{ from: 1, to: 100 }]);
  });

  it("returns no windows for an empty range", () => {
    expect(sampleWindows(500, 499, { blocks: 100, windows: 2 })).toEqual([]);
  });
});

describe("completenessSampleConfig", () => {
  it("defaults to 5,000-block windows, six per chain", () => {
    expect(completenessSampleConfig({})).toEqual({ blocks: 5000, windows: 6 });
  });

  it("reads overrides from env", () => {
    const env = { PORTAL_COMPLETENESS_BLOCKS: "500", PORTAL_COMPLETENESS_WINDOWS: "3" };
    expect(completenessSampleConfig(env)).toEqual({ blocks: 500, windows: 3 });
  });

  it("caps the window size at the chain's log span", () => {
    expect(completenessSampleConfig({}, 750)).toEqual({ blocks: 750, windows: 6 });
  });

  it("rejects a non-positive or non-integer override", () => {
    expect(() => completenessSampleConfig({ PORTAL_COMPLETENESS_BLOCKS: "0" })).toThrow(/PORTAL_COMPLETENESS_BLOCKS/);
    expect(() => completenessSampleConfig({ PORTAL_COMPLETENESS_WINDOWS: "1.5" })).toThrow(/PORTAL_COMPLETENESS_WINDOWS/);
  });
});

describe("logKey and compareLogSets", () => {
  it("keys a log by lowercase transactionHash and decimal logIndex, whatever the encoding", () => {
    expect(logKey({ transactionHash: "0xABCD", logIndex: "0x1" })).toBe(logKey({ transactionHash: "0xabcd", logIndex: 1 }));
  });

  it("reports keys present on one side only", () => {
    const a = logAt(10, 0);
    const b = logAt(10, 1);
    const result = compareLogSets([a], [a, b]);
    expect(result).toMatchObject({ portalCount: 1, rpcCount: 2 });
    expect(result.missing).toEqual([logKey(b)]);
    expect(result.extra).toEqual([]);
  });
});

describe("verifyPortalCompleteness", () => {
  it("passes when Portal and RPC hold the same log keys", async () => {
    const chainLogs = [logAt(10, 0), logAt(950, 1), logAt(960, 0)];
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs: chainLogs, failover: rpcFrom(chainLogs) }));
    expect(result).toMatchObject({ ok: true, chain: "base", missingCount: 0, extraCount: 0, portalCount: 3, rpcCount: 3 });
    expect(result.windows).toHaveLength(2);
  });

  it("fails with the missing key when Portal is short of RPC", async () => {
    const chainLogs = [logAt(10, 0), logAt(10, 1), logAt(950, 0)];
    const portalLogs = [logAt(10, 0), logAt(950, 0)];
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs, failover: rpcFrom(chainLogs) }));
    expect(result).toMatchObject({ ok: false, missingCount: 1, extraCount: 0 });
    expect(result.missing).toEqual([logKey(logAt(10, 1))]);
  });

  it("fails with the extra key when Portal has a log RPC does not", async () => {
    const chainLogs = [logAt(10, 0)];
    const portalLogs = [logAt(10, 0), logAt(20, 0)];
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs, failover: rpcFrom(chainLogs) }));
    expect(result).toMatchObject({ ok: false, missingCount: 0, extraCount: 1 });
    expect(result.extra).toEqual([logKey(logAt(20, 0))]);
  });

  it("ignores Portal and RPC logs outside the sampled windows", async () => {
    const chainLogs = [logAt(10, 0), logAt(5000, 0)];
    const portalLogs = [logAt(10, 0), logAt(5000, 0), logAt(5000, 1)];
    const result = await verifyPortalCompleteness(verifyArgs({ toBlock: 10_000, portalLogs, failover: rpcFrom(chainLogs) }));
    expect(result).toMatchObject({ ok: true, portalCount: 1, rpcCount: 1 });
  });

  it("treats an empty window on both sides as ok", async () => {
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs: [], failover: rpcFrom([]) }));
    expect(result).toMatchObject({ ok: true, portalCount: 0, rpcCount: 0, missingCount: 0, extraCount: 0 });
  });

  it("returns ok with no windows and makes no RPC call for an empty range", async () => {
    const failover = rpcFrom([]);
    const result = await verifyPortalCompleteness(verifyArgs({ fromBlock: 2000, toBlock: 1999, failover }));
    expect(result).toMatchObject({ ok: true, windows: [] });
    expect(failover).not.toHaveBeenCalled();
  });

  it("queries RPC with the same filter and hex window bounds", async () => {
    const failover = rpcFrom([]);
    await verifyPortalCompleteness(verifyArgs({ failover }));
    expect(failover).toHaveBeenCalledWith(URLS, 0, { ...FILTER, fromBlock: "0x1", toBlock: "0x64" });
    expect(failover).toHaveBeenCalledWith(URLS, 0, { ...FILTER, fromBlock: "0x385", toBlock: "0x3e8" });
  });

  it("surfaces an RPC failure as PortalCompletenessError, never as ok", async () => {
    const boom = new Error("rpc down");
    const failover = vi.fn(async () => {
      throw boom;
    });
    const attempt = verifyPortalCompleteness(verifyArgs({ failover }));
    await expect(attempt).rejects.toBeInstanceOf(PortalCompletenessError);
    await expect(attempt).rejects.toMatchObject({ chain: "base", cause: boom });
  });

  it("caps the listed missing keys at five but keeps the full count", async () => {
    const chainLogs = Array.from({ length: 8 }, (_, i) => logAt(10, i));
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs: [], failover: rpcFrom(chainLogs) }));
    expect(result.missingCount).toBe(8);
    expect(result.missing).toHaveLength(5);
  });

  it("sizes windows by the sample config and never beyond the chain log span", async () => {
    const failover = rpcFrom([]);
    const result = await verifyPortalCompleteness(verifyArgs({ failover, toBlock: 5000, sample: { blocks: 2000, windows: 1 }, maxWindow: 500 }));
    expect(result.windows).toEqual([expect.objectContaining({ from: 1, to: 500 })]);
  });
});

describe("assertPortalComplete (refuse-to-write gate)", () => {
  it("returns quietly when the check passed", async () => {
    const chainLogs = [logAt(10, 0)];
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs: chainLogs, failover: rpcFrom(chainLogs) }));
    expect(() => assertPortalComplete(result)).not.toThrow();
  });

  it("throws on missing keys so the caller never reaches the output write", async () => {
    const chainLogs = [logAt(10, 0), logAt(10, 1)];
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs: [logAt(10, 0)], failover: rpcFrom(chainLogs) }));
    expect(() => assertPortalComplete(result)).toThrow(PortalCompletenessError);
    expect(() => assertPortalComplete(result)).toThrow(/base.*1 missing/);
  });

  it("names only the chain and counts in the message, never the log keys", async () => {
    const chainLogs = [logAt(10, 0)];
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs: [], failover: rpcFrom(chainLogs) }));
    let thrown;
    try {
      assertPortalComplete(result);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: "PortalCompletenessError", chain: "base", missingCount: 1, extraCount: 0 });
    expect(thrown.message).not.toContain(logKey(logAt(10, 0)));
  });
});

describe("describeCompleteness", () => {
  it("gives a one-line pass summary with chain, key count and window count", async () => {
    const chainLogs = [logAt(10, 0), logAt(950, 0)];
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs: chainLogs, failover: rpcFrom(chainLogs) }));
    const line = describeCompleteness(result);
    expect(line).toMatch(/^base: portal completeness ok/);
    expect(line).toContain("2 keys");
    expect(line).toContain("2 sampled windows");
    expect(line).not.toContain("\n");
  });

  it("names the mismatch counts on failure", async () => {
    const chainLogs = [logAt(10, 0), logAt(10, 1)];
    const result = await verifyPortalCompleteness(verifyArgs({ portalLogs: [logAt(10, 0)], failover: rpcFrom(chainLogs) }));
    expect(describeCompleteness(result)).toMatch(/^base: portal completeness FAILED \(1 missing, 0 extra/);
  });
});
