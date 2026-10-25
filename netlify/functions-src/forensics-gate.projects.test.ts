/**
 * Gate behaviour with a second registered project (registry mocked): the same
 * keys answer for every project, a project with nothing gated gets null
 * payloads, and TEL's write-ups / ledger / report never leak into it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/projects.json", () => ({
  default: { projects: [{ slug: "tel", name: "Telcoin", ticker: "TEL", default: true }, { slug: "demo", name: "Demo", ticker: "DMO" }] },
}));

const { handler } = await import("./forensics-gate.ts");
const { __resetWalletFlowsCache } = await import("./walletFlowsSource.ts");
const { resolveGatedProject, walletFlowsRepoPath, DEFAULT_GATED_PROJECT } = await import("./gatedProjects.ts");

const PW = "unit-test-password-not-real";
let ip = 0;
type Ev = Parameters<typeof handler>[0];
const post = async (body: unknown) => {
  const res = (await handler(
    {
      httpMethod: "POST",
      headers: { "x-nf-client-connection-ip": `10.9.0.${++ip}`, origin: "https://holderdistribution.com" },
      body: JSON.stringify(body),
    } as unknown as Ev,
    {} as never,
  )) as { statusCode: number; headers: Record<string, string>; body: string };
  return { ...res, json: JSON.parse(res.body) };
};

beforeEach(() => {
  process.env.FORENSICS_PASSWORD = PW;
  delete process.env.LIVE_DATA_GITHUB_TOKEN;
  __resetWalletFlowsCache();
});

describe("gatedProjects", () => {
  it("accepts registered slugs, defaults to TEL, refuses anything else", () => {
    expect(DEFAULT_GATED_PROJECT).toBe("tel");
    expect(resolveGatedProject(undefined)).toBe("tel");
    expect(resolveGatedProject("DEMO")).toBe("demo");
    expect(resolveGatedProject("other")).toBeNull();
    expect(resolveGatedProject(42)).toBeNull();
    expect(walletFlowsRepoPath("tel")).toBe("data/forensics/wallet-flows.json");
    expect(walletFlowsRepoPath("demo")).toBe("data/demo/forensics/wallet-flows.json");
  });
});

describe("forensics gate for a non-TEL project", () => {
  it("still requires the password (401, no data)", async () => {
    const res = await post({ address: "wallet-flows", project: "demo" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toMatch(/0x[0-9a-f]{40}/);
  });

  it("answers every gated key with null — never TEL's data", async () => {
    const wf = await post({ address: "wallet-flows", password: PW, project: "demo" });
    expect(wf.statusCode).toBe(200);
    expect(wf.json).toMatchObject({ report: null, project: "demo" });
    expect(wf.headers["X-Wallet-Flows-Source"]).toBe("none");
    for (const address of ["association-stablecoin-flows", "disposition-ledger", "tel-disposition-ledger"]) {
      const r = await post({ address, password: PW, project: "demo" });
      expect(r.statusCode).toBe(200);
      expect(r.json.report).toBeNull();
    }
    // A wallet TEL has a write-up for returns nothing under demo, but does under TEL.
    const { WALLET_ANALYSES } = await import("../../src/data/forensicsWriteups.ts");
    const telWallet = Object.keys(WALLET_ANALYSES)[0];
    expect((await post({ address: telWallet, password: PW, project: "demo" })).json.analysis).toBeNull();
    expect((await post({ address: telWallet, password: PW, project: "tel" })).json.analysis).toBeTruthy();
  });

  it("TEL keeps its bundled report next to demo", async () => {
    const tel = await post({ address: "wallet-flows", password: PW, project: "tel" });
    expect(tel.json.report.knownWallets.length).toBeGreaterThan(10);
    expect(tel.headers["X-Wallet-Flows-Source"]).toBe("bundled");
  });
});
