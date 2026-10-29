import { describe, expect, it, vi } from "vitest";
import { COINGECKO_CIRCULATING } from "./reconcileSupply.js";
import { coingeckoIdFor, fetchCoingeckoCirculating, resolveCoingeckoCirculating } from "./coingeckoCirculating.js";

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

const fetchImpl = (body, opts) => vi.fn(async () => jsonResponse(body, opts));

describe("coingeckoIdFor", () => {
  it("prefers supply.coingeckoId, then the wallet-flows id", () => {
    expect(coingeckoIdFor({ config: { supply: { coingeckoId: " zebec-network " }, gated: { walletFlows: { coingeckoId: "other" } } } })).toBe("zebec-network");
    expect(coingeckoIdFor({ config: { gated: { walletFlows: { coingeckoId: "telcoin" } } } })).toBe("telcoin");
    expect(coingeckoIdFor({ config: { supply: { coingeckoId: "" }, gated: { walletFlows: { coingeckoId: "telcoin" } } } })).toBe("telcoin");
    expect(coingeckoIdFor({ config: {} })).toBeNull();
  });
});

describe("fetchCoingeckoCirculating", () => {
  it("reads market_data.circulating_supply for that coin id", async () => {
    const fetch = fetchImpl({ market_data: { circulating_supply: 99_998_768_619.091 } });
    await expect(fetchCoingeckoCirculating("zebec-network", { fetchImpl: fetch })).resolves.toBe(99_998_768_619.091);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("/coins/zebec-network?");
    expect(String(fetch.mock.calls[0][0])).not.toContain("telcoin");
  });

  it("treats 0 and a missing field as no figure", async () => {
    await expect(fetchCoingeckoCirculating("telcoin", { fetchImpl: fetchImpl({ market_data: { circulating_supply: 0 } }) })).resolves.toBeNull();
    await expect(fetchCoingeckoCirculating("telcoin", { fetchImpl: fetchImpl({ market_data: {} }) })).resolves.toBeNull();
  });

  it("throws on a non-OK response", async () => {
    await expect(fetchCoingeckoCirculating("zebec-network", { fetchImpl: fetchImpl({}, { ok: false, status: 429 }) })).rejects.toThrow(/HTTP 429/);
  });
});

describe("resolveCoingeckoCirculating", () => {
  it("publishes the live figure for the project's own id", async () => {
    const project = { slug: "zebec-network", config: { supply: { coingeckoId: "zebec-network" } } };
    const fetch = fetchImpl({ market_data: { circulating_supply: 99_998_768_619.091 } });
    await expect(resolveCoingeckoCirculating(project, { fetchImpl: fetch })).resolves.toBe(99_998_768_619.091);
  });

  it("hides the comparison when a non-TEL project has no positive read", async () => {
    const project = { slug: "zebec-network", config: { supply: { coingeckoId: "zebec-network" } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveCoingeckoCirculating(project, { fetchImpl: fetchImpl({ market_data: { circulating_supply: 0 } }) })).resolves.toBeNull();
    await expect(resolveCoingeckoCirculating(project, { fetchImpl: fetchImpl({}, { ok: false, status: 503 }) })).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(String(COINGECKO_CIRCULATING)));
    warn.mockRestore();
  });

  it("keeps the traced snapshot only for a project that opts in when the live read is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tel = { slug: "tel", config: { supply: { coingeckoId: "telcoin", coingeckoSnapshotFallback: true } } };
    await expect(resolveCoingeckoCirculating(tel, { fetchImpl: fetchImpl({ market_data: { circulating_supply: 0 } }) })).resolves.toBe(COINGECKO_CIRCULATING);
    await expect(resolveCoingeckoCirculating(tel, { fetchImpl: fetchImpl({}, { ok: false, status: 429 }) })).resolves.toBe(COINGECKO_CIRCULATING);
    // A live positive read replaces the snapshot. Another slug never receives it.
    await expect(resolveCoingeckoCirculating(tel, { fetchImpl: fetchImpl({ market_data: { circulating_supply: 95_100_000_000 } }) })).resolves.toBe(95_100_000_000);
    const other = { slug: "demo", config: { supply: { coingeckoId: "telcoin" }, data: { legacyRoot: true } } };
    await expect(resolveCoingeckoCirculating(other, { fetchImpl: fetchImpl({ market_data: { circulating_supply: 0 } }) })).resolves.toBeNull();
    warn.mockRestore();
  });

  it("does not fetch or invent a figure when the project has no coin id", async () => {
    const fetch = vi.fn();
    await expect(resolveCoingeckoCirculating({ slug: "tel", config: {} }, { fetchImpl: fetch })).resolves.toBeNull();
    await expect(resolveCoingeckoCirculating({ slug: "zebec-network", config: { supply: {} } }, { fetchImpl: fetch })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
