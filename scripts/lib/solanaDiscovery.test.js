import { describe, expect, it, vi } from "vitest";
import { coingeckoPlatforms, detectTokenChains, platformsToChains, solanaPlatformAddress } from "./tokenChains.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const PLATFORMS = { ethereum: ETH, solana: MINT, sui: "0xdba3::usdc::USDC" };
const fetchOk = (body) => vi.fn(async () => ({ ok: true, json: async () => body }));
const noRpc = async () => { throw new Error("no rpc in tests"); };

describe("Solana discovery (advisory, never writes config)", () => {
  it("keeps the Solana mint's case; EVM platform mapping is unchanged", () => {
    expect(solanaPlatformAddress(PLATFORMS)).toBe(MINT);
    expect(solanaPlatformAddress({ solana: "So1ana" })).toBe(null);
    expect(platformsToChains(PLATFORMS)).toEqual({ ethereum: ETH });
  });

  it("does not lowercase a base58 address in the CoinGecko URL", async () => {
    const fetchImpl = fetchOk({ platforms: PLATFORMS });
    await coingeckoPlatforms({ platform: "solana", address: MINT, fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.coingecko.com/api/v3/coins/solana/contract/${MINT}`);
    await coingeckoPlatforms({ platform: "ethereum", address: ETH.toUpperCase().replace("0X", "0x"), fetchImpl });
    expect(fetchImpl.mock.calls[1][0]).toMatch(/contract\/0xa0b8/);
  });

  it("reports a CoinGecko-listed Solana mint as a candidate with a bridge suggestion", async () => {
    const config = Object.freeze({ ticker: "USDC", chains: Object.freeze([Object.freeze({ key: "ethereum", origin: true, tokens: [{ address: ETH, status: "canonical" }] })]) });
    const before = JSON.stringify(config);
    const solanaProbe = vi.fn(async () => ({ status: "found", symbol: "USDC", decimals: 6, program: "spl-token" }));
    const r = await detectTokenChains({
      config, call: noRpc, urlsFor: () => [], useCoingecko: true, fetchImpl: fetchOk({ platforms: PLATFORMS }), solanaProbe,
      candidates: [{ key: "ethereum", name: "Ethereum", chainId: 1, explorer: "https://etherscan.io", coingecko: "ethereum" }],
    });
    expect(solanaProbe).toHaveBeenCalledWith(MINT);
    expect(r.candidates).toEqual([
      expect.objectContaining({
        chain: "solana", vm: "solana", address: MINT, status: "candidate", source: "coingecko",
        suggestedBridge: "native", bridgeNeedsConfirmation: true, program: "spl-token",
        explorer: `https://solscan.io/token/${MINT}`,
      }),
    ]);
    expect(JSON.stringify(config)).toBe(before);
  });

  it("no Solana row unless CoinGecko lists one or the project has one", async () => {
    const config = { ticker: "X", chains: [{ key: "ethereum", origin: true, tokens: [{ address: ETH }] }] };
    const r = await detectTokenChains({ config, call: noRpc, urlsFor: () => [], candidates: [] });
    expect(r.chains).toEqual([]);
    const sol = await detectTokenChains({
      config: { ticker: "X", chains: [{ key: "solana", vm: "solana", origin: true, tokens: [{ address: MINT }] }] },
      call: noRpc, urlsFor: () => [], candidates: [],
    });
    expect(sol.chains).toEqual([{ chain: "solana", name: "Solana", vm: "solana", status: "configured" }]);
  });

  it("a Solana-origin project looks up CoinGecko by its mint and never EVM-probes base58", async () => {
    const fetchImpl = fetchOk({ platforms: PLATFORMS });
    const call = vi.fn(noRpc);
    const r = await detectTokenChains({
      config: { ticker: "USDC", chains: [{ key: "solana", vm: "solana", origin: true, tokens: [{ address: MINT }] }] },
      call,
      urlsFor: () => ["https://rpc"],
      useCoingecko: true,
      fetchImpl,
      candidates: [{ key: "ethereum", name: "Ethereum", chainId: 1, explorer: "https://etherscan.io", coingecko: "ethereum" }],
    });
    expect(fetchImpl.mock.calls[0][0]).toContain(`/coins/solana/contract/${MINT}`);
    // The EVM probe only ever sees the hex address CoinGecko listed.
    for (const c of call.mock.calls) expect(JSON.stringify(c)).not.toContain(MINT);
    expect(r.chains.find((c) => c.chain === "ethereum").status).toBe("rpc-error");
  });
});
