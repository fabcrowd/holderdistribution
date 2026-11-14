import { describe, expect, it, vi } from "vitest";
import { fetchNetworkStake, networkStakeFromBody, parseNetworkStakeBody, tinybarToHbarText } from "./networkStake.js";

// Shape and values of GET /api/v1/network/stake on mainnet (read 2026-11-13), unrelated fields kept as served.
const BODY_TEXT =
  '{"max_stake_rewarded":650000000000000000,"node_reward_fee_fraction":0.1,"stake_total":1345671185300000001,' +
  '"staking_period":{"from":"1794528000.000000000","to":"1794614400.000000000"},"staking_period_duration":1440}';
const ok = (text) => ({ ok: true, status: 200, text: async () => text });
const bad = (status) => ({ ok: false, status, text: async () => "{}" });
const noSleep = vi.fn(async () => {});

describe("stake_total parsing", () => {
  it("keeps a tinybar total above 2^53 exact", () => {
    expect(BigInt(Number("1345671185300000001")).toString()).not.toBe("1345671185300000001"); // a float round trip drifts
    expect(parseNetworkStakeBody(BODY_TEXT).stake_total).toBe("1345671185300000001");
  });

  it("formats exact HBAR text with 8 decimals", () => {
    expect(tinybarToHbarText(1345671185300000001n)).toBe("13456711853.00000001");
    expect(tinybarToHbarText(5n)).toBe("0.00000005");
  });
});

describe("networkStakeFromBody", () => {
  it("returns the staked HBAR with its own staking period as ISO", () => {
    const r = networkStakeFromBody(parseNetworkStakeBody(BODY_TEXT));
    expect(r).toEqual({
      available: true,
      stakedTotal: 13456711853.00000001,
      stakedTotalTinybar: "1345671185300000001",
      stakedTotalHbar: "13456711853.00000001",
      decimals: 8,
      stakingPeriod: { start: "2026-11-13T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" },
      source: "mirror node /network/stake",
    });
  });

  it.each([
    ["no stake_total", {}],
    ["a numeric stake_total (the body was not read exactly)", { stake_total: 1.3e18, staking_period: { from: "1.0", to: "2.0" } }],
    ["a zero total (never published as data)", { stake_total: "0", staking_period: { from: "1.0", to: "2.0" } }],
    ["no staking period", { stake_total: "100000000" }],
    ["a malformed period stamp", { stake_total: "100000000", staking_period: { from: "x", to: "2.0" } }],
    ["a period that ends before it starts", { stake_total: "100000000", staking_period: { from: "9.0", to: "2.0" } }],
  ])("is explicitly unavailable for %s", (_label, body) => {
    const r = networkStakeFromBody(body);
    expect(r.available).toBe(false);
    expect(r.reason).toEqual(expect.any(String));
    expect(r).not.toHaveProperty("stakedTotal");
  });
});

describe("fetchNetworkStake", () => {
  it("requests the configured mirror's /network/stake once", async () => {
    const fetch = vi.fn(async () => ok(BODY_TEXT));
    const r = await fetchNetworkStake({ mirrorUrl: "https://mirror.test/api/v1/" }, { fetch, sleep: noSleep });
    expect(r.available).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://mirror.test/api/v1/network/stake");
  });

  it("retries a 503 then succeeds", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(bad(503)).mockResolvedValueOnce(ok(BODY_TEXT));
    const r = await fetchNetworkStake({ mirrorUrl: "https://mirror.test/api/v1" }, { fetch, sleep: noSleep });
    expect(r.available).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives an unavailable result, never a throw or a zero, after repeated failures", async () => {
    const fetch = vi.fn(async () => bad(503));
    const r = await fetchNetworkStake({ mirrorUrl: "https://mirror.test/api/v1" }, { fetch, sleep: noSleep, attempts: 3 });
    expect(r).toMatchObject({ available: false, reason: expect.stringContaining("HTTP 503") });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a client error", async () => {
    const fetch = vi.fn(async () => bad(404));
    const r = await fetchNetworkStake({ mirrorUrl: "https://mirror.test/api/v1" }, { fetch, sleep: noSleep });
    expect(r.available).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a network error and an unreadable body as unavailable", async () => {
    const net = await fetchNetworkStake({ mirrorUrl: "https://m.test" }, { fetch: async () => { throw new Error("socket hang up"); }, sleep: noSleep, attempts: 1 });
    expect(net).toMatchObject({ available: false, reason: expect.stringContaining("socket hang up") });
    const junk = await fetchNetworkStake({ mirrorUrl: "https://m.test" }, { fetch: async () => ok("<html>"), sleep: noSleep, attempts: 1 });
    expect(junk.available).toBe(false);
  });
});
