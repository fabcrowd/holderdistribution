import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildChainStatus } from "./chainStatus.js";
import { writeChainStatus } from "../write-chain-status.js";

describe("chain-status.json", () => {
  it("keeps only generatedAt and each chain's lastBlock", () => {
    const cp = {
      schemaVersion: 1,
      generatedAt: "2026-10-23T15:24:59Z",
      chains: {
        ethereum: { lastBlock: 26256205, fromBlock: 1, rawBalances: { "0xa": "1" }, v3: { rawBalances: { "0xb": "2" } } },
        polygon: { lastBlock: 96042482, v3Staking: { "0x57": { rawBalances: { "0xc": "3" } } } },
        base: { lastBlock: 52989873 },
        bogus: { lastBlock: 5 },
      },
    };
    const out = buildChainStatus(cp);
    expect(out).toEqual({
      generatedAt: "2026-10-23T15:24:59Z",
      chains: { ethereum: { lastBlock: 26256205 }, polygon: { lastBlock: 96042482 }, base: { lastBlock: 52989873 } },
    });
    expect(JSON.stringify(out)).not.toMatch(/rawBalances|0xa/);
  });

  it("uses the project's chain keys when given (e.g. a fourth chain)", () => {
    const cp = { generatedAt: "g", chains: { ethereum: { lastBlock: 1 }, arbitrum: { lastBlock: 2 }, base: { lastBlock: 3 } } };
    expect(buildChainStatus(cp, ["ethereum", "arbitrum"]).chains).toEqual({ ethereum: { lastBlock: 1 }, arbitrum: { lastBlock: 2 } });
    expect(buildChainStatus(cp, []).chains).toEqual({ ethereum: { lastBlock: 1 }, base: { lastBlock: 3 } });
  });

  it("drops chains without a valid block", () => {
    expect(buildChainStatus({ chains: { ethereum: { lastBlock: "x" } } })).toEqual({ generatedAt: null, chains: {} });
  });

  it("writes the file from the checkpoint, and leaves it alone when there is no checkpoint", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-"));
    expect(await writeChainStatus(dir)).toBeNull();
    await fs.writeFile(path.join(dir, "holders-checkpoint.json"), JSON.stringify({ generatedAt: "g", chains: { base: { lastBlock: 9, rawBalances: {} } } }));
    await writeChainStatus(dir);
    expect(JSON.parse(await fs.readFile(path.join(dir, "chain-status.json"), "utf8"))).toEqual({ generatedAt: "g", chains: { base: { lastBlock: 9 } } });
  });
});
