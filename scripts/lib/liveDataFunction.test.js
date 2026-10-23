import { describe, it, expect, vi } from "vitest";
import { handleLiveData, LIVE_DATA_FILES, slimCheckpoint, config } from "../../netlify/functions/live-data.mjs";

const req = (file) => new Request(`https://holderdistribution.com/live-data/${file}`);
const ok = (body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });

describe("live-data Netlify function", () => {
  it("is mounted at /live-data/*", () => {
    expect(config.path).toBe("/live-data/*");
  });

  it("covers every feed the frontend fetches", () => {
    for (const f of ["holders-lite.json", "holders-history.json", "supply-reconciliation.json", "holders-checkpoint.json", "tier-outflows.json"]) {
      expect(LIVE_DATA_FILES.has(f)).toBe(true);
    }
  });

  it("404s anything outside the allowlist (no path traversal, no 30 MB pipeline files)", async () => {
    const fetchImpl = vi.fn();
    for (const f of ["tel-holders.json", "..%2F..%2F.env.enc", "../package.json"]) {
      const res = await handleLiveData(req(f), { LIVE_DATA_GITHUB_TOKEN: "t" }, fetchImpl);
      expect(res.status).toBe(404);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to the deployed static copy when no token is configured", async () => {
    const fetchImpl = vi.fn();
    const res = await handleLiveData(req("holders-lite.json"), {}, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/data/holders-lite.json");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves the latest committed copy from GitHub with CDN caching", async () => {
    const fetchImpl = vi.fn(async () => ok({ generatedAt: "2026-10-19T00:30:00Z" }));
    const res = await handleLiveData(req("holders-lite.json"), { LIVE_DATA_GITHUB_TOKEN: "secret" }, fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generatedAt: "2026-10-19T00:30:00Z" });
    expect(res.headers.get("Netlify-CDN-Cache-Control")).toMatch(/durable/);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/fabcrowd/holderdistribution/contents/public/data/holders-lite.json?ref=main");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(init.headers.Accept).toBe("application/vnd.github.raw+json");
  });

  it("falls back on upstream errors, timeouts and non-JSON bodies", async () => {
    const env = { LIVE_DATA_GITHUB_TOKEN: "t" };
    for (const fetchImpl of [
      vi.fn(async () => new Response("nope", { status: 401 })),
      vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }),
      vi.fn(async () => ok("<html>rate limited</html>")),
    ]) {
      const res = await handleLiveData(req("holders-history.json"), env, fetchImpl);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/data/holders-history.json");
    }
  });

  it("strips per-address balances from holders-checkpoint.json", async () => {
    const checkpoint = { generatedAt: "g", chains: { ethereum: { lastBlock: 5, rawBalances: { "0xa": "1" } } } };
    const fetchImpl = vi.fn(async () => ok(checkpoint));
    const res = await handleLiveData(req("holders-checkpoint.json"), { LIVE_DATA_GITHUB_TOKEN: "t" }, fetchImpl);
    expect(await res.json()).toEqual({ generatedAt: "g", chains: { ethereum: { lastBlock: 5 } } });
    expect(slimCheckpoint({})).toEqual({});
  });

  it("strips nested balance maps too (v3, v3Staking)", () => {
    const cp = {
      generatedAt: "g",
      chains: {
        ethereum: { lastBlock: 5, fromBlock: 1, rawBalances: { "0xa": "1" }, v3: { rawBalances: { "0xb": "2" } } },
        polygon: { lastBlock: 7, v3Staking: { "0x57": { rawBalances: { "0xc": "3" } } } },
      },
    };
    const out = slimCheckpoint(cp);
    expect(out).toEqual({ generatedAt: "g", chains: { ethereum: { lastBlock: 5, fromBlock: 1 }, polygon: { lastBlock: 7 } } });
    expect(JSON.stringify(out)).not.toMatch(/0x[abc]"/);
  });

  it("serves chain-status.json", () => {
    expect(LIVE_DATA_FILES.has("chain-status.json")).toBe(true);
  });
});
