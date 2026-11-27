import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getReserveRpcUrls, getPublicFallbackUrls, __resetRpcCachesForTests } from "./rpc.js";
import { __resetBudgetGuardForTests } from "./rpcMetrics.js";

const ok = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200, headers: { "content-type": "application/json" } });
const ALCHEMY = "https://polygon-mainnet.g.alchemy.com/v2/k0";
const OTHER_KEY = "https://polygon.keyed.example/v1/k1";
const ENV_KEYS = ["MATIC_RPC_0", "MATIC_RPC_1", "HD_JOB_ID", "HD_HAS_EVM", "HD_JOB_ALCHEMY_CU_BUDGET", "HD_JOB_BUDGET_MODE", "PUBLIC_RPC_URLS_POLYGON"];

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  __resetRpcCachesForTests();
  __resetBudgetGuardForTests();
  globalThis.fetch = vi.fn(async () => ok());
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) delete process.env[k];
  __resetBudgetGuardForTests();
  vi.restoreAllMocks();
});

describe("getReserveRpcUrls (the fallback a failing pool falls through to)", () => {
  it("for a keyed pool: the chain's keyless public endpoints", async () => {
    process.env.MATIC_RPC_0 = ALCHEMY;
    expect(await getReserveRpcUrls("polygon", [ALCHEMY])).toEqual(getPublicFallbackUrls("polygon"));
  });

  it("for a public pool: the configured keys, after any public endpoint the pool left out", async () => {
    process.env.MATIC_RPC_0 = ALCHEMY;
    process.env.MATIC_RPC_1 = OTHER_KEY;
    const pub = getPublicFallbackUrls("polygon");
    expect(await getReserveRpcUrls("polygon", pub.slice(1))).toEqual([pub[0], ALCHEMY, OTHER_KEY]);
  });

  it("leaves out endpoints that do not answer", async () => {
    process.env.MATIC_RPC_0 = ALCHEMY;
    const pub = getPublicFallbackUrls("polygon");
    globalThis.fetch = vi.fn(async (url) => (url === pub[1] ? new Response("down", { status: 503 }) : ok()));
    expect(await getReserveRpcUrls("polygon", [])).toEqual([pub[0], ...pub.slice(2), ALCHEMY]);
  });

  it("never offers an Alchemy key once the job's enforced budget is spent, other keys stay", async () => {
    process.env.MATIC_RPC_0 = ALCHEMY;
    process.env.MATIC_RPC_1 = OTHER_KEY;
    Object.assign(process.env, { HD_JOB_ID: "staker-balances", HD_JOB_ALCHEMY_CU_BUDGET: "0", HD_JOB_BUDGET_MODE: "enforce" });
    const pub = getPublicFallbackUrls("polygon");
    const reserve = await getReserveRpcUrls("polygon", pub);
    expect(reserve).toEqual([OTHER_KEY]);
  });

  it("a project with no EVM chain (Solana, Hedera) never gets an Alchemy key from the reserve", async () => {
    process.env.MATIC_RPC_0 = ALCHEMY;
    Object.assign(process.env, { HD_JOB_ID: "holders", HD_HAS_EVM: "false" });
    const reserve = await getReserveRpcUrls("polygon", []);
    expect(reserve.some((u) => u.includes("alchemy"))).toBe(false);
  });
});
