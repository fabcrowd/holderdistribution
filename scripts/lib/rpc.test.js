import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { getLogs, getUsableRpcUrls, getPublicFallbackUrls, __resetRpcCachesForTests } from "./rpc.js";

const hex = (n) => "0x" + n.toString(16);
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  __resetRpcCachesForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  delete process.env.ETH_RPC_0;
  delete process.env.PUBLIC_RPC_FALLBACK;
});

describe("getLogs range-limit handling", () => {
  it("bisects when a provider rejects a range with vague 'too large' wording, then remembers the span", async () => {
    const MAX = 1000; // this fake provider accepts at most 1000 blocks
    const calls = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      const { params } = JSON.parse(init.body);
      const from = Number.parseInt(params[0].fromBlock, 16);
      const to = Number.parseInt(params[0].toBlock, 16);
      calls.push(to - from + 1);
      if (to - from + 1 > MAX) {
        // Tenderly-style: generic message, actionable text in error.data.
        return jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params", data: "Block range too large for public access" } });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: [{ blockNumber: hex(from), topics: [], data: "0x" }] });
    });

    const filter = { fromBlock: hex(0), toBlock: hex(3999), address: "0xabc", topics: [] };
    const logs = await getLogs("https://rpc.example/a", filter);
    // 4000 blocks -> bisected to 2000 -> 1000: four 1000-block windows succeed.
    expect(logs).toHaveLength(4);

    // Second call over the same URL goes straight to <=1000-block windows: no new rejection.
    calls.length = 0;
    await getLogs("https://rpc.example/a", filter);
    expect(calls.every((c) => c <= MAX)).toBe(true);
  });

  it("still honours an explicit 'up to N block range' limit", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      const { params } = JSON.parse(init.body);
      const span = Number.parseInt(params[0].toBlock, 16) - Number.parseInt(params[0].fromBlock, 16) + 1;
      if (span > 10) return jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "you can make eth_getLogs requests with up to a 10 block range" } });
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: [{}] });
    });
    const logs = await getLogs("https://rpc.example/b", { fromBlock: hex(0), toBlock: hex(29), address: "0xabc", topics: [] });
    expect(logs).toHaveLength(3);
  });

  it("does not swallow unrelated errors", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" } }));
    await expect(getLogs("https://rpc.example/c", { fromBlock: hex(0), toBlock: hex(99), address: "0xabc", topics: [] })).rejects.toThrow(/execution reverted/);
  });
});

describe("getLogs on nodes without archive history", () => {
  it("fails fast on a 403 'Archive requests' response instead of retrying with backoff", async () => {
    // publicnode answers old-block queries with a 403 that no retry can fix.
    // Retrying it five times with 2s..32s backoff cost ~60s per call, which made
    // the v3 scan (starts weeks back, at the v3 deployment block) unusable.
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(
        { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Archive requests require a personal token." } },
        403,
      ),
    );
    const started = Date.now();
    await expect(
      getLogs("https://rpc.example/archive", { fromBlock: hex(1), toBlock: hex(10), address: "0xabc", topics: [] }),
    ).rejects.toThrow(/Archive requests/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("still retries an ordinary 403/429 (quota) response", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: [] });
    });
    await expect(
      getLogs("https://rpc.example/quota", { fromBlock: hex(1), toBlock: hex(10), address: "0xabc", topics: [] }),
    ).resolves.toEqual([]);
    expect(n).toBe(2);
  });
});

describe("getUsableRpcUrls public fallback", () => {
  const quotaError = { jsonrpc: "2.0", id: 1, error: { code: 429, message: "Monthly capacity limit exceeded." } };

  it("falls back to keyless public endpoints when every configured key is over quota", async () => {
    process.env.ETH_RPC_0 = "https://eth-mainnet.g.alchemy.com/v2/deadkey";
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes("alchemy") ? jsonResponse(quotaError, 429) : jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }),
    );
    const urls = await getUsableRpcUrls("ethereum", { logger: { log() {}, warn() {} } });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes("alchemy"))).toBe(true);
    expect(urls).toEqual(getPublicFallbackUrls("ethereum"));
  });

  it("keeps using configured keys (no public fallback) while at least one works", async () => {
    process.env.ETH_RPC_0 = "https://eth-mainnet.g.alchemy.com/v2/goodkey";
    globalThis.fetch = vi.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    const urls = await getUsableRpcUrls("ethereum", { logger: { log() {}, warn() {} } });
    expect(urls).toEqual(["https://eth-mainnet.g.alchemy.com/v2/goodkey"]);
  });

  it("can be disabled with PUBLIC_RPC_FALLBACK=off", async () => {
    process.env.ETH_RPC_0 = "https://eth-mainnet.g.alchemy.com/v2/deadkey";
    process.env.PUBLIC_RPC_FALLBACK = "off";
    globalThis.fetch = vi.fn(async () => jsonResponse(quotaError, 429));
    await expect(getUsableRpcUrls("ethereum", { logger: { log() {}, warn() {} } })).rejects.toThrow(/No usable RPC URLs/);
  });
});

describe("RPC_PREFER_PUBLIC", () => {
  afterEach(() => {
    delete process.env.RPC_PREFER_PUBLIC;
  });

  it("uses public endpoints first even when a configured key works", async () => {
    process.env.ETH_RPC_0 = "https://eth-mainnet.g.alchemy.com/v2/goodkey";
    process.env.RPC_PREFER_PUBLIC = "1";
    globalThis.fetch = vi.fn(async () => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    const urls = await getUsableRpcUrls("ethereum", { logger: { log() {}, warn() {} } });
    expect(urls).toEqual(getPublicFallbackUrls("ethereum"));
  });

  it("falls back to configured keys when no public endpoint answers", async () => {
    process.env.ETH_RPC_0 = "https://eth-mainnet.g.alchemy.com/v2/goodkey";
    process.env.RPC_PREFER_PUBLIC = "true";
    globalThis.fetch = vi.fn(async (url) =>
      String(url).includes("alchemy") ? jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }) : jsonResponse({}, 503),
    );
    const urls = await getUsableRpcUrls("ethereum", { logger: { log() {}, warn() {} } });
    expect(urls).toEqual(["https://eth-mainnet.g.alchemy.com/v2/goodkey"]);
  });
});

describe("workflow cost guards", () => {
  // Private-repo Actions minutes are billed; an unbounded job (360-minute default)
  // that fails slowly is how the included minutes were exhausted in October 2026.
  for (const file of ["refresh-tel-holders.yml", "pipeline-watchdog.yml"]) {
    it(`${file} has a timeout on every job and shares the holders-refresh concurrency group`, () => {
      const wf = yaml.parse(fs.readFileSync(path.resolve(process.cwd(), ".github/workflows", file), "utf8"));
      for (const job of Object.values(wf.jobs)) {
        // The refresh matrix job takes its cap per project from config (an expression).
        if (typeof job["timeout-minutes"] === "string") {
          expect(job["timeout-minutes"]).toBe("${{ matrix.timeout }}");
          continue;
        }
        expect(job["timeout-minutes"]).toBeGreaterThan(0);
        expect(job["timeout-minutes"]).toBeLessThanOrEqual(120);
      }
      expect(wf.concurrency.group).toBe("holders-refresh");
      expect(wf.concurrency["cancel-in-progress"]).toBe(false);
    });
  }
});
