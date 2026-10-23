import { describe, it, expect } from "vitest";
import { scanStakeChangedCandidates, STAKING_DEPLOY_BLOCK } from "./stakingDiscovery.js";
import { STAKE_CHANGED_TOPIC0 } from "./staking.js";

const normalize = (v) => (typeof v === "string" && /^0x[a-f0-9]{40}$/i.test(v) ? v.toLowerCase() : null);
const topicFor = (addr) => "0x" + addr.slice(2).padStart(64, "0");
const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);

describe("scanStakeChangedCandidates", () => {
  it("covers [from, to] in contiguous chunks with no gap or overlap and dedupes accounts", async () => {
    const ranges = [];
    const getLogsWithFailover = async (urls, idx, filter) => {
      expect(filter.topics).toEqual([STAKE_CHANGED_TOPIC0]);
      const from = parseInt(filter.fromBlock, 16);
      const to = parseInt(filter.toBlock, 16);
      ranges.push([from, to, idx]);
      return from === 100 ? [{ topics: [STAKE_CHANGED_TOPIC0, topicFor(A)] }, { topics: [STAKE_CHANGED_TOPIC0, topicFor(B)] }]
        : [{ topics: [STAKE_CHANGED_TOPIC0, topicFor(A.toUpperCase().replace("0X", "0x"))] }, { topics: [] }];
    };
    const { candidates, logCount } = await scanStakeChangedCandidates({
      getLogsWithFailover, urls: ["u1", "u2"], contract: "0xc", fromBlock: 100, toBlock: 349, span: 100, normalize,
    });
    expect(ranges).toEqual([[100, 199, 0], [200, 299, 1], [300, 349, 0]]);
    expect([...candidates].sort()).toEqual([A, B]);
    expect(logCount).toBe(6);
  });

  it("propagates a chunk failure instead of returning a partial candidate set", async () => {
    const getLogsWithFailover = async () => { throw new Error("all urls down"); };
    await expect(scanStakeChangedCandidates({
      getLogsWithFailover, urls: ["u"], contract: "0xc", fromBlock: 0, toBlock: 10, normalize,
    })).rejects.toThrow("all urls down");
  });

  it("refuses an empty URL pool", async () => {
    await expect(scanStakeChangedCandidates({ getLogsWithFailover: async () => [], urls: [], contract: "0xc", fromBlock: 0, toBlock: 1, normalize }))
      .rejects.toThrow(/no RPC URLs/);
  });

  it("starts no earlier than the staking proxy deployment", () => {
    expect(STAKING_DEPLOY_BLOCK).toBe(36751757);
  });
});
