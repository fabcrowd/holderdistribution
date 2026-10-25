import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "./forensics-gate.ts";
import { digestsEqual, hashPassword, issueToken, passwordMatches, tokenKey, verifySaltedHash, verifyToken, WindowLimiter, corsHeaders, TOKEN_TTL_SECONDS } from "./gateAuth.ts";
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

describe("forensics gate: session tokens", () => {
  it("a correct password returns a signed ~12h token; the token alone then unlocks", async () => {
    const res = await post({ address: "session-check", password: TEST_PASSWORD });
    expect(res.statusCode).toBe(200);
    const { ok, token, tokenExpiresAt } = JSON.parse(res.body);
    expect(ok).toBe(true);
    expect(token).toMatch(/^hdg1\.[\w-]+\.[\w-]+$/);
    expect(token).not.toContain(TEST_PASSWORD);
    expect(tokenExpiresAt - Date.now()).toBeGreaterThan(11.9 * 3600_000);
    expect(tokenExpiresAt - Date.now()).toBeLessThanOrEqual(12 * 3600_000 + 1000);

    const withToken = await post({ address: "wallet-flows", token });
    expect(withToken.statusCode).toBe(200);
    expect(JSON.parse(withToken.body).report.version).toBe(1);
    // Token-authenticated calls don't mint a fresh token.
    expect(JSON.parse(withToken.body).token).toBeUndefined();
  });

  it("rejects tampered, expired and foreign-key tokens with 401 'Session expired'", async () => {
    const env = { FORENSICS_PASSWORD: TEST_PASSWORD };
    const t = issueToken(env)!.token;
    expect(verifyToken(t, env)).toBe(true);
    expect(verifyToken(t.slice(0, -2) + "xx", env)).toBe(false);
    expect(verifyToken(t, env, Date.now() + TOKEN_TTL_SECONDS * 1000 + 1)).toBe(false);
    expect(verifyToken(t, { FORENSICS_PASSWORD: "rotated" })).toBe(false);
    expect(verifyToken("hdg1.e30.abc", env)).toBe(false);
    const res = await post({ address: "wallet-flows", token: t.slice(0, -2) + "xx" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Session expired" });
  });

  it("derives the key only from server env, never a built-in constant", () => {
    expect(tokenKey({})).toBeNull();
    expect(issueToken({})).toBeNull();
    expect(tokenKey({ FORENSICS_TOKEN_SECRET: "a" })!.equals(tokenKey({ FORENSICS_TOKEN_SECRET: "b" })!)).toBe(false);
  });

  it("FORENSICS_TOKEN_SECRET is optional: the key is derived from whichever gate secret is configured", async () => {
    // Deploy reality: only the password (or its salted hash) is set — no new env var.
    delete process.env.FORENSICS_TOKEN_SECRET;
    const issued = JSON.parse((await post({ address: "session-check", password: TEST_PASSWORD })).body);
    expect(issued.token).toMatch(/^hdg1\./);
    expect((await post({ address: "session-check", token: issued.token })).statusCode).toBe(200);

    const hashOnly = { FORENSICS_PASSWORD_HASH: hashPassword("rotated", { iterations: 20_000 }) };
    const t = issueToken(hashOnly)!.token;
    expect(verifyToken(t, hashOnly)).toBe(true);
    // Key is bound to the source var + value: a different secret can't verify it.
    expect(verifyToken(t, { FORENSICS_PASSWORD_HASH: hashPassword("rotated", { iterations: 20_000 }) })).toBe(false);
    expect(tokenKey({ FORENSICS_PASSWORD: "x" })!.equals(tokenKey({ FORENSICS_TOKEN_SECRET: "x" })!)).toBe(false);
    // Explicit secret wins when present; blank values fall through.
    expect(tokenKey({ FORENSICS_TOKEN_SECRET: "s", FORENSICS_PASSWORD: "p" })!.equals(tokenKey({ FORENSICS_TOKEN_SECRET: "s" })!)).toBe(true);
    expect(tokenKey({ FORENSICS_TOKEN_SECRET: "  ", FORENSICS_PASSWORD: "p" })!.equals(tokenKey({ FORENSICS_PASSWORD: "p" })!)).toBe(true);
    // The derived key is not the raw secret.
    expect(tokenKey({ FORENSICS_PASSWORD: "p" })!.toString("utf8")).not.toContain("p:");
  });

  it("with no server secret at all (in-repo legacy hash only) unlock still works, just without a token", async () => {
    delete process.env.FORENSICS_PASSWORD;
    delete process.env.FORENSICS_TOKEN_SECRET;
    expect(tokenKey(process.env)).toBeNull();
    // Wrong password still 401s; no token is minted from a public constant.
    const res = await post({ address: "session-check", password: "definitely-wrong" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).token).toBeUndefined();
  });

  it("an authenticated batch is not rate limited like anonymous traffic", async () => {
    const ip = "198.51.100.9";
    const { token } = JSON.parse((await post({ address: "session-check", password: TEST_PASSWORD }, { "x-nf-client-connection-ip": ip })).body);
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) codes.push((await post({ address: "session-check", token }, { "x-nf-client-connection-ip": ip })).statusCode);
    expect(codes.every((c) => c === 200)).toBe(true);
    const anon: number[] = [];
    for (let i = 0; i < 25; i++) anon.push((await post({ address: "session-check" }, { "x-nf-client-connection-ip": "198.51.100.10" })).statusCode);
    expect(anon).toContain(429);
  });

  it("429 carries Retry-After", async () => {
    const ip = "198.51.100.11";
    let res = { statusCode: 0, headers: {} as Record<string, string> };
    for (let i = 0; i < 22; i++) res = await post({ address: "session-check" }, { "x-nf-client-connection-ip": ip });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
  });
});

describe("forensics gate: project scoping (multi-token)", () => {
  it("an explicit project=tel returns the same TEL payloads as no project", async () => {
    for (const address of ["wallet-flows", "association-stablecoin-flows", "tel-disposition-ledger"]) {
      const a = JSON.parse((await post({ address, password: TEST_PASSWORD })).body);
      const b = JSON.parse((await post({ address, password: TEST_PASSWORD, project: "tel" })).body);
      expect(b.report).toEqual(a.report);
      expect(b.project).toBe("tel");
    }
  });

  it("the project-neutral disposition-ledger key is the same TEL ledger", async () => {
    const a = JSON.parse((await post({ address: "tel-disposition-ledger", password: TEST_PASSWORD })).body);
    const b = JSON.parse((await post({ address: "disposition-ledger", password: TEST_PASSWORD })).body);
    expect(b.report).toEqual(a.report);
  });

  it("an unregistered project is refused (400) and still needs the password first", async () => {
    expect((await post({ address: "wallet-flows", project: "nope" })).statusCode).toBe(401);
    const res = await post({ address: "wallet-flows", password: TEST_PASSWORD, project: "nope" });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/0x[0-9a-f]{40}/);
    expect((await post({ address: "wallet-flows", password: TEST_PASSWORD, project: "../tel" })).statusCode).toBe(400);
  });
});

describe("walletFlowsSource: per-project paths", () => {
  it("a non-legacy project reads data/<slug>/forensics/ and never falls back to TEL's bundled report", async () => {
    const fake = vi.fn(async () => new Response("missing", { status: 404 }));
    const r = await loadWalletFlows({ LIVE_DATA_GITHUB_TOKEN: "t" }, fake as unknown as typeof fetch, 0, "demo");
    expect(String((fake.mock.calls[0] as unknown[])[0])).toContain("/contents/data/demo/forensics/wallet-flows.json");
    expect(r).toEqual({ report: null, source: "none" });
    __resetWalletFlowsCache();
    expect(await loadWalletFlows({}, fake as unknown as typeof fetch, 0, "demo")).toEqual({ report: null, source: "none" });
  });

  it("caches per project (TEL's cached report is not served for another slug)", async () => {
    const tel = await loadWalletFlows({}, fetch, 0, "tel");
    expect(tel.source).toBe("bundled");
    const demo = await loadWalletFlows({}, fetch, 0, "demo");
    expect(demo.report).toBeNull();
  });
});
