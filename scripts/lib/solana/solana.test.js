import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaplexMetadataPda, findProgramAddress, isOnCurve, METAPLEX_METADATA_PROGRAM } from "./pda.js";
import { fetchMintMetadata, parseMetaplexMetadata, parseMintAccount, rawToNumber, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./metadata.js";
import { aggregateTokenAccounts, holderScanParams, scanMintHolders } from "./splScanner.js";
import {
  __resetSolanaRpcForTests,
  getUsableSolanaRpcUrls,
  keyedFirst,
  solanaCallWithFailover,
  solanaPublicUrls,
  solanaRpcCandidates,
  SOLANA_PUBLIC_RPC,
} from "./rpc.js";
import { solanaAdapter, solanaBaseToken } from "./adapter.js";
import { base58Decode } from "../address.js";
import { __resetRpcCachesForTests, configureProjectRpc } from "../rpc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, "__fixtures__", name), "utf8"));

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
// Real owners (case-sensitive base58).
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const ACC = (n) => `${"1".repeat(43 - String(n).length)}${n}`.replace(/0/g, "2");
const silent = { log: vi.fn(), warn: vi.fn() };

const tokenAccount = (pubkey, owner, amount, mint = USDC) => ({
  pubkey,
  account: { data: { parsed: { info: { mint, owner, tokenAmount: { amount: String(amount) } }, type: "account" }, program: "spl-token" } },
});

describe("Metaplex PDA derivation (no @solana/web3.js)", () => {
  it("derives the known metadata PDAs (verified against mainnet)", () => {
    expect(metaplexMetadataPda(USDC)).toBe("5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq");
    expect(metaplexMetadataPda(BONK)).toBe("FDZZbyY9XGpL3CNKUZxLk3wFTTQYL3TkDiDzqxrizcPN");
  });

  it("PDAs are off-curve; real wallet keys are on-curve", () => {
    const [pda] = findProgramAddress([Buffer.from("metadata"), base58Decode(METAPLEX_METADATA_PROGRAM), base58Decode(USDC)], METAPLEX_METADATA_PROGRAM);
    expect(isOnCurve(base58Decode(pda))).toBe(false);
    expect(isOnCurve(base58Decode(ALICE))).toBe(true);
  });
});

describe("mint metadata", () => {
  it("parses an SPL mint (decimals, supply as bigint)", () => {
    const m = parseMintAccount(fixture("usdc-mint.json"), USDC);
    expect(m).toMatchObject({ program: "spl-token", programId: SPL_TOKEN_PROGRAM, decimals: 6 });
    expect(typeof m.supplyRaw).toBe("bigint");
    expect(m.supply).toBeCloseTo(Number(m.supplyRaw) / 1e6, 0);
    expect(m.symbol).toBe(null);
  });

  it("parses a Token-2022 mint with the tokenMetadata extension", () => {
    const m = parseMintAccount(fixture("pyusd-mint.json"), PYUSD);
    expect(m).toMatchObject({ program: "token-2022", programId: TOKEN_2022_PROGRAM, decimals: 6, symbol: "PYUSD" });
  });

  it("decodes Metaplex metadata (name / symbol)", () => {
    const md = fixture("usdc-metaplex.json");
    expect(parseMetaplexMetadata(md.data[0])).toMatchObject({ name: "USD Coin", symbol: "USDC" });
  });

  it("falls back to Metaplex when the mint has no metadata extension", async () => {
    const md = fixture("usdc-metaplex.json");
    const call = vi.fn(async (method, [addr]) => {
      if (addr === USDC) return { value: fixture("usdc-mint.json") };
      if (addr === metaplexMetadataPda(USDC)) return { value: { owner: md.owner, data: md.data } };
      throw new Error(`unexpected ${method} ${addr}`);
    });
    const meta = await fetchMintMetadata(call, USDC);
    expect(meta).toMatchObject({ symbol: "USDC", name: "USD Coin", metadataSource: "metaplex", decimals: 6 });
  });

  it("uses the config symbol when no metadata exists, and rejects non-mints", async () => {
    const call = async (_m, [addr]) => (addr === USDC ? { value: fixture("usdc-mint.json") } : { value: null });
    expect(await fetchMintMetadata(call, USDC, { fallbackSymbol: "XYZ" })).toMatchObject({ symbol: "XYZ", metadataSource: "config" });
    await expect(fetchMintMetadata(async () => ({ value: null }), USDC)).rejects.toThrow(/not found/);
    await expect(
      fetchMintMetadata(async () => ({ value: { ...fixture("usdc-mint.json"), owner: "11111111111111111111111111111111" } }), USDC),
    ).rejects.toThrow(/not the SPL Token/);
  });

  it("converts raw amounts without float loss on the integer part", () => {
    expect(rawToNumber(123456789n, 6)).toBeCloseTo(123.456789, 6);
    expect(rawToNumber(10n ** 18n, 9)).toBe(1e9);
  });
});

describe("SPL holder scan", () => {
  it("filters on dataSize + mint for SPL, mint only for Token-2022", () => {
    expect(holderScanParams(USDC, "spl-token").filters).toEqual([{ dataSize: 165 }, { memcmp: { offset: 0, bytes: USDC } }]);
    expect(holderScanParams(PYUSD, "token-2022").filters).toEqual([{ memcmp: { offset: 0, bytes: PYUSD } }]);
  });

  it("sums multiple token accounts per owner and drops zero balances; keeps case", () => {
    const rows = [
      tokenAccount(ACC(1), ALICE, 1_500_000),
      tokenAccount(ACC(2), ALICE, 500_000),
      tokenAccount(ACC(3), BOB, 0),
      tokenAccount(ACC(4), BOB, 250_000),
      tokenAccount(ACC(5), ALICE, 999, BONK), // other mint: ignored
    ];
    const agg = aggregateTokenAccounts(rows, { mint: USDC, decimals: 6 });
    expect(agg.holders).toEqual([
      { address: ALICE, raw: "2000000", balance: 2, accounts: 2 },
      { address: BOB, raw: "250000", balance: 0.25, accounts: 1 },
    ]);
    expect(agg.zeroAccounts).toBe(1);
    expect(agg.accounts).toBe(4);
    expect(agg.tokenAccountOwners.get(ACC(3))).toBe(BOB);
    expect(agg.totalRaw).toBe(2_250_000n);
  });

  it("refuses a partial snapshot (>1% gap vs mint supply)", async () => {
    const call = async () => ({ context: { slot: 42 }, value: [tokenAccount(ACC(1), ALICE, 900_000)] });
    await expect(
      scanMintHolders(call, { mint: USDC, programId: SPL_TOKEN_PROGRAM, program: "spl-token", decimals: 6, supplyRaw: 1_000_000n, logger: silent }),
    ).rejects.toThrow(/incomplete scan/);
    const ok = await scanMintHolders(call, {
      mint: USDC, programId: SPL_TOKEN_PROGRAM, program: "spl-token", decimals: 6, supplyRaw: 900_000n, logger: silent,
    });
    expect(ok.slot).toBe(42);
    expect(ok.holders[0].address).toBe(ALICE);
  });
});

describe("Solana RPC pool (matches the EVM pattern)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    __resetSolanaRpcForTests();
    __resetRpcCachesForTests?.();
    for (const k of Object.keys(process.env)) if (/^(SOLANA_RPC_|PUBLIC_RPC_)/.test(k)) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("puts the public endpoint first, then SOLANA_RPC_0..9 keys", () => {
    process.env.SOLANA_RPC_0 = "https://key-a.example/rpc";
    process.env.SOLANA_RPC_3 = "https://key-b.example/rpc";
    expect(solanaPublicUrls("solana")).toEqual([...SOLANA_PUBLIC_RPC]);
    expect(solanaRpcCandidates("solana")).toEqual([...SOLANA_PUBLIC_RPC, "https://key-a.example/rpc", "https://key-b.example/rpc"]);
  });

  it("keyedFirst moves keyed endpoints ahead of the public one, order otherwise kept", () => {
    const urls = [...SOLANA_PUBLIC_RPC, "https://key-a.example/rpc", "https://key-b.example/rpc"];
    expect(keyedFirst(urls, "solana")).toEqual(["https://key-a.example/rpc", "https://key-b.example/rpc", ...SOLANA_PUBLIC_RPC]);
    expect(keyedFirst([...SOLANA_PUBLIC_RPC], "solana")).toEqual([...SOLANA_PUBLIC_RPC]);
  });

  it("honours PUBLIC_RPC_FALLBACK=off and chains[].rpc.publicUrls", () => {
    configureProjectRpc({ chains: [{ key: "solana", rpc: { publicUrls: ["https://my-public.example"] } }] });
    expect(solanaPublicUrls("solana")).toEqual(["https://my-public.example"]);
    process.env.PUBLIC_RPC_FALLBACK = "off";
    expect(solanaPublicUrls("solana")).toEqual([]);
  });

  it("probes getHealth/getSlot, skips dead endpoints, throws when none answer", async () => {
    process.env.SOLANA_RPC_0 = "https://key-a.example/rpc";
    const call = vi.fn(async (url, method) => {
      if (url.includes("mainnet-beta")) throw new Error("429");
      return method === "getHealth" ? "ok" : 1;
    });
    expect(await getUsableSolanaRpcUrls("solana", { logger: silent, call })).toEqual(["https://key-a.example/rpc"]);
    __resetSolanaRpcForTests();
    await expect(getUsableSolanaRpcUrls("solana", { logger: silent, call: async () => { throw new Error("down"); } })).rejects.toThrow(
      /RPC pool solana: no usable endpoint/,
    );
  });

  it("fails over between endpoints and hints at a key for getProgramAccounts", async () => {
    const call = vi.fn(async (url) => {
      if (url === "https://a") throw new Error("410 disabled");
      return "result";
    });
    expect(await solanaCallWithFailover(["https://a", "https://b"], "getSlot", [], { call, logger: silent })).toBe("result");
    await expect(
      solanaCallWithFailover(["https://a"], "getProgramAccounts", [], { call, logger: silent }),
    ).rejects.toThrow(/SOLANA_RPC_0/);
  });
});

describe("solanaAdapter.scanChain", () => {
  beforeEach(() => __resetSolanaRpcForTests());

  it("returns the EVM scan shape: balances map, token totals, checkpoint slot", async () => {
    const supply = "2250000";
    const mint = { ...fixture("usdc-mint.json") };
    mint.data = { ...mint.data, parsed: { ...mint.data.parsed, info: { ...mint.data.parsed.info, supply } } };
    const md = fixture("usdc-metaplex.json");
    const call = vi.fn(async (_url, method, params) => {
      if (method === "getAccountInfo" && params[0] === USDC) return { value: mint };
      if (method === "getAccountInfo") return { value: { owner: md.owner, data: md.data } };
      if (method === "getProgramAccounts") {
        expect(params[0]).toBe(SPL_TOKEN_PROGRAM);
        return { context: { slot: 314 }, value: [tokenAccount(ACC(1), ALICE, 2_000_000), tokenAccount(ACC(2), BOB, 250_000), tokenAccount(ACC(3), BOB, 0)] };
      }
      throw new Error(method);
    });
    const chain = { key: "solana", vm: "solana", tokenAddress: USDC, tokens: { legacy: { address: USDC, decimals: 6, program: "spl-token" } } };
    expect(solanaBaseToken(chain).address).toBe(USDC);
    const r = await solanaAdapter.scanChain(chain, {
      logger: silent,
      call,
      probeCall: async () => "ok",
      now: () => new Date("2026-10-25T12:00:00Z"),
    });
    expect([...r.balances.entries()]).toEqual([[ALICE, 2], [BOB, 0.25]]);
    expect(r.tokenTotals).toEqual({ legacy: 2.25, v3: 0, retiredLegacy: 0, strandedInUpgrade: 0 });
    expect(r.checkpointData).toMatchObject({ vm: "solana", lastBlock: 314, lastSlot: 314, mint: USDC, program: "spl-token", holders: 2 });
    expect(r.checkpointData.rawBalances).toBeUndefined();
    expect(r.tokenAccountOwners.get(ACC(3))).toBe(BOB);
  });

  it("rejects a config whose decimals or program disagree with the mint", async () => {
    const call = async () => ({ value: fixture("usdc-mint.json") });
    const chain = { key: "solana", tokens: [{ address: USDC, decimals: 9 }] };
    await expect(solanaAdapter.tokenMeta(chain, chain.tokens[0], { urls: ["https://x"], call, logger: silent })).rejects.toThrow(/decimals/);
    await expect(
      solanaAdapter.tokenMeta(chain, { address: USDC, program: "token-2022" }, { urls: ["https://x"], call, logger: silent }),
    ).rejects.toThrow(/program/);
  });
});
