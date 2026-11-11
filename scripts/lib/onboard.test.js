import { describe, expect, it } from "vitest";
import { findDeployBlock, imageExt, inferVm, planOnboarding, slugify, wholeTokens } from "./onboard.js";
import { validateInventory } from "./chainInventory.js";
import { scaffold, validateScaffold } from "../add-project.js";

const TOKEN = "0xFAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3";
const facts = (over = {}) => ({ name: "Ondo", symbol: "ONDO", decimals: 18, totalSupplyRaw: (10n ** 28n).toString(), deployBlock: 16_000_000, deployDate: "2022-11-20", ...over });
const discovery = {
  methods: ["same-address-rpc", "coingecko-platforms"],
  checkedAt: "2026-11-11T00:00:00Z",
  chains: [
    { chain: "ethereum", status: "configured" },
    { chain: "polygon", status: "candidate", address: "0x" + "ab".repeat(20), decimals: 18 },
    { chain: "base", status: "not-found" },
    { chain: "bsc", status: "rpc-error", error: "timeout" },
  ],
};
const registry = { projects: [{ slug: "tel", name: "Telcoin", ticker: "TEL", default: true }] };

const parseArgv = (argv) => {
  const out = { chains: [], wallets: [], stables: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === "--chain") out.chains.push(v);
    else if (k === "--wallet") out.wallets.push(v);
    else if (k === "--supply-target") out.supplyTarget = Number(v);
    else out[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
};

describe("inferVm", () => {
  it("reads the VM from the address shape", () => {
    expect(inferVm(TOKEN)).toBe("evm");
    expect(inferVm("ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU")).toBe("solana");
    expect(inferVm("0.0.1456985")).toBe("hedera");
    expect(inferVm("not an address")).toBeNull();
  });
});

describe("helpers", () => {
  it("slugify keeps registry-safe slugs only", () => {
    expect(slugify("zebec-network")).toBe("zebec-network");
    expect(slugify("Ondo Finance!")).toBe("ondo-finance");
    expect(slugify("")).toBeNull();
  });
  it("wholeTokens floors raw supply to whole tokens", () => {
    expect(wholeTokens("1234567", 3)).toBe(1234);
    expect(wholeTokens((10n ** 28n).toString(), 18)).toBe(10_000_000_000);
  });
  it("imageExt reads the extension, dropping the query", () => {
    expect(imageExt("https://coin-images.coingecko.com/coins/images/1/large/ondo.png?1696525000")).toBe("png");
    expect(imageExt("https://x/y.JPEG")).toBe("jpg");
    expect(imageExt("https://x/y")).toBe("png");
  });
  it("findDeployBlock finds the first block with code", async () => {
    const calls = [];
    const block = await findDeployBlock({ latest: 1_000_000, hasCode: async (b) => (calls.push(b), b >= 123_456) });
    expect(block).toBe(123_456);
    expect(calls.length).toBeLessThan(25);
  });
  it("findDeployBlock returns null when the node refuses historical state", async () => {
    expect(await findDeployBlock({ latest: 100, hasCode: async (b) => { if (b < 100) throw new Error("missing trie node"); return true; } })).toBeNull();
    expect(await findDeployBlock({ latest: 100, hasCode: async () => false })).toBeNull();
  });
});

describe("planOnboarding", () => {
  const plan = (over = {}) => planOnboarding({
    address: TOKEN,
    chain: "ethereum",
    facts: facts(),
    coingecko: { id: "ondo-finance", name: "Ondo", symbol: "ondo", image: "https://img/ondo.png?1" },
    discovery,
    now: new Date("2026-11-11T00:00:00Z"),
    ...over,
  });

  it("derives slug, ticker, supply, deploy block, history start and image", () => {
    const p = plan();
    expect(p).toMatchObject({ slug: "ondo", ticker: "ONDO", name: "Ondo", supplyTarget: 10_000_000_000, historyStart: "2022-11-20", image: { path: "/tokens/ondo.png" } });
    expect(p.argv).toEqual(expect.arrayContaining(["--chain", `ethereum:${TOKEN.toLowerCase()}:18:1:16000000`, "--supply-target", "10000000000", "--coingecko", "ondo-finance"]));
  });

  it("excludes undecided copies on other chains with a reason, so the inventory validates", () => {
    const p = plan();
    const byChain = Object.fromEntries(p.inventory.chains.map((r) => [r.chain, r]));
    expect(byChain.ethereum.status).toBe("configured");
    expect(byChain.polygon.status).toBe("excluded");
    expect(byChain.polygon.reason).toMatch(/--include polygon/);
    expect(byChain.base.status).toBe("not-found");
    expect(byChain.bsc.status).toBe("excluded");
    expect(byChain.bsc.reason).toMatch(/Public RPC failed/);
    expect(p.inventory.chains.some((r) => r.status === "candidate")).toBe(false);
    const project = scaffold(parseArgv(p.argv), registry).files[`config/projects/${p.slug}.json`];
    expect(validateInventory(project, p.inventory)).toEqual([]);
  });

  it("configures an included chain and the scaffold validates", () => {
    const p = plan({ included: { polygon: { address: "0x" + "ab".repeat(20), decimals: 18 } } });
    expect(p.inventory.chains.find((r) => r.chain === "polygon").status).toBe("configured");
    const result = scaffold(parseArgv(p.argv), registry);
    expect(validateScaffold(result).errors).toEqual([]);
    expect(validateInventory(result.files[`config/projects/${p.slug}.json`], p.inventory)).toEqual([]);
    expect(p.notes.join("\n")).toMatch(/polygon: configured as bridge "lock-mint"/);
  });

  it("keeps a Solana mint's case and needs no deploy block", () => {
    const mint = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
    const p = planOnboarding({ address: mint, chain: "solana", facts: facts({ symbol: "ZBCN", decimals: 6, totalSupplyRaw: "100000000000000000", deployBlock: null, deployDate: null }), coingecko: { id: "zebec-network", name: "Zebec Network" }, discovery: { chains: [{ chain: "solana", status: "configured" }] } });
    expect(p.argv).toEqual(expect.arrayContaining(["--chain", `solana:${mint}:6`]));
    expect(p.supplyTarget).toBe(100_000_000_000);
    expect(p.notes.join("\n")).not.toMatch(/deploy block/);
    expect(p.notes.join("\n")).toMatch(/no CoinGecko image/);
  });

  it("owner overrides win", () => {
    const p = plan({ overrides: { slug: "ondo-x", ticker: "ondo", name: "Ondo Finance", historyStart: "2024-01-18" } });
    expect(p).toMatchObject({ slug: "ondo-x", ticker: "ONDO", name: "Ondo Finance", historyStart: "2024-01-18" });
  });

  it("stops when decimals or supply cannot be verified on-chain", () => {
    expect(() => plan({ facts: facts({ decimals: null }) })).toThrow(/decimals/);
    expect(() => plan({ facts: facts({ totalSupplyRaw: null }) })).toThrow(/total supply/);
  });
});
