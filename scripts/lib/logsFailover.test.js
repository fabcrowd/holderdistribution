import { describe, expect, it, vi } from "vitest";
import { createLogsFailover } from "./logsFailover.js";

const hex = (n) => "0x" + n.toString(16);
const filter = (from, to = from + 9) => ({ fromBlock: hex(from), toBlock: hex(to), address: "0xabc", topics: [] });
const quiet = { warn: vi.fn() };

describe("createLogsFailover", () => {
  it("falls over to the next URL and returns its logs", async () => {
    const impl = vi.fn(async (url) => {
      if (url === "a") throw new Error("boom");
      return [{ ok: url }];
    });
    const f = createLogsFailover(impl, quiet);
    await expect(f(["a", "b"], 0, filter(1))).resolves.toEqual([{ ok: "b" }]);
  });

  it("rethrows the last error when every URL fails", async () => {
    const f = createLogsFailover(async (url) => { throw new Error(`down ${url}`); }, quiet);
    await expect(f(["a", "b"], 0, filter(1))).rejects.toThrow("down b");
  });

  it("stops asking a pruned node for ranges below its stated earliest block", async () => {
    const calls = [];
    const impl = async (url, fl) => {
      calls.push([url, Number.parseInt(fl.fromBlock, 16)]);
      if (url === "pruned" && Number.parseInt(fl.fromBlock, 16) < 1000) {
        throw new Error("pruned history unavailable: requested 5, earliest available 1000");
      }
      return [{ ok: url }];
    };
    const f = createLogsFailover(impl, quiet);
    await f(["pruned", "full"], 0, filter(5)); // pruned asked once, refuses, full serves
    calls.length = 0;
    await f(["pruned", "full"], 0, filter(100));
    await f(["pruned", "full"], 0, filter(500));
    expect(calls.every(([u]) => u === "full")).toBe(true);
    // From its boundary on, the pruned node is eligible again and is preferred (assigned first).
    calls.length = 0;
    await f(["pruned", "full"], 0, filter(1000));
    expect(calls[0][0]).toBe("pruned");
  });

  it("demotes an archive-less node (no stated boundary) to last resort", async () => {
    const calls = [];
    const impl = async (url) => {
      calls.push(url);
      if (url === "recent-only") throw new Error("RPC HTTP 403: Archive requests require a personal token");
      return [];
    };
    const f = createLogsFailover(impl, quiet);
    await f(["recent-only", "full"], 0, filter(10)); // refused once, then full
    calls.length = 0;
    await f(["recent-only", "full"], 0, filter(20));
    await f(["recent-only", "full"], 0, filter(30));
    expect(calls).toEqual(["full", "full"]);
  });

  it("still tries demoted nodes when every other URL fails", async () => {
    let allowRecent = false;
    const impl = async (url) => {
      if (url === "recent-only") {
        if (!allowRecent) throw new Error("Archive requests require a personal token");
        return [{ ok: "recent-only" }];
      }
      throw new Error("full is down");
    };
    const f = createLogsFailover(impl, quiet);
    await expect(f(["recent-only", "full"], 0, filter(1))).rejects.toThrow();
    allowRecent = true;
    await expect(f(["recent-only", "full"], 0, filter(2))).resolves.toEqual([{ ok: "recent-only" }]);
  });
});

describe("createLogsFailover: Alchemy budget and the reserve (run 45975348118, 2026-11-27)", () => {
  const budgetError = () => Object.assign(new Error("[budget] job staker-balances Alchemy budget 1000 CU/run reached (985 spent) — refusing eth_getLogs"), { code: "ALCHEMY_BUDGET" });
  const keys = Array.from({ length: 15 }, (_, i) => `https://polygon-mainnet.g.alchemy.com/v2/key${i}`);
  const PUBLIC = ["https://gateway.tenderly.co/public/polygon", "https://poly.api.pocket.network"];

  it("a refused Alchemy key ends every Alchemy attempt, and the scan moves on to the public reserve", async () => {
    const calls = [];
    const impl = async (url) => {
      calls.push(url);
      if (url.includes("alchemy")) throw budgetError();
      return [{ from: url }];
    };
    const reserve = vi.fn(async () => PUBLIC);
    const f = createLogsFailover(impl, { warn: vi.fn() }, { reserve, sleep: async () => {} });
    await expect(f(keys, 0, filter(1))).resolves.toEqual([{ from: PUBLIC[0] }]);
    // One refused key, not fifteen; then the reserve.
    expect(calls).toEqual([keys[0], PUBLIC[0]]);
    expect(reserve).toHaveBeenCalledTimes(1);
    // Later chunks: no Alchemy key is asked again, the reserve is not re-resolved.
    calls.length = 0;
    await f(keys, 3, filter(100));
    expect(calls).toEqual([PUBLIC[0]]);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(f.lastServedUrl).toBe(PUBLIC[0]);
  });

  it("does not resolve the reserve while the pool serves", async () => {
    const reserve = vi.fn(async () => PUBLIC);
    const f = createLogsFailover(async () => [], quiet, { reserve });
    await f(["a", "b"], 0, filter(1));
    expect(reserve).not.toHaveBeenCalled();
    expect(f.lastServedUrl).toBe("a");
  });

  it("uses the reserve when every pool URL fails for another reason, and fails only when the reserve does too", async () => {
    const f = createLogsFailover(async (url) => { if (url !== "r2") throw new Error(`down ${url}`); return [url]; }, quiet, { reserve: ["r1", "r2"] });
    await expect(f(["a", "b"], 0, filter(1))).resolves.toEqual(["r2"]);
    const g = createLogsFailover(async (url) => { throw new Error(`down ${url}`); }, quiet, { reserve: ["r1"] });
    await expect(g(["a"], 0, filter(1))).rejects.toThrow("down r1");
  });

  it("without a reserve, a pool of spent Alchemy keys still fails with the budget error (no silent success)", async () => {
    const f = createLogsFailover(async () => { throw budgetError(); }, quiet);
    await expect(f(keys, 0, filter(1))).rejects.toThrow(/Alchemy budget/);
  });
});
