import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import {
  rpcEnvPrefix,
  rpcEnvKeys,
  getAllRpcUrls,
  getPublicFallbackUrls,
  configureProjectRpc,
  __resetRpcCachesForTests,
} from "./rpc.js";
import { resolveProject } from "./projects.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const touched = [];
const setEnv = (k, v) => { touched.push(k); process.env[k] = v; };

beforeEach(() => __resetRpcCachesForTests());
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
  __resetRpcCachesForTests();
});

// Verbatim copies of rpc.js's pre-multi-chain tables.
const OLD_KEYS = {
  ethereum: Array.from({ length: 16 }, (_, i) => `ETH_RPC_${i}`),
  polygon: Array.from({ length: 16 }, (_, i) => `MATIC_RPC_${i}`),
  base: Array.from({ length: 16 }, (_, i) => `BASE_RPC_${i}`),
};
const OLD_PUBLIC = {
  ethereum: ["https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"],
  polygon: ["https://polygon-bor-rpc.publicnode.com", "https://gateway.tenderly.co/public/polygon", "https://poly.api.pocket.network"],
  base: ["https://base.gateway.tenderly.co", "https://base-rpc.polkachu.com", "https://base.rpc.blxrbdn.com"],
};

describe("TEL's three chains keep their exact RPC wiring", () => {
  it("same env key pools and public fallbacks, before and after configuring TEL", () => {
    const check = () => {
      for (const chain of Object.keys(OLD_KEYS)) {
        expect(rpcEnvKeys(chain)).toEqual(OLD_KEYS[chain]);
        expect(getPublicFallbackUrls(chain)).toEqual(OLD_PUBLIC[chain]);
      }
    };
    check();
    expect(configureProjectRpc(resolveProject("tel", ROOT).config)).toEqual([]);
    check();
  });

  it("still reads ETH_RPC_n for ethereum", () => {
    setEnv("ETH_RPC_3", "https://example.invalid/eth/");
    expect(getAllRpcUrls("ethereum")).toEqual(["https://example.invalid/eth"]);
  });
});

describe("chains a project declares beyond ethereum/polygon/base", () => {
  const demo = {
    slug: "demo",
    chains: [
      { key: "ethereum", name: "Ethereum" },
      { key: "arbitrum", name: "Arbitrum", rpc: { envPrefix: "ARB", publicUrls: ["https://arb.example.invalid/"] } },
      { key: "linea", name: "Linea", rpc: { publicUrls: ["https://linea.example.invalid"] } },
    ],
  };

  it("registers the key pool prefix and public fallbacks from project config", () => {
    expect(configureProjectRpc(demo)).toEqual(["arbitrum", "linea"]);
    expect(rpcEnvPrefix("arbitrum")).toBe("ARB");
    expect(rpcEnvKeys("arbitrum")[0]).toBe("ARB_RPC_0");
    expect(getPublicFallbackUrls("arbitrum")).toEqual(["https://arb.example.invalid"]);
    // No envPrefix: defaults to the upper-cased key.
    expect(rpcEnvKeys("linea")[9]).toBe("LINEA_RPC_9");
    expect(getPublicFallbackUrls("linea")).toEqual(["https://linea.example.invalid"]);
    setEnv("ARB_RPC_1", "https://key.example.invalid/arb");
    expect(getAllRpcUrls("arbitrum")).toEqual(["https://key.example.invalid/arb"]);
    // Ethereum without an rpc block keeps the built-ins.
    expect(getPublicFallbackUrls("ethereum")).toEqual(OLD_PUBLIC.ethereum);
  });

  it("an undeclared chain still gets a default prefix and any built-in free endpoints", () => {
    expect(rpcEnvKeys("optimism")[0]).toBe("OPTIMISM_RPC_0");
    expect(getPublicFallbackUrls("optimism").length).toBeGreaterThan(0);
    expect(getPublicFallbackUrls("some-new-chain")).toEqual([]);
    expect(rpcEnvKeys("some-new-chain")[0]).toBe("SOME_NEW_CHAIN_RPC_0");
  });

  it("PUBLIC_RPC_URLS_<CHAIN> env still wins, and PUBLIC_RPC_FALLBACK=off still disables", () => {
    configureProjectRpc(demo);
    setEnv("PUBLIC_RPC_URLS_ARBITRUM", "https://override.example.invalid");
    expect(getPublicFallbackUrls("arbitrum")).toEqual(["https://override.example.invalid"]);
    setEnv("PUBLIC_RPC_FALLBACK", "off");
    expect(getPublicFallbackUrls("arbitrum")).toEqual([]);
  });

  it("rejects malformed rpc blocks", () => {
    expect(() => configureProjectRpc({ chains: [{ key: "x", rpc: { envPrefix: "lower" } }] })).toThrow(/UPPER_SNAKE/);
    expect(() => configureProjectRpc({ chains: [{ key: "x", rpc: { publicUrls: ["http://insecure"] } }] })).toThrow(/https/);
  });
});
