import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveChainsFromProject,
  projectChainKeysByVm,
  projectChains,
  projectChainsAllVms,
  projectRoleAddresses,
  resolveProject,
  validateProjectConfig,
} from "./projects.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_BRIDGE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM_TOKEN = "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eB48";
const EVM_LOCK = "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf";
const repo = process.cwd();

const solanaChain = (extra = {}) => ({ key: "solana", name: "Solana", vm: "solana", tokens: [{ address: MINT, decimals: 6, program: "spl-token" }], ...extra });
const MIXED = {
  slug: "mix",
  ticker: "MIX",
  chains: [
    {
      key: "ethereum", name: "Ethereum", chainId: 1, origin: true, explorer: "https://etherscan.io",
      tokens: [{ address: EVM_TOKEN, decimals: 6, deployBlock: 100 }],
      contracts: { lock: { address: EVM_LOCK, role: "bridge" } },
    },
    { key: "polygon", name: "Polygon", chainId: 137, bridge: "lock-mint", explorer: "https://polygonscan.com", tokens: [{ address: EVM_TOKEN, decimals: 6 }] },
    solanaChain({ bridge: "burn-mint", contracts: { treasury: { address: SOL_BRIDGE, role: "escrow" } } }),
  ],
};

describe("validateProjectConfig", () => {
  it("every shipped config validates with no errors (TEL unchanged)", () => {
    for (const f of fs.readdirSync(path.join(repo, "config/projects")).filter((n) => n.endsWith(".json"))) {
      const config = JSON.parse(fs.readFileSync(path.join(repo, "config/projects", f), "utf8"));
      expect(validateProjectConfig(config), f).toEqual({ errors: [], warnings: [] });
    }
  });

  it("accepts a mixed EVM + Solana project", () => {
    expect(validateProjectConfig(MIXED)).toEqual({ errors: [], warnings: [] });
  });

  it("rejects EVM-only fields on a Solana chain", () => {
    const { errors } = validateProjectConfig({
      chains: [solanaChain({ chainId: 101, fromBlock: 5, tokens: [{ address: MINT, deployBlock: 3 }] })],
    });
    expect(errors.join("\n")).toMatch(/chainId is EVM-only/);
    expect(errors.join("\n")).toMatch(/fromBlock is EVM-only/);
    expect(errors.join("\n")).toMatch(/deployBlock is EVM-only/);
  });

  it("rejects bad mints, programs, clusters, vms and bridge modes", () => {
    const bad = (c) => validateProjectConfig({ chains: [c] }).errors.join("\n");
    expect(bad(solanaChain({ tokens: [{ address: MINT.toLowerCase().slice(0, 20) }] }))).toMatch(/not a base58 Solana mint/);
    expect(bad(solanaChain({ tokens: [{ address: EVM_TOKEN }] }))).toMatch(/not a base58 Solana mint/);
    expect(bad(solanaChain({ tokens: [{ address: MINT, program: "token-2023" }] }))).toMatch(/program must be/);
    expect(bad(solanaChain({ cluster: "devnet" }))).toMatch(/cluster/);
    expect(bad(solanaChain({ tokens: [] }))).toMatch(/needs tokens/);
    expect(bad({ key: "x", vm: "move", tokens: [] })).toMatch(/unknown vm/);
    expect(bad({ key: "x", bridge: "wrapped", tokens: [] })).toMatch(/unknown bridge/);
    expect(bad({ key: "x", cluster: "mainnet-beta", tokens: [] })).toMatch(/cluster is Solana-only/);
    expect(bad(solanaChain({ explorerTemplates: { address: "https://x.example/a/" } }))).toMatch(/explorerTemplates.address/);
    expect(bad(solanaChain({ contracts: { lock: { address: EVM_LOCK, role: "bridge" } } }))).toMatch(/contracts.lock is not a base58/);
  });

  it("lock-mint without an origin is an error; without an origin lock contract a warning", () => {
    const noOrigin = validateProjectConfig({ chains: [{ key: "polygon", bridge: "lock-mint", tokens: [] }] });
    expect(noOrigin.errors.join("\n")).toMatch(/no chain is marked origin/);
    const noLock = validateProjectConfig({
      chains: [{ key: "ethereum", origin: true, tokens: [] }, { key: "polygon", bridge: "lock-mint", tokens: [] }],
    });
    expect(noLock.errors).toEqual([]);
    expect(noLock.warnings.join("\n")).toMatch(/lists no contract with role "bridge" or "escrow"/);
  });

  it("warns that chains[].bridge is ignored on the TEL-style supply path", () => {
    const r = validateProjectConfig({ supply: { generationsSumOneToOne: true }, chains: [{ key: "a", origin: true }, { key: "b", bridge: "burn-mint" }] });
    expect(r.warnings.join("\n")).toMatch(/generationsSumOneToOne/);
  });
});

describe("Solana-aware chain map", () => {
  it("keeps base58 case, drops chainId/fromBlock, defaults to Solscan", () => {
    const d = deriveChainsFromProject(MIXED);
    expect(d.solana).toEqual({
      key: "solana",
      name: "Solana",
      vm: "solana",
      cluster: "mainnet-beta",
      bridge: "burn-mint",
      tokenAddress: MINT,
      decimals: 6,
      explorer: { address: `https://solscan.io/account/${MINT}`, token: `https://solscan.io/token/${MINT}` },
      explorerTemplates: {
        token: "https://solscan.io/token/{address}",
        address: "https://solscan.io/account/{address}",
        tx: "https://solscan.io/tx/{tx}",
      },
      tokens: { legacy: { address: MINT, decimals: 6, program: "spl-token" } },
      contracts: { treasury: { address: SOL_BRIDGE, role: "escrow" } },
    });
    // EVM entries keep lowercasing; bridge/role are additive.
    expect(d.ethereum.tokenAddress).toBe(EVM_TOKEN.toLowerCase());
    expect(d.ethereum.contracts.lock).toEqual({ address: EVM_LOCK.toLowerCase(), role: "bridge" });
    expect(d.polygon.bridge).toBe("lock-mint");
  });

  it("role addresses: hex lowercased, base58 as written", () => {
    expect(projectRoleAddresses(MIXED)).toEqual({
      ethereum: [{ name: "lock", address: EVM_LOCK.toLowerCase(), role: "bridge" }],
      solana: [{ name: "treasury", address: SOL_BRIDGE, role: "escrow" }],
    });
    expect(projectChainKeysByVm(MIXED, "solana")).toEqual(["solana"]);
  });
});

describe("project resolution with Solana", () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-sol-"));
    fs.mkdirSync(path.join(tmp, "config/projects"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config/projects.json"), JSON.stringify({ projects: [
      { slug: "tel", name: "Telcoin", ticker: "TEL", default: true },
      { slug: "mix", name: "Mix", ticker: "MIX" },
      { slug: "broken", name: "Broken", ticker: "BRK" },
    ] }));
    fs.writeFileSync(path.join(tmp, "config/projects/tel.json"), JSON.stringify({ slug: "tel", ticker: "TEL", data: { legacyRoot: true }, chains: [] }));
    fs.writeFileSync(path.join(tmp, "config/projects/mix.json"), JSON.stringify(MIXED));
    fs.writeFileSync(path.join(tmp, "config/projects/broken.json"), JSON.stringify({ slug: "broken", chains: [solanaChain({ chainId: 1 })] }));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("refuses an invalid config before any network call", () => {
    expect(() => resolveProject("broken", tmp)).toThrow(/chainId is EVM-only/);
  });

  it("EVM-only consumers get EVM chains; the dispatcher gets every vm", () => {
    const mix = resolveProject("mix", tmp);
    expect(Object.keys(projectChains(mix, tmp))).toEqual(["ethereum", "polygon"]);
    expect(Object.keys(projectChainsAllVms(mix, tmp))).toEqual(["ethereum", "polygon", "solana"]);
  });

  it("TEL: the default and all-vm chain maps are both config/chains.json", () => {
    const tel = resolveProject("tel");
    const chainsJson = JSON.parse(fs.readFileSync(path.join(repo, "config/chains.json"), "utf8"));
    expect(projectChains(tel, repo)).toEqual(chainsJson);
    expect(projectChainsAllVms(tel, repo)).toEqual(chainsJson);
  });
});
