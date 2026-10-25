/**
 * Multi-token gated forensics (docs/MULTI-TOKEN.md "Gated forensics"):
 *   - TEL's wallet-flows inputs/outputs are exactly the pre-multi-token files;
 *   - any other project resolves under data/<slug>/forensics/ and its own
 *     public/data/<slug>/ reconciliation, with its own addresses only;
 *   - the gate function's legacy-root list matches the project configs;
 *   - nothing gated is ever placed under public/.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { legacyRootSlugs, resolveProject } from "./projects.js";
import { BRIDGE_INFRA } from "./telEndpoint.js";
import { TEL_LOG_SPAN, tokenSlots, walletFlowsNotes, walletFlowsPlan } from "./walletFlowsProject.js";

const repo = path.resolve(".");
const X = (c) => `0x${c.repeat(40)}`;
let tmp;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-wf-"));
  const w = (rel, obj) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), JSON.stringify(obj));
  };
  w("config/projects.json", { projects: [
    { slug: "tel", name: "Telcoin", ticker: "TEL", default: true },
    { slug: "demo", name: "Demo", ticker: "DMO" },
  ] });
  w("config/projects/tel.json", { slug: "tel", name: "Telcoin", ticker: "TEL", data: { legacyRoot: true }, chains: [] });
  w("config/projects/demo.json", {
    slug: "demo", name: "Demo", ticker: "DMO", supply: { target: 1_000_000 },
    chains: [{ key: "arbitrum", name: "Arbitrum", chainId: 42161, explorer: "https://arbiscan.io",
      tokens: [{ generation: "v1", address: X("b"), decimals: 6, deployBlock: 77 }] }],
    classification: { cexWallets: "config/projects/demo/cex-wallets.json" },
    gated: { forensics: true, walletFlows: { coingeckoId: "demo-coin", bridgeAddresses: [X("C")] } },
  });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("walletFlowsPlan", () => {
  it("TEL resolves to the original files, chains, price id and bridge set", () => {
    const plan = walletFlowsPlan(resolveProject("tel", repo), { root: repo });
    expect(path.relative(repo, plan.out)).toBe("data/forensics/wallet-flows.json");
    expect(path.relative(repo, plan.registry)).toBe("data/forensics/wallet-flows.registry.json");
    expect(path.relative(repo, plan.recon)).toBe("public/data/supply-reconciliation.json");
    expect(path.relative(repo, plan.cexPath)).toBe("config/cex-wallets.json");
    expect(path.relative(repo, plan.dexPath)).toBe("config/dex-contracts.json");
    expect(plan.chains).toEqual(["ethereum", "polygon", "base"]);
    expect(plan.coingeckoId).toBe("telcoin");
    expect(new Set(plan.bridgeAddresses)).toEqual(BRIDGE_INFRA);
    for (const c of plan.chains) expect(plan.logSpan(c)).toBe(TEL_LOG_SPAN[c]);
    expect(walletFlowsNotes(plan)[0]).toMatch(/^Outflows are first-hop TEL transfers \(legacy \+ v3\)/);
  });

  it("TEL token slots match the old decimals rule (2 dp = legacy, 18 dp = v3)", () => {
    const plan = walletFlowsPlan(resolveProject("tel", repo), { root: repo });
    const cfg = plan.chainsCfg.ethereum.tokens;
    const slots = tokenSlots({ legacy: { address: cfg.legacy.address, decimals: 2 }, v3: { address: cfg.v3.address, decimals: 18 } });
    expect(slots.get(cfg.legacy.address)).toEqual({ decimals: 2, slot: "legacy" });
    expect(slots.get(cfg.v3.address)).toEqual({ decimals: 18, slot: "v3" });
  });

  it("a non-TEL project resolves every gated path under its slug, with its own addresses only", () => {
    const plan = walletFlowsPlan(resolveProject("demo", tmp), { root: tmp });
    expect(path.relative(tmp, plan.out)).toBe("data/demo/forensics/wallet-flows.json");
    expect(path.relative(tmp, plan.registry)).toBe("data/demo/forensics/wallet-flows.registry.json");
    expect(path.relative(tmp, plan.recon)).toBe("public/data/demo/supply-reconciliation.json");
    expect(path.relative(tmp, plan.cexPath)).toBe("config/projects/demo/cex-wallets.json");
    expect(plan.dexPath).toBeNull(); // never TEL's DEX list
    expect(plan.chains).toEqual(["arbitrum"]);
    expect(plan.coingeckoId).toBe("demo-coin");
    expect(plan.bridgeAddresses).toEqual([X("c")]); // TEL bridge infra not applied
    expect(plan.logSpan("arbitrum")).toBe(50_000);
    expect(walletFlowsNotes(plan).join(" ")).toMatch(/first-hop DMO transfers/);
    expect(walletFlowsNotes(plan).join(" ")).not.toMatch(/\bTEL\b|Telcoin/);
    for (const p of [plan.out, plan.registry]) expect(path.relative(tmp, p).startsWith("public")).toBe(false);
  });

  it("--chains must name chains in the project's map", () => {
    expect(() => walletFlowsPlan(resolveProject("demo", tmp), { root: tmp, argv: ["--chains", "polygon"] })).toThrow(/not in demo/);
  });
});

describe("gate function project list", () => {
  it("LEGACY_ROOT_SLUGS in netlify/functions-src/gatedProjects.ts matches data.legacyRoot", () => {
    const src = fs.readFileSync(path.join(repo, "netlify/functions-src/gatedProjects.ts"), "utf8");
    const m = src.match(/LEGACY_ROOT_SLUGS[^=]*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(m).toBeTruthy();
    const listed = [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]).sort();
    expect(listed).toEqual(legacyRootSlugs(repo).sort());
  });
});
