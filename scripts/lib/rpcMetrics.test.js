import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __flushRpcMetricsForTests,
  __resetRpcMetricsForTests,
  classifyProvider,
  estimateUsage,
  recordCall,
  snapshotCalls,
} from "./rpcMetrics.js";
import { rpcCall } from "./rpc.js";

const ALCHEMY_URL = "https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123";
const readLines = (file) =>
  fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("classifyProvider", () => {
  it("classifies by host only", () => {
    expect(classifyProvider("https://polygon-mainnet.g.alchemy.com/v2/secret")).toBe("alchemy");
    expect(classifyProvider("https://mainnet.helius-rpc.com/?api-key=secret")).toBe("helius");
    expect(classifyProvider("https://api.mainnet-beta.solana.com")).toBe("public");
    expect(classifyProvider("not a url")).toBe("public");
  });
});

describe("estimateUsage", () => {
  it("applies the Alchemy rate card and Helius credits, unknown methods use the default", () => {
    const calls = {
      alchemy: { eth_call: 2, eth_getLogs: 1, some_new_method: 1 },
      helius: { getTransaction: 3, getProgramAccounts: 1 },
      public: { eth_blockNumber: 5 },
    };
    expect(estimateUsage(calls)).toEqual({
      alchemyCu: 2 * 26 + 75 + 26,
      heliusCredits: 3 + 10,
      alchemyCalls: 4,
      heliusCalls: 4,
      publicCalls: 5,
    });
  });
});

describe("recording", () => {
  const original = process.env.HD_METRICS_FILE;
  let dir;
  beforeEach(() => {
    __resetRpcMetricsForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-metrics-"));
  });
  afterEach(() => {
    if (original === undefined) delete process.env.HD_METRICS_FILE;
    else process.env.HD_METRICS_FILE = original;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("counts rpcCall requests per provider and method, never storing the URL", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 }));
    await rpcCall("https://eth-mainnet.g.alchemy.com/v2/topsecretkey", "eth_blockNumber");
    await rpcCall("https://eth-mainnet.g.alchemy.com/v2/topsecretkey", "eth_blockNumber");
    await rpcCall("https://ethereum-rpc.publicnode.com", "eth_call", []);
    expect(snapshotCalls()).toEqual({ alchemy: { eth_blockNumber: 2 }, public: { eth_call: 1 } });
    expect(JSON.stringify(snapshotCalls())).not.toMatch(/topsecretkey/);
  });

  it("appends one line on flush when HD_METRICS_FILE is set, with totals and no URLs", () => {
    const file = path.join(dir, "nested", "metrics.ndjson");
    process.env.HD_METRICS_FILE = file;
    recordCall("https://eth-mainnet.g.alchemy.com/v2/topsecretkey", "eth_getLogs");
    recordCall("https://mainnet.helius-rpc.com/?api-key=topsecretkey", "getTransaction");
    __flushRpcMetricsForTests();
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ alchemyCu: 75, heliusCredits: 1, alchemyCalls: 1, heliusCalls: 1, publicCalls: 0 });
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/topsecretkey/);
  });

  it("writes nothing when HD_METRICS_FILE is unset", () => {
    delete process.env.HD_METRICS_FILE;
    recordCall("https://eth-mainnet.g.alchemy.com/v2/k", "eth_call");
    __flushRpcMetricsForTests();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("writes only the calls since the previous flush, so the lines add up", () => {
    const file = path.join(dir, "metrics.ndjson");
    process.env.HD_METRICS_FILE = file;
    for (let i = 0; i < 3; i++) recordCall(ALCHEMY_URL, "eth_call");
    __flushRpcMetricsForTests();
    for (let i = 0; i < 2; i++) recordCall(ALCHEMY_URL, "eth_call");
    __flushRpcMetricsForTests();
    const lines = readLines(file);
    expect(lines.map((l) => l.calls)).toEqual([{ alchemy: { eth_call: 3 } }, { alchemy: { eth_call: 2 } }]);
    // eth_call costs 26 CU on the Alchemy rate card, so five calls are 130 CU in total.
    expect(lines.reduce((sum, l) => sum + l.alchemyCalls, 0)).toBe(5);
    expect(lines.reduce((sum, l) => sum + l.alchemyCu, 0)).toBe(130);
  });

  it("writes nothing on a flush with no new calls", () => {
    const file = path.join(dir, "metrics.ndjson");
    process.env.HD_METRICS_FILE = file;
    recordCall(ALCHEMY_URL, "eth_call");
    __flushRpcMetricsForTests();
    const before = fs.readFileSync(file, "utf8");
    __flushRpcMetricsForTests();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("stamps every line with the process pid", () => {
    const file = path.join(dir, "metrics.ndjson");
    process.env.HD_METRICS_FILE = file;
    recordCall(ALCHEMY_URL, "eth_call");
    __flushRpcMetricsForTests();
    recordCall(ALCHEMY_URL, "eth_call");
    __flushRpcMetricsForTests();
    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.pid === process.pid)).toBe(true);
  });

  it("never writes the URL or key into the lines", () => {
    const file = path.join(dir, "metrics.ndjson");
    process.env.HD_METRICS_FILE = file;
    recordCall("https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123", "eth_getLogs");
    __flushRpcMetricsForTests();
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("SECRETKEY123");
    expect(raw).not.toContain("alchemy.com");
  });

  it("runs an unref'd periodic flush that the reset hook clears", () => {
    process.env.HD_METRICS_FILE = path.join(dir, "metrics.ndjson");
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    recordCall(ALCHEMY_URL, "eth_call");
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 60000);
    const timer = setSpy.mock.results[0].value;
    expect(timer.hasRef()).toBe(false);
    __resetRpcMetricsForTests();
    expect(clearSpy).toHaveBeenCalledWith(timer);
  });
});
