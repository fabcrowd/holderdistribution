import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "./forensics-gate.ts";
import { digestsEqual, hashPassword, passwordMatches, verifySaltedHash, WindowLimiter, corsHeaders } from "./gateAuth.ts";
import { __resetWalletFlowsCache, loadWalletFlows } from "./walletFlowsSource.ts";

// A throwaway test password supplied via env — never the real one.
const TEST_PASSWORD = "unit-test-password-not-real";
let ipSeq = 0;
const nextIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

type Ev = Parameters<typeof handler>[0];
const post = (body: unknown, headers: Record<string, string> = {}) =>
  handler({
    httpMethod: "POST",
    headers: { "x-nf-client-connection-ip": nextIp(), origin: "https://holderdistribution.com", ...headers },
    body: JSON.stringify(body),
  } as unknown as Ev, {} as never) as Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;

beforeEach(() => {
  process.env.FORENSICS_PASSWORD = TEST_PASSWORD;
  delete process.env.FORENSICS_PASSWORD_HASH;
  delete process.env.FORENSICS_DISABLE_LEGACY_HASH;
  delete process.env.LIVE_DATA_GITHUB_TOKEN;
  __resetWalletFlowsCache();
});
afterEach(() => {
  delete process.env.FORENSICS_PASSWORD;
});

describe("forensics gate: wallet-flows", () => {
  it("401s without a password and returns no data", async () => {
    const res = await post({ address: "wallet-flows" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toMatch(/0x[0-9a-f]{40}/);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("401s with a wrong password", async () => {
    const res = await post({ address: "wallet-flows", password: "nope" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Invalid password" });
  });

  it("returns the report with the right password", async () => {
    const res = await post({ address: "wallet-flows", password: TEST_PASSWORD });
    expect(res.statusCode).toBe(200);
    const { report } = JSON.parse(res.body);
    expect(report.version).toBe(1);
    expect(report.knownWallets.length).toBeGreaterThan(10);
    expect(report.distribution.classes.length).toBeGreaterThan(5);
    expect(Array.isArray(report.largeSellers)).toBe(true);
    expect(res.headers["X-Wallet-Flows-Source"]).toBe("bundled");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://holderdistribution.com");
  });

  it("still serves the existing gated keys (backward compatible)", async () => {
    const ok = await post({ address: "association-stablecoin-flows", password: TEST_PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).report).toBeTruthy();
    const ledger = await post({ address: "tel-disposition-ledger", password: TEST_PASSWORD });
    expect(ledger.statusCode).toBe(200);
  });

  it("rejects foreign browser origins and does not echo them", async () => {
    const res = await post({ address: "wallet-flows", password: TEST_PASSWORD }, { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    const pre = (await handler(
      { httpMethod: "OPTIONS", headers: { origin: "https://evil.example" } } as unknown as Ev,
      {} as never,
    )) as { statusCode: number };
    expect(pre.statusCode).toBe(403);
  });

  it("allows requests with no Origin header (curl) but still needs the password", async () => {
    const res = await post({ address: "wallet-flows" }, { origin: "" });
    expect(res.statusCode).toBe(401);
  });

  it("locks an IP out after 10 failed passwords", async () => {
    const ip = "192.0.2.77";
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await post({ address: "wallet-flows", password: `bad-${i}` }, { "x-nf-client-connection-ip": ip })).statusCode;
    }
    expect(last).toBe(429);
  });

  it("400s without an address and 405s on GET", async () => {
    expect((await post({ password: TEST_PASSWORD })).statusCode).toBe(400);
    const get = (await handler({ httpMethod: "GET", headers: {} } as unknown as Ev, {} as never)) as { statusCode: number };
    expect(get.statusCode).toBe(405);
  });
});

describe("gateAuth", () => {
  it("salted PBKDF2 hash round-trips and rejects other passwords", () => {
    const encoded = hashPassword("s3cret", { iterations: 20_000 });
    expect(encoded.startsWith("pbkdf2-sha256$20000$")).toBe(true);
    expect(verifySaltedHash("s3cret", encoded)).toBe(true);
    expect(verifySaltedHash("s3cret!", encoded)).toBe(false);
    expect(verifySaltedHash("s3cret", "garbage")).toBe(false);
  });

  it("FORENSICS_PASSWORD_HASH unlocks; legacy hash can be disabled", () => {
    const env = { FORENSICS_PASSWORD_HASH: hashPassword("rotated", { iterations: 20_000 }), FORENSICS_DISABLE_LEGACY_HASH: "1" };
    expect(passwordMatches("rotated", env)).toBe(true);
    expect(passwordMatches("other", env)).toBe(false);
    expect(passwordMatches(undefined, env)).toBe(false);
    expect(passwordMatches("x".repeat(300), { FORENSICS_PASSWORD: "x".repeat(300) })).toBe(false);
  });

  it("digest compare handles length mismatch", () => {
    expect(digestsEqual(Buffer.from("aa", "hex"), Buffer.from("aabb", "hex"))).toBe(false);
  });

  it("window limiter blocks over the limit and resets", () => {
    const l = new WindowLimiter(2, 1000);
    expect(l.hit("a", 0).allowed).toBe(true);
    expect(l.hit("a", 1).allowed).toBe(true);
    expect(l.hit("a", 2).allowed).toBe(false);
    expect(l.hit("a", 2000).allowed).toBe(true);
  });

  it("CORS allows Netlify's own URLs and localhost only in dev", () => {
    expect(corsHeaders("https://site.netlify.app", { URL: "https://site.netlify.app" })["Access-Control-Allow-Origin"]).toBe(
      "https://site.netlify.app",
    );
    expect(corsHeaders("http://localhost:8888", {})["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders("http://localhost:8888", { NETLIFY_DEV: "true" })["Access-Control-Allow-Origin"]).toBe("http://localhost:8888");
  });
});

describe("walletFlowsSource", () => {
  it("prefers a newer GitHub copy when the token is set, else bundled", async () => {
    const fake = vi.fn(async () =>
      new Response(JSON.stringify({ version: 1, generated: "2999-01-01T00:00:00Z", knownWallets: [] }), { status: 200 }),
    );
    const gh = await loadWalletFlows({ LIVE_DATA_GITHUB_TOKEN: "t" }, fake as unknown as typeof fetch, 0);
    expect(gh.source).toBe("github");
    expect(String((fake.mock.calls[0] as unknown[])[0])).toContain("/contents/data/forensics/wallet-flows.json");
    __resetWalletFlowsCache();
    const down = vi.fn(async () => new Response("nope", { status: 500 }));
    expect((await loadWalletFlows({ LIVE_DATA_GITHUB_TOKEN: "t" }, down as unknown as typeof fetch, 0)).source).toBe("bundled");
    __resetWalletFlowsCache();
    expect((await loadWalletFlows({}, down as unknown as typeof fetch, 0)).source).toBe("bundled");
    expect(down).toHaveBeenCalledTimes(1);
  });
});
