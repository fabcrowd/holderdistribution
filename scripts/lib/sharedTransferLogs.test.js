import { describe, expect, it, vi } from "vitest";
import { getTransferLogsCached, sharedScanEnabled } from "./sharedTransferLogs.js";
import { TRANSFER_TOPIC0, windowConfigHash } from "./transferWindow.js";

const TOKEN_A = "0x00000000000000000000000000000000000000aa";
const TOKEN_B = "0x00000000000000000000000000000000000000bb";
const CHAIN = 1;

const logAt = (block) => ({
  blockNumber: `0x${block.toString(16)}`,
  logIndex: "0x0",
  transactionHash: `0x${block.toString(16)}`,
  address: TOKEN_A,
  topics: [TRANSFER_TOPIC0],
  data: "0x0",
});

const makeWindow = (tokens = [TOKEN_A], { fromBlock = 100, toBlock = 200 } = {}) => ({
  meta: { fromBlock, toBlock, configHash: windowConfigHash(CHAIN, tokens) },
  logs: [logAt(100), logAt(150), logAt(200)],
});

const RPC_LOGS = [logAt(999)];

describe("sharedTransferLogs", () => {
  it("serves a covered range from the window without calling RPC", async () => {
    const fetchFromRpc = vi.fn().mockResolvedValue(RPC_LOGS);
    const out = await getTransferLogsCached({
      window: makeWindow(),
      chain: CHAIN,
      tokens: [TOKEN_A],
      fromBlock: 120,
      toBlock: 200,
      fetchFromRpc,
      env: {},
    });
    expect(out.map((l) => parseInt(l.blockNumber, 16))).toEqual([150, 200]);
    expect(fetchFromRpc).not.toHaveBeenCalled();
  });

  it("falls back to RPC when there is no window", async () => {
    const fetchFromRpc = vi.fn().mockResolvedValue(RPC_LOGS);
    const out = await getTransferLogsCached({
      window: null,
      chain: CHAIN,
      tokens: [TOKEN_A],
      fromBlock: 120,
      toBlock: 180,
      fetchFromRpc,
      env: {},
    });
    expect(out).toBe(RPC_LOGS);
    expect(fetchFromRpc).toHaveBeenCalledTimes(1);
  });

  it("falls back to RPC when the range is only partially covered", async () => {
    const fetchFromRpc = vi.fn().mockResolvedValue(RPC_LOGS);
    const out = await getTransferLogsCached({
      window: makeWindow(),
      chain: CHAIN,
      tokens: [TOKEN_A],
      fromBlock: 150,
      toBlock: 250,
      fetchFromRpc,
      env: {},
    });
    expect(out).toBe(RPC_LOGS);
    expect(fetchFromRpc).toHaveBeenCalledTimes(1);
  });

  it("falls back to RPC when the window was built for different tokens", async () => {
    const fetchFromRpc = vi.fn().mockResolvedValue(RPC_LOGS);
    const out = await getTransferLogsCached({
      window: makeWindow([TOKEN_B]),
      chain: CHAIN,
      tokens: [TOKEN_A],
      fromBlock: 120,
      toBlock: 180,
      fetchFromRpc,
      env: {},
    });
    expect(out).toBe(RPC_LOGS);
    expect(fetchFromRpc).toHaveBeenCalledTimes(1);
  });

  it("bypasses the window when HD_SHARED_SCAN=off even if it covers the range", async () => {
    const fetchFromRpc = vi.fn().mockResolvedValue(RPC_LOGS);
    const out = await getTransferLogsCached({
      window: makeWindow(),
      chain: CHAIN,
      tokens: [TOKEN_A],
      fromBlock: 120,
      toBlock: 200,
      fetchFromRpc,
      env: { HD_SHARED_SCAN: "off" },
    });
    expect(out).toBe(RPC_LOGS);
    expect(fetchFromRpc).toHaveBeenCalledTimes(1);
  });

  it("enables the shared scan unless HD_SHARED_SCAN is off", () => {
    expect(sharedScanEnabled({})).toBe(true);
    expect(sharedScanEnabled({ HD_SHARED_SCAN: "on" })).toBe(true);
    expect(sharedScanEnabled({ HD_SHARED_SCAN: "off" })).toBe(false);
  });

  it("propagates an RPC fetch rejection", async () => {
    const fetchFromRpc = vi.fn().mockRejectedValue(new Error("rpc down"));
    await expect(
      getTransferLogsCached({
        window: null,
        chain: CHAIN,
        tokens: [TOKEN_A],
        fromBlock: 120,
        toBlock: 180,
        fetchFromRpc,
        env: {},
      }),
    ).rejects.toThrow("rpc down");
  });
});
