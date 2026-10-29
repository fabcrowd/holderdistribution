/**
 * Multi-token pipeline wiring (docs/MULTI-TOKEN.md "Pipeline"):
 *   - TEL (legacyRoot) still reads/writes public/data/ and resolves exactly the
 *     addresses the scripts used to hardcode / read from config/chains.json;
 *   - a non-legacy project targets public/data/<slug>/ and resolves every
 *     address from its own config/projects/<slug>.json;
 *   - un-ported scripts still refuse non-legacy projects (exit 2).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  deriveChainsFromProject,
  pipelineProject,
  projectChains,
  projectClassificationPath,
  projectDataPath,
  projectDataRelPath,
  projectNonRetailPaths,
  projectPaths,
  projectStakingContracts,
  projectTokenAddress,
  resolveProject,
} from "./projects.js";
import { resolveStakeChangedTarget } from "./stakerTarget.js";
import { exchangeFlowChains } from "./exchangeFlowChains.js";
import { STAKING_DEPLOY_BLOCK } from "./stakingDiscovery.js";
import { buildReconciliation, TEL_TOTAL_SUPPLY, COINGECKO_CIRCULATING } from "./reconcileSupply.js";
import { reconcilePaths, reconcileOptions } from "../reconcile-supply.js";
import { loadNonRetailSet } from "./nonRetailSet.js";

const repo = path.resolve(".");
const chainsJson = JSON.parse(fs.readFileSync(path.join(repo, "config/chains.json"), "utf8"));
const tel = resolveProject("tel", repo);

// A second, NON-legacy project with made-up (never real) addresses.
const A = (n) => `0x${String(n).repeat(40).slice(0, 40)}`;
const DEMO = {
  slug: "demo",
  name: "Demo",
  ticker: "DMO",
  supply: { target: 1_000_000 },
  chains: [
    { key: "ethereum", name: "Ethereum", chainId: 1, origin: true, fromBlock: 123, explorer: "https://etherscan.io",
      tokens: [{ generation: "v1", address: A("A"), decimals: 18, deployBlock: 120 }] },
    { key: "arbitrum", name: "Arbitrum", chainId: 42161, explorer: "https://arbiscan.io",
      tokens: [{ generation: "v1", address: A("B"), decimals: 6, deployBlock: 77 }] },
  ],
  staking: [{ chain: "ethereum", address: A("C"), name: "Demo staking", token: "v1", kind: "stakeChanged", deployBlock: 130 }],
  classification: { exclusions: "config/projects/demo/exclusions.json" },
};

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-pipe-"));
  fs.mkdirSync(path.join(tmp, "config/projects/demo"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "config/projects.json"), JSON.stringify({ projects: [
    { slug: "tel", name: "Telcoin", ticker: "TEL", default: true }, { slug: "demo", name: "Demo", ticker: "DMO" },
  ] }));
  // Fixture TEL keeps the real tel.json semantics (legacyRoot) but no chainsConfig file in tmp.
  fs.writeFileSync(path.join(tmp, "config/projects/tel.json"), JSON.stringify({ slug: "tel", ticker: "TEL", data: { legacyRoot: true }, supply: { target: 100_000_000_000 }, chains: [] }));
  fs.writeFileSync(path.join(tmp, "config/projects/demo.json"), JSON.stringify(DEMO));
  fs.writeFileSync(path.join(tmp, "config/projects/demo/exclusions.json"), JSON.stringify({ addresses: [A("D")], labels: {} }));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("data paths", () => {
  it("default / tel targets the public/data/ root", () => {
    expect(pipelineProject("t", { argv: [], env: {}, root: repo, ported: true }).dataDir).toBe("public/data");
    expect(projectDataPath(tel, "tel-holders.json", repo)).toBe(path.join(repo, "public/data/tel-holders.json"));
    expect(projectDataRelPath(tel, "funding-wallets.json")).toBe("public/data/funding-wallets.json");
    const data = projectPaths(tel, repo);
    expect(data("holders-lite.json")).toBe(path.join(repo, "public/data/holders-lite.json"));
    expect(data.rel("holders-checkpoint.json")).toBe("public/data/holders-checkpoint.json");
    // HD_PROJECT=tel is the same thing.
    expect(pipelineProject("t", { argv: [], env: { HD_PROJECT: "tel" }, root: repo, ported: true }).dataDir).toBe("public/data");
  });

  it("a non-legacy project targets public/data/<slug>/ (ported scripts only)", () => {
    expect(() => pipelineProject("x", { argv: ["--project", "demo"], env: {}, root: tmp })).toThrow(/not wired/);
    const demo = pipelineProject("x", { argv: ["--project", "demo"], env: {}, root: tmp, ported: true });
    expect(demo.dataDir).toBe("public/data/demo");
    expect(projectPaths(demo, tmp)("tel-holders.json")).toBe(path.join(tmp, "public/data/demo/tel-holders.json"));
    expect(projectDataRelPath(demo, "funding-wallets.json")).toBe("public/data/demo/funding-wallets.json");
  });

  it("refuses path traversal in file names", () => {
    expect(() => projectDataPath(tel, "../config/chains.json", repo)).toThrow(/bad file name/);
    expect(() => projectDataPath(tel, "/etc/passwd", repo)).toThrow(/bad file name/);
  });
});

describe("classification paths", () => {
  it("TEL keeps the config/ root files", () => {
    expect(projectClassificationPath(tel, "exclusions", repo)).toBe(path.join(repo, "config/exclusions.json"));
    expect(projectClassificationPath(tel, "cexWallets", repo)).toBe(path.join(repo, "config/cex-wallets.json"));
    expect(projectNonRetailPaths(tel, repo)).toEqual({
      exclusionsPath: path.join(repo, "config/exclusions.json"),
      cexPath: path.join(repo, "config/cex-wallets.json"),
      dexPath: path.join(repo, "config/dex-contracts.json"),
    });
  });

  it("a non-legacy project reads its own files and never inherits TEL's", () => {
    const demo = resolveProject("demo", tmp);
    expect(projectClassificationPath(demo, "exclusions", tmp)).toBe(path.join(tmp, "config/projects/demo/exclusions.json"));
    expect(projectClassificationPath(demo, "cexWallets", tmp)).toBeNull();
    expect(projectClassificationPath(demo, "dexContracts", tmp)).toBeNull();
  });
});

describe("non-retail set per project", () => {
  it("null paths (project declares no list) give an empty set; TEL paths match the defaults", async () => {
    const none = await loadNonRetailSet({ exclusionsPath: null, cexPath: null, dexPath: null });
    expect(none.set.size).toBe(0);
    const def = await loadNonRetailSet();
    const viaTel = await loadNonRetailSet(projectNonRetailPaths(tel, repo));
    expect([...viaTel.set].sort()).toEqual([...def.set].sort());
    expect(viaTel.sizes).toEqual(def.sizes);
  });
});

describe("address resolution reads project config", () => {
  it("TEL: projectChains is config/chains.json, unchanged", () => {
    expect(projectChains(tel, repo)).toEqual(chainsJson);
  });

  it("TEL: chains derived from tel.json agree with config/chains.json", () => {
    const derived = deriveChainsFromProject(tel.config);
    expect(Object.keys(derived)).toEqual(Object.keys(chainsJson));
    for (const [key, c] of Object.entries(chainsJson)) {
      const d = derived[key];
      expect(d.chainId).toBe(c.chainId);
      expect(Boolean(d.origin)).toBe(Boolean(c.origin));
      expect(d.tokenAddress).toBe(c.tokenAddress);
      expect(d.decimals).toBe(c.decimals);
      expect(d.fromBlock).toBe(c.fromBlock);
      expect(d.tokens.legacy).toMatchObject({ address: c.tokens.legacy.address, decimals: c.tokens.legacy.decimals });
      expect(d.tokens.v3).toMatchObject({ address: c.tokens.v3.address, decimals: c.tokens.v3.decimals, deployBlock: c.tokens.v3.deployBlock });
      for (const [name, v] of Object.entries(c.contracts)) expect(d.contracts[name].address).toBe(v.address);
      const mods = (c.tokens.v3.staking ?? []).map((m) => ({ address: m.address, deployBlock: m.deployBlock }));
      expect((d.tokens.v3.staking ?? []).map((m) => ({ address: m.address, deployBlock: m.deployBlock }))).toEqual(mods);
    }
  });

  it("TEL: StakeChanged target equals the constants pull-staker-balances / pull-holders-rpc used to hardcode", () => {
    expect(resolveStakeChangedTarget(tel)).toEqual({
      chain: "polygon",
      chainId: 137,
      contract: "0x92e43aec69207755cb1e6a8dc589aae630476330",
      tokenAddress: "0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32",
      decimals: 2,
      deployBlock: STAKING_DEPLOY_BLOCK,
      name: "Legacy TEL staking (proxy)",
    });
    expect(projectStakingContracts(tel, { kind: "receiptModule" }).map((s) => s.address)).toEqual([
      "0x573105be2148b8621f202a6d510016a2aa825731",
    ]);
    expect(projectTokenAddress(tel, "base", "legacy")).toBe("0x09be1692ca16e06f536f0038ff11d1da8524adb1");
  });

  it("TEL: exchange-flow chain table is identical to the old literal table", () => {
    expect(exchangeFlowChains(tel, chainsJson, {})).toEqual({
      ethereum: { token: "0x467bccd9d29f223bce8043b84e8c8b282827790f", chunk: 800, defaultStart: 22_800_000, divisor: 100 },
      polygon: { token: "0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32", chunk: 1000, defaultStart: 74_400_000, divisor: 100 },
      base: { token: "0x09be1692ca16e06f536f0038ff11d1da8524adb1", chunk: 1000, defaultStart: 25_614_028, divisor: 100 },
    });
    expect(exchangeFlowChains(tel, chainsJson, { FLOW_START_BLOCK_BASE: "5", FLOW_CHUNK_BASE: "9" }).base).toMatchObject({ defaultStart: 5, chunk: 9 });
    expect(exchangeFlowChains(tel, chainsJson, { FLOW_START_BLOCK_ETH: "7" }).ethereum.defaultStart).toBe(7);
    expect(exchangeFlowChains(tel, chainsJson, { FLOW_START_BLOCK_ETHEREUM: "8" }).ethereum.defaultStart).toBe(8);
  });

  it("non-legacy: chains, staking and flow table come from the project's own config", () => {
    const demo = resolveProject("demo", tmp);
    const chains = projectChains(demo, tmp);
    expect(Object.keys(chains)).toEqual(["ethereum", "arbitrum"]);
    expect(chains.ethereum).toMatchObject({ tokenAddress: A("a"), decimals: 18, fromBlock: 123, origin: true, tokens: { legacy: { address: A("a") } } });
    expect(chains.arbitrum).toMatchObject({ tokenAddress: A("b"), decimals: 6, fromBlock: 77 });
    expect(chains.ethereum.tokens.v3).toBeUndefined();
    expect(resolveStakeChangedTarget(demo)).toMatchObject({ chain: "ethereum", chainId: 1, contract: A("c"), tokenAddress: A("a"), decimals: 18, deployBlock: 130 });
    expect(exchangeFlowChains(demo, chains, {})).toEqual({
      ethereum: { token: A("a"), chunk: 800, defaultStart: 123, divisor: 1e18 },
      arbitrum: { token: A("b"), chunk: 1000, defaultStart: 77, divisor: 1e6 },
    });
  });

  it("a project without a StakeChanged contract resolves to null (staker script skips)", () => {
    expect(resolveStakeChangedTarget({ slug: "x", config: { chains: [], staking: [] } })).toBeNull();
  });
});

describe("reconcile-supply per project", () => {
  it("TEL paths and options are unchanged", () => {
    expect(reconcilePaths(tel, repo)).toEqual({
      holders: path.join(repo, "public/data/tel-holders.json"),
      exclusions: path.join(repo, "config/exclusions.json"),
      cexWallets: path.join(repo, "config/cex-wallets.json"),
      output: path.join(repo, "public/data/supply-reconciliation.json"),
    });
    expect(reconcileOptions(tel)).toEqual({
      totalSupply: TEL_TOTAL_SUPPLY,
      coingeckoCirculating: null,
      circulatingSubtract: ["treasury", "council"],
      chains: ["ethereum", "polygon", "base"],
      origin: "ethereum",
      upgrade: { generation: "v3" },
    });
  });

  it("buildReconciliation defaults to the TEL total supply and does not assume a CoinGecko figure", () => {
    const snapshot = {
      chainOrder: ["ethereum", "polygon", "base"],
      wallets: [
        { address: A(1), ethereum_balance: 10, polygon_balance: 5, base_balance: 1 },
        { address: A(2), ethereum_balance: 7, polygon_balance: 0, base_balance: 3 },
      ],
    };
    const a = buildReconciliation(snapshot, { labels: {} }, { wallets: [] });
    const b = buildReconciliation(snapshot, { labels: {} }, { wallets: [] }, { totalSupply: TEL_TOTAL_SUPPLY, coingeckoCirculating: COINGECKO_CIRCULATING });
    expect(a.totalSupply).toBe(TEL_TOTAL_SUPPLY);
    expect(a.coingeckoCirculating).toBeNull();
    expect(b.coingeckoCirculating).toBe(COINGECKO_CIRCULATING);
    const { coingeckoCirculating: droppedA, ...restA } = a;
    const { coingeckoCirculating: droppedB, ...restB } = b;
    expect(droppedA).toBeNull();
    expect(droppedB).toBe(COINGECKO_CIRCULATING);
    expect(restA).toEqual(restB);
    expect(a.counted).toBe(26);
    expect(a.mirrored).toBe(9);
  });

  it("non-legacy: own data dir, own supply target, own chains", () => {
    const demo = resolveProject("demo", tmp);
    expect(reconcilePaths(demo, tmp)).toEqual({
      holders: path.join(tmp, "public/data/demo/tel-holders.json"),
      exclusions: path.join(tmp, "config/projects/demo/exclusions.json"),
      cexWallets: null,
      output: path.join(tmp, "public/data/demo/supply-reconciliation.json"),
    });
    expect(reconcileOptions(demo)).toEqual({
      totalSupply: 1_000_000,
      coingeckoCirculating: null,
      circulatingSubtract: ["treasury", "council"],
      chains: ["ethereum", "arbitrum"],
      origin: "ethereum",
    });
    const r = buildReconciliation(
      { chainOrder: ["ethereum", "arbitrum"], wallets: [{ address: A(1), ethereum_balance: 600_000, arbitrum_balance: 400_000 }] },
      { labels: {} }, { wallets: [] }, reconcileOptions(demo),
    );
    expect(r.counted).toBe(1_000_000);
    expect(r.residual).toBe(0);
    expect(r.mirrored).toBe(400_000);
    expect(r.coingeckoCirculating).toBeNull();
  });
});

describe("scripts end to end (fixture repo, no network)", () => {
  const run = (script, args) =>
    spawnSync(process.execPath, [path.join(repo, "scripts", script), ...args], { cwd: tmp, encoding: "utf8", env: { ...process.env, HD_PROJECT: "" } });

  it("reconcile-supply writes public/data/<slug>/ for demo and public/data/ for tel", () => {
    const snap = { chainOrder: ["ethereum", "arbitrum"], wallets: [{ address: A(1), ethereum_balance: 600_000, arbitrum_balance: 400_000 }] };
    fs.mkdirSync(path.join(tmp, "public/data/demo"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "public/data/demo/tel-holders.json"), JSON.stringify(snap));
    const r = run("reconcile-supply.js", ["--project", "demo"]);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(fs.readFileSync(path.join(tmp, "public/data/demo/supply-reconciliation.json"), "utf8"));
    expect(out.totalSupply).toBe(1_000_000);
    expect(fs.existsSync(path.join(tmp, "public/data/supply-reconciliation.json"))).toBe(false);

    fs.writeFileSync(path.join(tmp, "public/data/tel-holders.json"), JSON.stringify({ wallets: [{ address: A(1), ethereum_balance: 5, polygon_balance: 0, base_balance: 0 }] }));
    const t = run("reconcile-supply.js", []); // default project = tel
    expect(t.status, t.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "public/data/supply-reconciliation.json"), "utf8")).totalSupply).toBe(TEL_TOTAL_SUPPLY);
  });

  it("un-ported scripts are still refused for a non-legacy project", () => {
    // Every workflow script is ported now; the guard itself must keep refusing.
    expect(() => pipelineProject("some-unported-script", { argv: ["--project", "demo"], env: {}, root: tmp })).toThrow(
      /not wired into the data pipeline/,
    );
  });
});
