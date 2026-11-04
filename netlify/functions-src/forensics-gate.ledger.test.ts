/** Gate keys "project-ledger" / "bot-proceeds": password-gated, per project, repo-only, never cross-project. */
import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "./forensics-gate.ts";
import { __resetLedgerCache, loadLedgerFile } from "./ledgerSource.ts";
import { ledgerRepoPath } from "./gatedProjects.ts";

const PW = "unit-test-password-not-real";
let ip = 0;
type Ev = Parameters<typeof handler>[0];
const post = async (body: unknown) => {
  const res = (await handler(
    { httpMethod: "POST", headers: { "x-nf-client-connection-ip": `10.8.0.${++ip}`, origin: "https://holderdistribution.com" }, body: JSON.stringify(body) } as unknown as Ev,
    {} as never,
  )) as { statusCode: number; headers: Record<string, string>; body: string };
  return { ...res, json: JSON.parse(res.body) };
};
const ok = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

beforeEach(() => {
  process.env.FORENSICS_PASSWORD = PW;
  delete process.env.LIVE_DATA_GITHUB_TOKEN;
  __resetLedgerCache();
});

describe("ledger gate keys", () => {
  it("paths are per project under data/<slug>/ledger", () => {
    expect(ledgerRepoPath("tel", "ledger.json")).toBe("data/tel/ledger/ledger.json");
    expect(ledgerRepoPath("zebec-network", "bot-proceeds.json")).toBe("data/zebec-network/ledger/bot-proceeds.json");
  });

  it("requires the password", async () => {
    for (const address of ["project-ledger", "bot-proceeds"]) expect((await post({ address, project: "tel" })).statusCode).toBe(401);
  });

  it("answers null with source none when no token is configured", async () => {
    const r = await post({ address: "project-ledger", password: PW, project: "zebec-network" });
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ report: null, project: "zebec-network" });
    expect(r.headers["X-Ledger-Source"]).toBe("none");
  });

  it("loads from the repo with a token, and rejects another project's file", async () => {
    const env = { LIVE_DATA_GITHUB_TOKEN: "t" };
    let url = "";
    const f = (async (u: string) => {
      url = u;
      return { ok: true, json: async () => ({ version: 1, slug: "tel", generated: "2026-11-01T00:00:00Z" }) };
    }) as unknown as typeof fetch;
    expect((await loadLedgerFile("tel", "ledger.json", env, f, 0)).source).toBe("github");
    expect(url).toContain("/contents/data/tel/ledger/ledger.json?ref=main");
    expect((await loadLedgerFile("zebec-network", "ledger.json", env, ok({ version: 1, slug: "tel" }), 0)).report).toBeNull();
    expect((await loadLedgerFile("zebec-network", "bot-proceeds.json", env, ok({ version: 2, slug: "zebec-network" }), 0)).report).toBeNull();
  });

  it("caches per project and file for an hour", async () => {
    const env = { LIVE_DATA_GITHUB_TOKEN: "t" };
    let n = 0;
    const f = (async () => (n++, { ok: true, json: async () => ({ version: 1, slug: "tel" }) })) as unknown as typeof fetch;
    await loadLedgerFile("tel", "ledger.json", env, f, 0);
    await loadLedgerFile("tel", "ledger.json", env, f, 1000);
    await loadLedgerFile("tel", "bot-proceeds.json", env, f, 1000);
    expect(n).toBe(2);
    await loadLedgerFile("tel", "ledger.json", env, f, 61 * 60 * 1000);
    expect(n).toBe(3);
  });

  it("survives a fetch failure", async () => {
    const f = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await loadLedgerFile("tel", "ledger.json", { LIVE_DATA_GITHUB_TOKEN: "t" }, f, 0)).toEqual({ report: null, source: "none" });
  });
});
