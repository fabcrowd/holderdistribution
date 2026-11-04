import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getLogs, rpcCall, RangeFloorError, __resetRpcCachesForTests } from "./rpc.js";
import { createLogsFailover } from "./logsFailover.js";
import { parseRetryAfter, backoffMs, isLimitedPublicUrl, acquire, __resetLimiterForTests } from "./rpcLimiter.js";

const TENDERLY = "https://gateway.tenderly.co/public/mainnet";
const MEV = "https://rpc.mevblocker.io";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const span = (init) => {
  const f = JSON.parse(init.body).params[0];
  return [Number.parseInt(f.fromBlock, 16), Number.parseInt(f.toBlock, 16)];
};

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  process.env.RPC_LIMITS_JSON = JSON.stringify({
    "gateway.tenderly.co": { rps: 1000, burst: 1000, concurrency: 4 },
    "rpc.mevblocker.io": { rps: 1000, burst: 1000, concurrency: 4 },
  });
  process.env.RPC_MIN_SPLIT_BLOCKS = "10";
  __resetRpcCachesForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RPC_LIMITS_JSON;
  delete process.env.RPC_MIN_SPLIT_BLOCKS;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("limiter scope", () => {
  it("limits only configured public hosts, never Alchemy", () => {
    expect(isLimitedPublicUrl(TENDERLY)).toBe(true);
    expect(isLimitedPublicUrl("https://eth-mainnet.g.alchemy.com/v2/k")).toBe(false);
    expect(isLimitedPublicUrl("https://api.mainnet-beta.solana.com")).toBe(true);
  });

  it("caps concurrency per host", async () => {
    process.env.RPC_LIMITS_JSON = JSON.stringify({ "rpc.mevblocker.io": { rps: 1000, burst: 1000, concurrency: 2 } });
    __resetLimiterForTests();
    let inFlight = 0, peak = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      const release = await acquire(MEV);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; release();
    }));
    expect(peak).toBe(2);
  });
});

describe("Retry-After + jittered backoff", () => {
  it("parses delta-seconds and HTTP-date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeNull();
  });
  it("never waits 0 ms and honours Retry-After", () => {
    expect(backoffMs(0, { retryAfterMs: 0, random: () => 0 })).toBeGreaterThanOrEqual(500);
    expect(backoffMs(0, { retryAfterMs: 7000, random: () => 0 })).toBe(7000);
    expect(backoffMs(10, { random: () => 1 })).toBe(60_000);
  });
  it("a 429 with Retry-After: 0 is retried after a real delay, then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    globalThis.fetch = vi.fn(async () => (n++ < 2 ? new Response("<html>", { status: 429, headers: { "retry-after": "0" } }) : json({ jsonrpc: "2.0", id: 1, result: "0x10" })));
    const p = rpcCall(MEV, "eth_blockNumber", []);
    await vi.advanceTimersByTimeAsync(400);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no instant hammering
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(p).resolves.toBe("0x10");
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("eth_getLogs split floor", () => {
  it("never requests a range below the floor and throws RangeFloorError", async () => {
    const seen = [];
    globalThis.fetch = vi.fn(async (_u, init) => {
      const [a, b] = span(init);
      seen.push(b - a + 1);
      return json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "query returned more than 10000 results" } });
    });
    await expect(getLogs(TENDERLY, { fromBlock: "0x0", toBlock: "0x270f", address: "0x1", topics: [] })).rejects.toBeInstanceOf(RangeFloorError);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(10);
    expect(seen.length).toBeLessThan(20);
  });

  it("a dense cluster does not shrink the span for the rest of the scan", async () => {
    const seen = [];
    globalThis.fetch = vi.fn(async (_u, init) => {
      const [a, b] = span(init);
      seen.push([a, b]);
      if (a <= 5000 && b >= 5000 && b - a + 1 > 40) return json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "query returned more than 10000 results" } });
      return json({ jsonrpc: "2.0", id: 1, result: [{ blockNumber: "0x" + a.toString(16) }] });
    });
    await getLogs(TENDERLY, { fromBlock: "0x0", toBlock: "0x270f", address: "0x1", topics: [] });
    // Next chunk goes out at full width again.
    seen.length = 0;
    await getLogs(TENDERLY, { fromBlock: "0x2710", toBlock: "0x4e1f", address: "0x1", topics: [] });
    expect(seen).toEqual([[10000, 19999]]);
  });

  it("covers the whole range exactly once when splitting", async () => {
    globalThis.fetch = vi.fn(async (_u, init) => {
      const [a, b] = span(init);
      if (b - a + 1 > 300) return json({ jsonrpc: "2.0", id: 1, error: { message: "Query returned more than 20000 results" } });
      const out = [];
      for (let x = a; x <= b; x++) out.push({ n: x });
      return json({ jsonrpc: "2.0", id: 1, result: out });
    });
    const logs = await getLogs(MEV, { fromBlock: "0x0", toBlock: "0x3e7", address: "0x1", topics: [] });
    expect(logs.map((l) => l.n)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });

  it("failover rotates endpoints for rounds, then rejects (no infinite loop)", async () => {
    const calls = [];
    const failover = createLogsFailover(async (url) => {
      calls.push(url);
      throw new RangeFloorError("floor");
    }, { warn: () => {} }, { sleep: async () => {} });
    process.env.RPC_FAILOVER_ROUNDS = "3";
    await expect(failover([TENDERLY, MEV], 0, { fromBlock: "0x1", toBlock: "0x2" })).rejects.toThrow("floor");
    delete process.env.RPC_FAILOVER_ROUNDS;
    expect(calls).toEqual([TENDERLY, MEV, TENDERLY, MEV, TENDERLY, MEV]);
  });

  it("failover rotates to another endpoint when one hits the floor", async () => {
    const failover = createLogsFailover(async (url) => {
      if (url === TENDERLY) throw new RangeFloorError("floor");
      return [{ ok: 1 }];
    }, { warn: () => {} }, { sleep: async () => {} });
    await expect(failover([TENDERLY, MEV], 0, { fromBlock: "0x1", toBlock: "0x2" })).resolves.toEqual([{ ok: 1 }]);
  });
});
