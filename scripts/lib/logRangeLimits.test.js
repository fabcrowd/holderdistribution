/**
 * eth_getLogs range limits MEASURED with scripts/probe-log-ranges.js on
 * 2026-11-04 (ONDO on ethereum, TEL v3 on polygon/base, 0 Alchemy CU), replayed
 * against a mocked fetch. Each provider's real rejection text must make getLogs
 * shrink the range (never fail the scan), return every log exactly once, and
 * never send a range wider than the provider accepts after the first rejection.
 * Re-measure with `node scripts/probe-log-ranges.js` and update MEASURED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogs, __resetRpcCachesForTests } from "./rpc.js";

const hex = (n) => "0x" + n.toString(16);
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// One log per block in the mock, so a result cap of N logs == N blocks.
export const MEASURED = [
  {
    name: "Tenderly ethereum/polygon (20,000-result cap; 20k ONDO blocks with 14,099 logs accepted)",
    url: "https://gateway.tenderly.co/public/mainnet",
    reject: (span) => span > 20000 && { code: -32602, message: "invalid params", data: "Query returned more than 20000 results. Try with this block range [0x1913882, 0x19199e1]." },
  },
  {
    name: "Tenderly base without an access key (1,000 blocks)",
    url: "https://base.gateway.tenderly.co",
    reject: (span) => span > 1000 && { code: -32602, message: "invalid params", data: "Block range too large: maximum 1000 blocks without an access key" },
  },
  {
    name: "MEV Blocker (10,000-block range or 10k-log response cap)",
    url: "https://rpc.mevblocker.io",
    reject: (span) => span > 10000 && { code: -32602, message: "Log response size exceeded. You can make eth_getLogs requests with up to a 10,000 block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response." },
  },
  {
    name: "publicnode polygon (10,000 blocks)",
    url: "https://polygon-bor-rpc.publicnode.com",
    reject: (span) => span > 10000 && { code: -32000, message: "exceed maximum block range: 10000" },
  },
  {
    name: "Pocket polygon (10,001 blocks)",
    url: "https://poly.api.pocket.network",
    reject: (span) => span > 10001 && { code: -32000, message: "eth_getLogs block range too large (max 10001 blocks)" },
  },
  {
    name: "Alchemy Free plan key (10 blocks on every chain; Alchemy eth_getLogs docs)",
    url: "https://eth-mainnet.g.alchemy.com/v2/freekey",
    reject: (span) => span > 10 && { code: -32600, message: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x1, 0xa]. Upgrade to PAYG for expanded block range." },
    limit: 10,
  },
];

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  __resetRpcCachesForTests();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockProvider(p) {
  const spans = [];
  globalThis.fetch = vi.fn(async (_u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method !== "eth_getLogs") return json({ jsonrpc: "2.0", id: 1, result: "0x0" });
    const from = parseInt(params[0].fromBlock, 16);
    const to = parseInt(params[0].toBlock, 16);
    spans.push(to - from + 1);
    const err = p.reject(to - from + 1);
    if (err) return json({ jsonrpc: "2.0", id: 1, error: err });
    return json({ jsonrpc: "2.0", id: 1, result: Array.from({ length: to - from + 1 }, (_, i) => ({ blockNumber: hex(from + i), logIndex: "0x0", topics: [], data: "0x" })) });
  });
  return spans;
}

describe("getLogs adapts to every measured provider limit", () => {
  for (const p of MEASURED) {
    it(p.name, async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const spans = mockProvider(p);
      const width = p.limit === 10 ? 200 : 50000; // pull-holders-rpc asks 10,000 on ethereum/base; wide asks exercise bisection
      const logs = await getLogs(p.url, { fromBlock: hex(1_000_000), toBlock: hex(1_000_000 + width - 1), address: "0x" + "ab".repeat(20), topics: [] });
      const blocks = logs.map((l) => parseInt(l.blockNumber, 16));
      expect(blocks.length).toBe(width);
      expect(new Set(blocks).size).toBe(width);
      const rejected = spans.filter((s) => p.reject(s));
      const accepted = spans.filter((s) => !p.reject(s));
      expect(accepted.reduce((a, s) => a + s, 0)).toBe(width);
      // A handful of rejections while bisecting, never a flood.
      expect(rejected.length).toBeLessThanOrEqual(p.limit === 10 ? 1 : 6);
      // Second call on the same URL reuses the learned span: no new rejections.
      const before = spans.length;
      await getLogs(p.url, { fromBlock: hex(2_000_000), toBlock: hex(2_000_000 + width - 1), address: "0x" + "ab".repeat(20), topics: [] });
      expect(spans.slice(before).filter((s) => p.reject(s)).length).toBe(0); // incl. Alchemy free tier: the 10-block limit is remembered per key
    }, 30_000); // real per-host token buckets: Tenderly base at 1,000 blocks is ~100 paced calls
  }
});
