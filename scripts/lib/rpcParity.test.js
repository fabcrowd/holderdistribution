/**
 * Every project gets the same public-RPC limiter and the same mid-scan
 * (partial) checkpoint, through shared code only: limits are keyed by
 * chain host (config/public-rpc-limits.json), the checkpoint path comes from
 * projects.js (projectWork), and none of the shared modules name a project.
 * tel, zebec-network and ondo are the registered projects; "synthx" is a
 * made-up one that exists nowhere in the repo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogs, statedBlockCap, __resetRpcCachesForTests } from "./rpc.js";
import { limitsFor, hostMaxBlockRange, backoffMs, parseRetryAfter } from "./rpcLimiter.js";
import { partialName, serializePartial, writePartial, readPartial, partialUsable, partialRaw, buildChunks, streamChunks } from "./partialCheckpoint.js";
import { resolveProject, projectWork, projectWorkDir, loadRegistry } from "./projects.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const hex = (n) => "0x" + n.toString(16);
const SHARED = ["scripts/lib/rpc.js", "scripts/lib/rpcLimiter.js", "scripts/lib/partialCheckpoint.js", "scripts/lib/logsFailover.js", "config/public-rpc-limits.json"];
const PROJECTS = [...loadRegistry(ROOT).map((p) => resolveProject(p.slug, ROOT)), { slug: "synthx", config: { slug: "synthx" } }];

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; __resetRpcCachesForTests(); });
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("covers the registered projects plus a synthetic one", () => {
  expect(PROJECTS.map((p) => p.slug)).toEqual(expect.arrayContaining(["tel", "zebec-network", "ondo", "synthx"]));
});

it("no shared limiter/checkpoint module hardcodes a project id (comments excluded)", () => {
  const slugs = [...loadRegistry(ROOT).map((p) => p.slug), "zbcn"];
  for (const rel of SHARED) {
    let src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    src = rel.endsWith(".json") ? JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(src)).filter(([k]) => !k.startsWith("_") && !k.startsWith("$"))), (k, v) => (k.startsWith("_") ? undefined : v))
      : src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const slug of slugs) expect(new RegExp(`["'\`/.-]${slug}["'\`/.-]|\\b${slug}\\b`, "i").test(src), `${rel} mentions ${slug}`).toBe(false);
  }
});

describe("limits are per host, identical for every project", () => {
  for (const p of PROJECTS) {
    it(p.slug, () => {
      vi.stubEnv("HD_PROJECT", p.slug);
      expect(limitsFor("https://base.gateway.tenderly.co")).toMatchObject({ maxBlockRange: 1000, maxGetLogsResults: 20000 });
      expect(limitsFor("https://gateway.tenderly.co/public/mainnet")).toMatchObject({ maxGetLogsResults: 20000 });
      expect(hostMaxBlockRange("https://gateway.tenderly.co/public/polygon")).toBeNull();
      expect(hostMaxBlockRange("https://polygon-bor-rpc.publicnode.com")).toBe(10000);
      expect(limitsFor("https://eth-mainnet.g.alchemy.com/v2/k")).toBeNull(); // keyed: never throttled here
    });
  }
});

describe("measured-issue fixes", () => {
  it("reads stated block caps instead of halving", () => {
    expect(statedBlockCap("invalid params - Block range too large: maximum 1000 blocks without an access key")).toBe(1000);
    expect(statedBlockCap("exceed maximum block range: 10000")).toBe(10000);
    expect(statedBlockCap("eth_getLogs block range too large (max 10001 blocks)")).toBe(10001);
    expect(statedBlockCap("query returned more than 20000 results")).toBeNull();
  });
  it("Retry-After 0 or missing is a minimum backoff, never an instant retry", () => {
    expect(parseRetryAfter("0")).toBe(0);
    for (const ra of [parseRetryAfter("0"), parseRetryAfter(null)]) expect(backoffMs(0, { retryAfterMs: ra, random: () => 0 })).toBeGreaterThanOrEqual(500);
  });
  it("an Alchemy free-tier key's 10-block limit is remembered per key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = { a: [], b: [] };
    globalThis.fetch = vi.fn(async (u, init) => {
      const f = JSON.parse(init.body).params[0];
      const span = parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16) + 1;
      const free = u.endsWith("/free");
      (free ? calls.a : calls.b).push(span);
      const body = free && span > 10
        ? { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range." } }
        : { jsonrpc: "2.0", id: 1, result: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const free = "https://eth-mainnet.g.alchemy.com/v2/free";
    const paid = "https://eth-mainnet.g.alchemy.com/v2/paid";
    await getLogs(free, { fromBlock: hex(100), toBlock: hex(199) });
    await getLogs(free, { fromBlock: hex(200), toBlock: hex(299) });
    await getLogs(paid, { fromBlock: hex(100), toBlock: hex(199) });
    expect(calls.a.filter((s) => s > 10)).toEqual([100]); // one rejection, then the key's limit is reused
    expect(calls.b).toEqual([100]); // another key is not penalised
  });
});

describe("partial checkpoint resume is identical for every project", () => {
  const TOKEN = "0x" + "cd".repeat(20);
  const pad = (a) => "0x" + a.slice(2).padStart(64, "0");
  const addr = (i) => "0x" + (i + 1).toString(16).padStart(40, "0");
  // One Transfer per block: mint to addr(block % 7).
  const logsFor = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({
    blockNumber: hex(from + i), logIndex: "0x0", address: TOKEN,
    topics: ["0xddf2", pad("0x0"), pad(addr((from + i) % 7))], data: hex(from + i),
  }));
  const apply = (raw) => (logs) => { for (const l of logs) { const to = "0x" + l.topics[2].slice(26); raw.set(to, (raw.get(to) ?? 0n) + BigInt(l.data)); } };

  for (const p of PROJECTS) {
    it(p.slug, async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `parity-${p.slug}-`));
      const file = projectWork(p, root)(partialName("base"));
      expect(path.relative(root, file)).toBe(path.join(projectWorkDir(p), "holders-partial-base.json"));
      expect(file.includes(`${path.sep}public${path.sep}`)).toBe(false);

      // Real shared getLogs on a limited public host (1,000-block cap), mocked network.
      globalThis.fetch = vi.fn(async (_u, init) => {
        const f = JSON.parse(init.body).params[0];
        const a = parseInt(f.fromBlock, 16), b = parseInt(f.toBlock, 16);
        if (b - a + 1 > 1000) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params", data: "Block range too large: maximum 1000 blocks without an access key" } }));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: logsFor(a, b) }));
      });
      const url = "https://base.gateway.tenderly.co";
      const fetchChunk = (c) => getLogs(url, { fromBlock: hex(c.from), toBlock: hex(c.to), address: TOKEN, topics: [] });
      const base = { chainKey: "base", token: TOKEN, genesisBlock: 1, baseLastBlock: null };
      const chunks = buildChunks(1, 6000, 2000);

      // Uninterrupted reference.
      const ref = new Map();
      await streamChunks({ chunks, concurrency: 1, fetchChunk, onLogs: apply(ref) });

      // Interrupted after 2 slices, partial written to the project's work dir.
      const raw = new Map();
      let n = 0;
      await expect(streamChunks({ chunks, concurrency: 1, fetchChunk: (c) => (n++ === 2 ? Promise.reject(new Error("killed")) : fetchChunk(c)), onLogs: apply(raw),
        onProgress: (last) => writePartial(file, serializePartial({ ...base, lastBlock: last, raw })) })).rejects.toThrow("killed");
      const saved = await readPartial(file);
      expect(saved.lastBlock).toBe(4000);
      expect(partialUsable(saved, base)).toBe(true);

      // Resume from lastBlock + 1.
      const resumed = partialRaw(saved);
      await streamChunks({ chunks: buildChunks(saved.lastBlock + 1, 6000, 2000), concurrency: 1, fetchChunk, onLogs: apply(resumed) });
      expect(Object.fromEntries(resumed)).toEqual(Object.fromEntries(ref));
      fs.rmSync(root, { recursive: true, force: true });
    }, 30_000);
  }
});
