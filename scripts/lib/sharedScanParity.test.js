import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWindow, transferWindowName, writeWindow } from "./transferWindow.js";
import { getTransferLogsCached } from "./sharedTransferLogs.js";

const CHAIN = "ethereum";
const TOKEN = "0x" + "ab".repeat(20);
const pad = (addr) => "0x" + "0".repeat(24) + addr.slice(2);
const A = "0x" + "11".repeat(20);
const B = "0x" + "22".repeat(20);
const hex = (n) => "0x" + n.toString(16);

const makeLog = (block, logIndex, value) => ({
  address: TOKEN,
  blockNumber: hex(block),
  logIndex: hex(logIndex),
  transactionHash: "0x" + block.toString(16).padStart(64, "0"),
  topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(A), pad(B)],
  data: hex(value),
});

// Synthetic chain: blocks 100..199, one or two transfers in most blocks.
const CHAIN_LOGS = [];
for (let b = 100; b <= 199; b++) {
  if (b % 7 === 0) continue;
  CHAIN_LOGS.push(makeLog(b, 0, b));
  if (b % 3 === 0) CHAIN_LOGS.push(makeLog(b, 1, b * 2));
}

const rpcFor = (from, to) =>
  CHAIN_LOGS.filter((l) => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to);

// Same shape as the scan loops: fixed-size chunks, results aggregated per chunk.
const scanChunks = async (window, from, end, chunk, rpc, env) => {
  const out = [];
  for (let s = from; s <= end; s += chunk) {
    const e = Math.min(s + chunk - 1, end);
    out.push(
      await getTransferLogsCached({
        window, chain: CHAIN, tokens: [TOKEN], fromBlock: s, toBlock: e, env,
        fetchFromRpc: async () => rpc(s, e),
      }),
    );
  }
  return out;
};

describe("shared scan parity", () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "parity-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const writeFull = async (fromBlock = 100, toBlock = 199, logs = rpcFor(fromBlock, toBlock)) => {
    const file = path.join(dir, transferWindowName(CHAIN));
    await writeWindow(file, { chain: CHAIN, tokens: [TOKEN], fromBlock, toBlock, logs });
    return readWindow(file);
  };

  it("window results equal direct RPC results chunk for chunk, with no RPC calls", async () => {
    const window = await writeFull();
    const rpc = vi.fn(async (s, e) => rpcFor(s, e));
    const viaWindow = await scanChunks(window, 100, 199, 13, rpc);
    const direct = await scanChunks(null, 100, 199, 13, async (s, e) => rpcFor(s, e));
    expect(viaWindow).toEqual(direct);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("window chunks sized differently from the writer's still match direct fetch", async () => {
    const window = await writeFull();
    const viaWindow = (await scanChunks(window, 120, 180, 25, vi.fn())).flat();
    expect(viaWindow).toEqual(rpcFor(120, 180));
  });

  it("falls back to RPC for chunks beyond the window and serves the covered ones", async () => {
    const window = await writeFull(100, 149, rpcFor(100, 149));
    const rpc = vi.fn(async (s, e) => rpcFor(s, e));
    const viaMixed = (await scanChunks(window, 100, 199, 25, rpc)).flat();
    expect(viaMixed).toEqual(rpcFor(100, 199));
    expect(rpc).toHaveBeenCalledTimes(2); // 125-149 is covered; 150-174 and 175-199 are not
  });

  it("uses RPC when the window is missing", async () => {
    const rpc = vi.fn(async (s, e) => rpcFor(s, e));
    expect(await readWindow(path.join(dir, "nope.ndjson"))).toBeNull();
    const out = (await scanChunks(await readWindow(path.join(dir, "nope.ndjson")), 100, 199, 50, rpc)).flat();
    expect(out).toEqual(rpcFor(100, 199));
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("uses RPC when the window was built for a different token (stale config)", async () => {
    const file = path.join(dir, transferWindowName(CHAIN));
    await writeWindow(file, { chain: CHAIN, tokens: ["0x" + "cd".repeat(20)], fromBlock: 100, toBlock: 199, logs: [] });
    const window = await readWindow(file);
    const rpc = vi.fn(async (s, e) => rpcFor(s, e));
    const out = (await scanChunks(window, 100, 199, 100, rpc)).flat();
    expect(out).toEqual(rpcFor(100, 199));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("HD_SHARED_SCAN=off restores the direct RPC path even with a covering window", async () => {
    const window = await writeFull();
    const rpc = vi.fn(async (s, e) => rpcFor(s, e));
    const out = (await scanChunks(window, 100, 199, 50, rpc, { HD_SHARED_SCAN: "off" })).flat();
    expect(out).toEqual(rpcFor(100, 199));
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
