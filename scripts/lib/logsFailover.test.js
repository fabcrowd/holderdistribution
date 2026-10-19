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
