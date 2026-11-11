import { describe, expect, it } from "vitest";
import { chainEntry } from "../add-project.js";
import { vmUsesNativeAsset } from "./chainVms.js";
import { buildChainStatus } from "./chainStatus.js";
import { buildInventory, configChainTokens, validateInventory } from "./chainInventory.js";
import { createHederaClock } from "./hedera/clock.js";
import { deriveChainsFromProject, validateProjectConfig } from "./projects.js";

const hbar = (extra = {}) => ({
  key: "hedera",
  name: "Hedera",
  vm: "hedera",
  origin: true,
  asset: { kind: "native", decimals: 8 },
  mirrorUrl: "https://mirror.example/api/v1",
  rangeWidth: 100000,
  holderFloorTinybar: "100000000",
  contracts: { whbar: { address: "0.0.1456985", role: "dex" } },
  ...extra,
});
const config = (chain = hbar()) => ({ slug: "hbar", ticker: "HBAR", chains: [chain] });

describe("vm table", () => {
  it("only hedera uses a native asset", () => {
    expect(vmUsesNativeAsset("hedera")).toBe(true);
    expect(vmUsesNativeAsset("evm")).toBe(false);
    expect(vmUsesNativeAsset("solana")).toBe(false);
  });
});

describe("validateProjectConfig: vm hedera", () => {
  const errorsOf = (chain) => validateProjectConfig(config(chain)).errors;

  it("accepts a native asset with no tokens[]", () => expect(errorsOf(hbar())).toEqual([]));
  it("requires the native asset", () => expect(errorsOf(hbar({ asset: undefined })).join()).toMatch(/asset/));
  it("rejects tokens[] next to a native asset", () => expect(errorsOf(hbar({ tokens: [{ address: "0x" + "a".repeat(40), decimals: 8 }] })).join()).toMatch(/tokens/));
  it("rejects a non-native kind and bad decimals", () => {
    expect(errorsOf(hbar({ asset: { kind: "token", decimals: 8 } })).join()).toMatch(/native/);
    expect(errorsOf(hbar({ asset: { kind: "native", decimals: 99 } })).join()).toMatch(/decimals/);
  });
  it("rejects EVM-only fields", () => expect(errorsOf(hbar({ chainId: 295 })).join()).toMatch(/chainId/));
  it("checks mirrorUrl, rangeWidth and holderFloorTinybar", () => {
    expect(errorsOf(hbar({ mirrorUrl: "http://x" })).join()).toMatch(/mirrorUrl/);
    expect(errorsOf(hbar({ rangeWidth: 0 })).join()).toMatch(/rangeWidth/);
    expect(errorsOf(hbar({ holderFloorTinybar: "1.5" })).join()).toMatch(/holderFloorTinybar/);
  });
  it("checks contract addresses as 0.0.N", () => expect(errorsOf(hbar({ contracts: { x: { address: "0xabc" } } })).join()).toMatch(/contracts\.x/));
  it("does not let an asset or the hedera fields onto an EVM chain", () => {
    const evm = { key: "ethereum", vm: "evm", chainId: 1, asset: { kind: "native", decimals: 18 }, mirrorUrl: "https://x", tokens: [{ address: "0x" + "a".repeat(40), decimals: 18 }] };
    expect(errorsOf(evm).join()).toMatch(/asset/);
    expect(errorsOf(evm).join()).toMatch(/mirrorUrl/);
  });
});

describe("deriveChainsFromProject: vm hedera", () => {
  it("derives a native chain and keeps mirrorUrl, rangeWidth and holderFloorTinybar", () => {
    const chain = deriveChainsFromProject(config()).hedera;
    expect(chain).toMatchObject({
      key: "hedera",
      vm: "hedera",
      origin: true,
      asset: { kind: "native", decimals: 8 },
      decimals: 8,
      mirrorUrl: "https://mirror.example/api/v1",
      rangeWidth: 100000,
      holderFloorTinybar: "100000000",
    });
    expect(chain.contracts.whbar).toEqual({ address: "0.0.1456985", role: "dex" });
    expect(chain.tokenAddress).toBeUndefined();
    expect(chain.explorerTemplates.address).toBe("https://hashscan.io/mainnet/account/{address}");
  });
  it("omits fields the config does not set", () => {
    const chain = deriveChainsFromProject(config({ ...hbar(), mirrorUrl: undefined, rangeWidth: undefined, holderFloorTinybar: undefined })).hedera;
    expect("mirrorUrl" in chain || "rangeWidth" in chain || "holderFloorTinybar" in chain).toBe(false);
  });
});

describe("chain inventory: native asset", () => {
  it("lists the native asset as the configured token and validates", () => {
    expect(configChainTokens(hbar())).toEqual([{ address: "native", decimals: 8 }]);
    const project = { slug: "hbar", config: config() };
    const inv = buildInventory({ project, supplies: { hedera: { native: 5e10 } }, explorerUrl: () => "must-not-be-used" });
    expect(inv.chains[0]).toMatchObject({ chain: "hedera", vm: "hedera", status: "configured" });
    expect(inv.chains[0].tokens).toMatchObject([{ address: "native", decimals: 8, totalSupply: 5e10, explorer: null }]);
    expect(validateInventory({ slug: "hbar", ...project.config }, inv)).toEqual([]);
  });
});

describe("chainStatus: hedera", () => {
  it("carries the vm and scannedAt, like Solana", () => {
    const cp = { generatedAt: "g", chains: { hedera: { vm: "hedera", lastBlock: 102000000, scannedAt: "2026-11-08T07:00:00.000Z" } } };
    expect(buildChainStatus(cp, ["hedera"]).chains.hedera).toEqual({ lastBlock: 102000000, vm: "hedera", scannedAt: "2026-11-08T07:00:00.000Z" });
  });
});

describe("add-project: hedera", () => {
  it("scaffolds a native chain from hedera:native:8", () => {
    expect(chainEntry("hedera:native:8", 0)).toMatchObject({ key: "hedera", vm: "hedera", origin: true, asset: { kind: "native", decimals: 8 } });
    expect(chainEntry("hedera:native:8", 0).tokens).toBeUndefined();
  });
  it("rejects anything but native for hedera", () => expect(() => chainEntry("hedera:0x1234:8", 0)).toThrow(/native/));
});

describe("hedera clock density", () => {
  const blockBody = (n, from) => ({ number: n, timestamp: { from: from.toFixed(9), to: (from + 1).toFixed(9) } });
  const fake = (blocks) => ({
    async getJson(path) {
      if (path.startsWith("/blocks?")) {
        const at = Number(/lte:([\d.]+)/.exec(path)?.[1] ?? Infinity);
        const hit = blocks.filter((b) => b.t <= at).at(-1);
        return { blocks: hit ? [blockBody(hit.n, hit.t)] : [] };
      }
      const n = Number(/^\/blocks\/(\d+)$/.exec(path)?.[1]);
      const b = blocks.find((x) => x.n === n);
      if (!b) throw new Error(`mirror GET ${path}: HTTP 404`);
      return blockBody(b.n, b.t);
    },
  });

  it("blockAtOrBefore accepts a dense neighbourhood", async () => {
    const clock = createHederaClock(fake([{ n: 9, t: 90 }, { n: 10, t: 100 }, { n: 11, t: 110 }]));
    expect(await clock.blockAtOrBefore("105.000000000")).toMatchObject({ number: 10 });
  });
  it("rejects when the neighbour block is missing, so the numbering has a gap", async () => {
    const clock = createHederaClock(fake([{ n: 10, t: 100 }, { n: 12, t: 120 }]));
    await expect(clock.blockAtOrBefore("105.000000000")).rejects.toThrow(/dense|gap|404/);
  });
  it("rejects when timestamps do not increase with the number", async () => {
    const clock = createHederaClock(fake([{ n: 9, t: 130 }, { n: 10, t: 100 }, { n: 11, t: 110 }]));
    await expect(clock.blockAtOrBefore("105.000000000")).rejects.toThrow(/dense|order/);
  });
});
