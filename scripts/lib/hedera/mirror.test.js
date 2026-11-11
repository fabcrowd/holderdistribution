import { describe, expect, it, vi } from "vitest";
import { createMirrorClient, HEDERA_MAX_RPS, parseExactJson } from "./mirror.js";

const BASE = "https://mirror.test/api/v1";
const ok = (text) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => text });
const bad = (status, retryAfter = null) => ({
  ok: false,
  status,
  headers: { get: (h) => (h.toLowerCase() === "retry-after" ? retryAfter : null) },
  text: async () => "{}",
});
const base = { baseUrl: BASE, now: () => 0, maxRps: 1000 };

describe("hedera mirror client", () => {
  it("stays below the documented 50 requests/second per IP", () => {
    expect(HEDERA_MAX_RPS).toBeGreaterThan(0);
    expect(HEDERA_MAX_RPS).toBeLessThan(50);
  });

  it("keeps integers above 2^53 exact", () => {
    const text = '{"balance":21706344069277118,"total_supply":5000000000000000000,"tokens":[{"token_id":"0.0.1","balance":47095266949}],"x":12}';
    expect(String(JSON.parse(text).balance)).not.toBe("21706344069277118");
    const parsed = parseExactJson(text);
    expect(parsed.balance).toBe("21706344069277118");
    expect(BigInt(parsed.total_supply)).toBe(5_000_000_000_000_000_000n);
    expect(parsed.x).toBe(12);
    const transfer = parseExactJson('{"transfers":[{"account":"0.0.2","amount":-5000000000000000001}]}');
    expect(transfer.transfers[0].amount).toBe("-5000000000000000001");
  });

  it("spaces request starts by the rate limit", async () => {
    const waits = [];
    const fetch = vi.fn(async () => ok("{}"));
    const client = createMirrorClient({ baseUrl: BASE, fetch, now: () => 0, sleep: async (ms) => void waits.push(ms), maxRps: 10 });
    await Promise.all([client.getJson("/a"), client.getJson("/b"), client.getJson("/c"), client.getJson("/d")]);
    expect(waits).toEqual([100, 200, 300]); // starts at 0, 100, 200, 300 ms: never bunched
  });

  it("retries 429/5xx/network errors with backoff, then succeeds", async () => {
    const seq = [bad(500), bad(429, "2"), "net", ok('{"a":1}')];
    const sleeps = [];
    const fetch = async () => {
      const r = seq.shift();
      if (r === "net") throw new TypeError("fetch failed");
      return r;
    };
    const client = createMirrorClient({ ...base, fetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
    await expect(client.getJson("/x")).resolves.toEqual({ a: 1 });
    expect(seq).toHaveLength(0);
    expect(sleeps.some((ms) => ms >= 2000)).toBe(true); // Retry-After honoured
  });

  it("throws after the attempt budget and never returns partial data", async () => {
    const fetch = vi.fn(async () => bad(503));
    const client = createMirrorClient({ ...base, fetch, sleep: async () => {}, maxAttempts: 4 });
    await expect(client.getJson("/x")).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry a 404 and treats a truncated body as retryable", async () => {
    const f404 = vi.fn(async () => bad(404));
    await expect(createMirrorClient({ ...base, fetch: f404, sleep: async () => {} }).getJson("/x")).rejects.toThrow(/404/);
    expect(f404).toHaveBeenCalledTimes(1);
    const seq = [ok('{"a":'), ok('{"a":2}')];
    const client = createMirrorClient({ ...base, fetch: async () => seq.shift(), sleep: async () => {} });
    await expect(client.getJson("/x")).resolves.toEqual({ a: 2 });
  });
});

describe("hedera mirror client: timeouts and shared back-off", () => {
  it("treats a stalled request as a retryable failure", async () => {
    const seq = [() => new Promise(() => {}), () => Promise.resolve(ok('{"a":1}'))];
    const client = createMirrorClient({ ...base, fetch: () => seq.shift()(), sleep: async () => {}, timeoutMs: 5 });
    await expect(client.getJson("/x")).resolves.toEqual({ a: 1 });
  });

  it("treats a stalled body read as a retryable failure and gives up after the budget", async () => {
    const stalled = { ok: true, status: 200, headers: { get: () => null }, text: () => new Promise(() => {}) };
    const fetch = vi.fn(async () => stalled);
    const client = createMirrorClient({ ...base, fetch, sleep: async () => {}, timeoutMs: 5, maxAttempts: 2 });
    await expect(client.getJson("/x")).rejects.toThrow(/timed out/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("passes an abort signal to every request", async () => {
    const fetch = vi.fn(async () => ok("{}"));
    await createMirrorClient({ ...base, fetch, sleep: async () => {} }).getJson("/x");
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("waits exactly Retry-After on a 429 (jitter off)", async () => {
    let now = 0;
    const seq = [bad(429, "2"), ok("{}")];
    const sleeps = [];
    const sleep = async (ms) => void (sleeps.push(ms), (now += ms));
    const client = createMirrorClient({ baseUrl: BASE, fetch: async () => seq.shift(), now: () => now, sleep, maxRps: 1000, random: () => 0 });
    await client.getJson("/x");
    expect(sleeps).toEqual([2000]);
  });

  it("a 429 holds back every lane, not just the one that was throttled", async () => {
    let now = 0;
    const starts = [];
    let other = null;
    let launched = false;
    const seq = [bad(429, "2"), ok("{}"), ok("{}")];
    const fetch = async (url) => (starts.push([url.slice(-6), now]), seq.shift());
    const sleep = async (ms) => {
      if (ms === 2000 && !launched) {
        launched = true;
        other = client.getJson("/other"); // a second lane starts while the first backs off
        await new Promise((resolve) => setImmediate(resolve)); // let it run before this lane's wait elapses
      }
      now += ms;
    };
    const client = createMirrorClient({ baseUrl: BASE, fetch, now: () => now, sleep, maxRps: 1000, random: () => 0 });
    await client.getJson("/x");
    await other;
    const otherStart = starts.find(([u]) => u === "/other")[1];
    expect(otherStart).toBeGreaterThanOrEqual(2000);
  });
});
