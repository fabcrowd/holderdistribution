import { describe, expect, it } from "vitest";
import { decodeAbiString, decodeUint, detectTokenChains, platformsToChains, probeToken } from "./tokenChains.js";

const enc = (s) => {
  const hex = Buffer.from(s, "utf8").toString("hex");
  return `0x${(32).toString(16).padStart(64, "0")}${s.length.toString(16).padStart(64, "0")}${hex.padEnd(64, "0")}`;
};
const A = "0x467bccd9d29f223bce8043b84e8c8b282827790f";
const B = "0x1111111111111111111111111111111111111111";

/** Stub JSON-RPC: `deployed[chainUrl][address] = symbol`. */
const stubCall = (deployed, { failUrls = [] } = {}) => async (url, method, params) => {
  if (failUrls.includes(url)) throw new Error("timeout");
  const addr = (method === "eth_getCode" ? params[0] : params[0].to).toLowerCase();
  const sym = deployed[url]?.[addr];
  if (method === "eth_getCode") return sym ? "0x6080" : "0x";
  if (params[0].data === "0x95d89b41") return enc(sym);
  return "0x" + (2).toString(16).padStart(64, "0");
};
const urlsFor = (k) => [`rpc://${k}`];

const telLike = {
  ticker: "TEL",
  chains: [
    { key: "ethereum", origin: true, tokens: [{ address: A, status: "canonical" }] },
    { key: "polygon", tokens: [{ address: A, status: "canonical" }] },
  ],
};

describe("tokenChains decoding", () => {
  it("decodes ABI strings, bytes32 symbols and uints", () => {
    expect(decodeAbiString(enc("TEL"))).toBe("TEL");
    expect(decodeAbiString("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0"))).toBe("MKR");
    expect(decodeAbiString("0x")).toBeNull();
    expect(decodeUint("0x" + "2".padStart(64, "0"))).toBe(2);
    expect(decodeUint(null)).toBeNull();
  });

  it("maps CoinGecko platforms to chain keys", () => {
    expect(platformsToChains({ "arbitrum-one": B, "polygon-pos": A, solana: "So1ana", "": "" })).toEqual({ arbitrum: B, polygon: A });
  });
});

describe("probeToken", () => {
  it("falls through a failing RPC to the next", async () => {
    const call = stubCall({ "rpc://b": { [A]: "TEL" } }, { failUrls: ["rpc://a"] });
    expect(await probeToken({ urls: ["rpc://a", "rpc://b"], address: A, call })).toMatchObject({ status: "found", symbol: "TEL", decimals: 2 });
    expect(await probeToken({ urls: ["rpc://a"], address: A, call })).toMatchObject({ status: "rpc-error" });
    expect(await probeToken({ urls: ["rpc://b"], address: B, call })).toMatchObject({ status: "no-code" });
  });
});

describe("detectTokenChains", () => {
  it("skips configured chains and finds a same-address deployment", async () => {
    const call = stubCall({ "rpc://arbitrum": { [A]: "TEL" }, "rpc://bsc": { [A]: "FAKE" } });
    const r = await detectTokenChains({ config: telLike, call, urlsFor });
    const by = Object.fromEntries(r.chains.map((c) => [c.chain, c]));
    expect(by.ethereum.status).toBe("configured");
    expect(by.polygon.status).toBe("configured");
    expect(by.arbitrum).toMatchObject({ status: "candidate", address: A, source: "same-address", symbol: "TEL", chainId: 42161 });
    expect(by.bsc.status).toBe("contract-other-symbol");
    expect(by.base.status).toBe("not-found");
    expect(r.candidates.map((c) => c.chain)).toEqual(["arbitrum"]);
    expect(r.methods).toEqual(["same-address-rpc"]);
  });

  it("with CoinGecko, confirms a bridged copy at a different address on-chain", async () => {
    const fetchImpl = async (url) => {
      expect(url).toContain("/coins/ethereum/contract/");
      return { ok: true, json: async () => ({ platforms: { ethereum: A, "optimistic-ethereum": B } }) };
    };
    const call = stubCall({ "rpc://optimism": { [B]: "TEL" } });
    const r = await detectTokenChains({ config: telLike, call, urlsFor, useCoingecko: true, fetchImpl });
    expect(r.candidates).toEqual([expect.objectContaining({ chain: "optimism", address: B, source: "coingecko" })]);
  });

  it("tolerates a CoinGecko failure (rate limit) and never throws", async () => {
    const fetchImpl = async () => ({ ok: false, status: 429 });
    const r = await detectTokenChains({ config: telLike, call: stubCall({}), urlsFor, useCoingecko: true, fetchImpl });
    expect(r.candidates).toEqual([]);
  });
});
