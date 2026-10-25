/**
 * Gated forensics are multi-token (docs/MULTI-TOKEN.md "Gated forensics"):
 * every loader sends the active project's slug to the gate, a project with no
 * gated data resolves to null (empty panel), and the forensics views key their
 * queries by slug instead of loading TEL-only data. Wallet-level data stays
 * gate-only: no forensics view reads a public /data or /live-data feed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/lazy", () => ({
  getSupabase: async () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));

const { loadWalletFlows, loadDispositionLedger, loadAssociationFlowReport, loadWalletAnalysis } = await import("@/lib/loadForensics");

let bodies: Array<Record<string, unknown>> = [];
let reply: Record<string, unknown> = {};

beforeEach(() => {
  bodies = [];
  reply = { report: null, project: "demo" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(reply), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("forensics loaders send the project slug", () => {
  it("wallet-flows / ledger / association flows / write-ups carry `project`", async () => {
    await loadWalletFlows("hdg1.a.b", "demo");
    await loadDispositionLedger("hdg1.a.b", "demo");
    await loadAssociationFlowReport("hdg1.a.b", "demo");
    reply = { analysis: null, project: "demo" };
    await loadWalletAnalysis("0x" + "a".repeat(40), "hdg1.a.b", "demo");
    expect(bodies.map((b) => [b.address, b.project])).toEqual([
      ["wallet-flows", "demo"],
      ["disposition-ledger", "demo"],
      ["association-stablecoin-flows", "demo"],
      ["0x" + "a".repeat(40), "demo"],
    ]);
  });

  it("no slug = the old request (gate defaults to TEL)", async () => {
    await loadWalletFlows("hdg1.a.b");
    expect(bodies[0]).not.toHaveProperty("project");
  });

  it("a project with nothing gated resolves to null, not an error", async () => {
    await expect(loadWalletFlows("hdg1.a.b", "demo")).resolves.toBeNull();
    await expect(loadDispositionLedger("hdg1.a.b", "demo")).resolves.toBeNull();
    await expect(loadAssociationFlowReport("hdg1.a.b", "demo")).resolves.toBeNull();
  });

  it("a malformed gate answer (no report field) is still an error", async () => {
    reply = { ok: true };
    await expect(loadWalletFlows("hdg1.a.b", "demo")).rejects.toThrow(/Missing wallet flows report/);
  });
});

describe("forensics views are project-scoped and gate-only", () => {
  const FORENSICS_VIEWS: Array<[file: string, queryKey: RegExp]> = [
    ["src/components/WalletFlowsPanel.tsx", /queryKey:\s*\["wallet-flows",\s*slug\b/],
    ["src/components/TelDispositionLedger.tsx", /queryKey:\s*\["disposition-ledger",\s*slug\b/],
    ["src/components/AssociationFlowAnalysis.tsx", /queryKey:\s*\["flow-report",\s*"association-stablecoin-flows",\s*slug\b/],
    ["src/hooks/useWalletAnalysis.ts", /queryKey:\s*\["wallet-analysis",\s*slug\b/],
  ];
  it.each(FORENSICS_VIEWS)("%s keys its query by project and passes the slug", (file, key) => {
    const src = readFileSync(resolve(process.cwd(), file), "utf8");
    expect(src).toMatch(/useProject\(\)/);
    expect(src).toMatch(key);
    expect(src).toMatch(/load\w+\([^)]*\bslug\)/);
  });

  it.each(FORENSICS_VIEWS.map(([f]) => f).concat(["src/lib/loadForensics.ts", "src/lib/forensicsGateApi.ts"]))(
    "%s never reads a public data root (no /data/, /live-data/, dataUrl, resolveDataUrl)",
    (file) => {
      const code = readFileSync(resolve(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      expect(code).not.toMatch(/["'`/]live-data\/|["'`]\/?data\/|\bdataUrl\(|\bresolveDataUrl\(/);
    },
  );

  it("WalletFlowsPanel has no hardcoded TEL / Telcoin copy (templated per project)", () => {
    const code = readFileSync(resolve(process.cwd(), "src/components/WalletFlowsPanel.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(code.split("\n").filter((l) => /\bTEL\b|Telcoin/.test(l))).toEqual([]);
  });
});

describe("TEL wallet-flows copy renders as before", () => {
  it("templates fill to the original TEL strings", async () => {
    const { projectCopyFor } = await import("@/hooks/useProjectCopy");
    const c = projectCopyFor("tel");
    expect(c.t("{name}-linked wallets")).toBe("Telcoin-linked wallets");
    expect(c.t("{name}-linked {ticker} sent to sell venues")).toBe("Telcoin-linked TEL sent to sell venues");
    expect(c.t("Supply by entity, {name}-linked wallets and their exchange/DEX outflows, and recent large sellers.")).toBe(
      "Supply by entity, Telcoin-linked wallets and their exchange/DEX outflows, and recent large sellers.",
    );
    expect(c.text("walletFlows.locked.supply", "x")).toBe(
      "Supply split by entity: Telcoin treasury, Holdings and Association, escrow, exchanges, DEX pools and retail",
    );
    expect(c.t("Every {name}-linked wallet with address, balance and {ticker} sent to exchanges or DEXs over 72h, 30d and 90d")).toBe(
      "Every Telcoin-linked wallet with address, balance and TEL sent to exchanges or DEXs over 72h, 30d and 90d",
    );
    expect(`${c.entities.associationShort} treasury ledger`).toBe("Association treasury ledger");
  });
});
