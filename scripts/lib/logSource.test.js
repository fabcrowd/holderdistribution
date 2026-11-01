import { describe, expect, it, vi } from "vitest";
import { PortalError } from "./portalLogs.js";
import {
  DEFAULT_CONFIRMATIONS,
  createLogScanner,
  parseSource,
  portalMaxRequests,
} from "./logSource.js";

const TOKEN = "0x" + "ab".repeat(20);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SENDER_TOPIC = "0x" + "00".repeat(12) + "cd".repeat(20);
const URLS = ["https://rpc-a.test", "https://rpc-b.test"];

const sequentialPool = async (items, _limit, fn) => Promise.all(items.map((item, i) => fn(item, i)));

function rpcFailover() {
  return vi.fn(async (_urls, _idx, filter) => [{ fromBlock: filter.fromBlock, toBlock: filter.toBlock }]);
}

function portalStream(logs = [{ transactionHash: "0x1", blockNumber: "0x64" }]) {
  return vi.fn(async (opts) => {
    opts.onRequest?.();
    return logs;
  });
}

function scannerFor(overrides = {}) {
  return createLogScanner({
    source: "portal",
    chain: "ethereum",
    head: 1000,
    urls: URLS,
    failover: rpcFailover(),
    span: 10,
    pool: sequentialPool,
    env: {},
    streamLogsImpl: portalStream(),
    ...overrides,
  });
}

describe("parseSource", () => {
  it("defaults to rpc when neither flag nor env is set", () => {
    expect(parseSource({ argv: [], env: {} })).toBe("rpc");
  });

  it("flag beats env, env beats default", () => {
    expect(parseSource({ argv: ["--source", "portal"], env: { HD_BACKFILL_SOURCE: "rpc" } })).toBe("portal");
    expect(parseSource({ argv: [], env: { HD_BACKFILL_SOURCE: "portal" } })).toBe("portal");
  });

  it("accepts the --source=value form", () => {
    expect(parseSource({ argv: ["--source=portal"], env: {} })).toBe("portal");
  });

  it("throws on an unknown source from the flag or the env", () => {
    expect(() => parseSource({ argv: ["--source", "ftp"], env: {} })).toThrow(/rpc.*portal/);
    expect(() => parseSource({ argv: [], env: { HD_BACKFILL_SOURCE: "ftp" } })).toThrow(/rpc.*portal/);
  });

  it("throws when --source has no value", () => {
    expect(() => parseSource({ argv: ["--source"], env: {} })).toThrow(/--source/);
  });
});

describe("createLogScanner rpc source", () => {
  it("treats undefined source as rpc", () => {
    const streamLogsImpl = portalStream();
    const scanner = createLogScanner({ chain: "ethereum", urls: URLS, failover: rpcFailover(), span: 10, pool: sequentialPool, streamLogsImpl });
    expect(scanner.source).toBe("rpc");
  });

  it("splits by span and calls failover per range, flattening the results", async () => {
    const failover = rpcFailover();
    const scanner = createLogScanner({ source: "rpc", chain: "ethereum", urls: URLS, failover, span: 10, pool: sequentialPool, streamLogsImpl: portalStream() });
    const filter = { address: [TOKEN], topics: [TRANSFER] };
    const out = await scanner.scan(filter, 0, 24);

    expect(failover).toHaveBeenCalledTimes(3);
    expect(failover.mock.calls.map(([, , f]) => [f.fromBlock, f.toBlock])).toEqual([
      ["0x0", "0x9"],
      ["0xa", "0x13"],
      ["0x14", "0x18"],
    ]);
    expect(failover.mock.calls[1][0]).toBe(URLS);
    expect(failover.mock.calls[1][1]).toBe(1);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ fromBlock: "0x14", toBlock: "0x18" });
  });

  it("never calls Portal, even when allowPortal is set", async () => {
    const streamLogsImpl = portalStream();
    const failover = rpcFailover();
    const scanner = createLogScanner({ source: "rpc", chain: "ethereum", urls: URLS, failover, span: 100, pool: sequentialPool, streamLogsImpl });
    await scanner.scan({ address: [TOKEN], topics: [TRANSFER] }, 0, 5, { allowPortal: true });
    expect(streamLogsImpl).not.toHaveBeenCalled();
    expect(failover).toHaveBeenCalledTimes(1);
  });
});

describe("createLogScanner portal source", () => {
  it("calls streamLogs once for the range and returns its logs", async () => {
    const streamLogsImpl = portalStream([{ transactionHash: "0xabc" }]);
    const failover = rpcFailover();
    const scanner = scannerFor({ streamLogsImpl, failover });
    const out = await scanner.scan({ address: [TOKEN], topics: [TRANSFER] }, 100, 500, { allowPortal: true });

    expect(streamLogsImpl).toHaveBeenCalledTimes(1);
    expect(failover).not.toHaveBeenCalled();
    expect(out).toEqual([{ transactionHash: "0xabc" }]);
    const opts = streamLogsImpl.mock.calls[0][0];
    expect(opts).toMatchObject({ dataset: "ethereum-mainnet", fromBlock: 100, toBlock: 500, address: [TOKEN], topics: [TRANSFER] });
  });

  it("ends at head minus confirmations (Ethereum 64, Polygon 128, Base 64)", async () => {
    expect(DEFAULT_CONFIRMATIONS).toEqual({ ethereum: 64, polygon: 128, base: 64 });
    const eth = portalStream();
    await scannerFor({ streamLogsImpl: eth, chain: "ethereum", head: 1000 }).scan({ address: [TOKEN], topics: [TRANSFER] }, 100, 2000, { allowPortal: true });
    expect(eth.mock.calls[0][0]).toMatchObject({ dataset: "ethereum-mainnet", toBlock: 936 });

    const poly = portalStream();
    await scannerFor({ streamLogsImpl: poly, chain: "polygon", head: 1000 }).scan({ address: [TOKEN], topics: [TRANSFER] }, 100, 2000, { allowPortal: true });
    expect(poly.mock.calls[0][0]).toMatchObject({ dataset: "polygon-mainnet", toBlock: 872 });
  });

  it("returns empty without calling Portal when the range is entirely inside the confirmation window", async () => {
    const streamLogsImpl = portalStream();
    const out = await scannerFor({ streamLogsImpl, head: 1000 }).scan({ address: [TOKEN], topics: [TRANSFER] }, 990, 1000, { allowPortal: true });
    expect(out).toEqual([]);
    expect(streamLogsImpl).not.toHaveBeenCalled();
  });

  it("uses RPC for scans not marked allowPortal (outflows with sender topics)", async () => {
    const streamLogsImpl = portalStream();
    const failover = rpcFailover();
    const scanner = scannerFor({ streamLogsImpl, failover, span: 1000 });
    await scanner.scan({ address: [TOKEN], topics: [TRANSFER, SENDER_TOPIC] }, 0, 5);
    expect(streamLogsImpl).not.toHaveBeenCalled();
    expect(failover).toHaveBeenCalledTimes(1);
  });

  it("refuses Portal for any filter with a topic beyond topic0, so sender lists never leave RPC", async () => {
    const streamLogsImpl = portalStream();
    const scanner = scannerFor({ streamLogsImpl });
    await expect(
      scanner.scan({ address: [TOKEN], topics: [TRANSFER, SENDER_TOPIC] }, 100, 500, { allowPortal: true }),
    ).rejects.toThrow(/topic0/);
    expect(streamLogsImpl).not.toHaveBeenCalled();
  });

  it("caps requests per scanner with PORTAL_MAX_REQUESTS and fails loudly", async () => {
    const streamLogsImpl = vi.fn(async (opts) => {
      for (let i = 0; i < 3; i += 1) opts.onRequest();
      return [];
    });
    const scanner = scannerFor({ streamLogsImpl, env: { PORTAL_MAX_REQUESTS: "2" } });
    const err = await scanner.scan({ address: [TOKEN], topics: [TRANSFER] }, 100, 500, { allowPortal: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect(err.message).toContain("PORTAL_MAX_REQUESTS");
  });

  it("reads confirmations from env overrides", async () => {
    const streamLogsImpl = portalStream();
    const scanner = scannerFor({ streamLogsImpl, chain: "base", head: 1000, env: { PORTAL_CONFIRMATIONS_BASE: "10" } });
    await scanner.scan({ address: [TOKEN], topics: [TRANSFER] }, 100, 2000, { allowPortal: true });
    expect(streamLogsImpl.mock.calls[0][0].toBlock).toBe(990);
  });

  it("throws on an unknown source", () => {
    expect(() => createLogScanner({ source: "ftp", chain: "ethereum", urls: URLS, failover: rpcFailover(), span: 10, pool: sequentialPool })).toThrow(/rpc.*portal/);
  });
});

describe("portalMaxRequests", () => {
  it("defaults to 200 and rejects non-positive or non-integer values", () => {
    expect(portalMaxRequests({})).toBe(200);
    expect(portalMaxRequests({ PORTAL_MAX_REQUESTS: "50" })).toBe(50);
    expect(() => portalMaxRequests({ PORTAL_MAX_REQUESTS: "0" })).toThrow(/PORTAL_MAX_REQUESTS/);
    expect(() => portalMaxRequests({ PORTAL_MAX_REQUESTS: "abc" })).toThrow(/PORTAL_MAX_REQUESTS/);
  });
});
