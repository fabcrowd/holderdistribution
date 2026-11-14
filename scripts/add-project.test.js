import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chainEntry, main, scaffold, validateScaffold } from "./add-project.js";
import { projectHolderTiers } from "./lib/holderTiers.js";

const quiet = { log() {}, warn() {} };
const registry = { projects: [{ slug: "tel", name: "Telcoin", ticker: "TEL", default: true, legacyRoot: true }] };
const args = (extra = {}) => ({ slug: "foo", name: "Foo", ticker: "foo", chains: ["ethereum:0x" + "ab".repeat(20) + ":18"], wallets: [], stables: [], ...extra });

describe("add-project", () => {
  it("scaffolds a valid registry entry, project config, ledger config and empty wallet registry", () => {
    const r = scaffold(args(), registry);
    expect(Object.keys(r.files)).toEqual(["config/projects.json", "config/projects/foo.json", "config/projects/foo/ledger.json", "config/projects/foo/exclusions.json", "data/foo/forensics/wallet-flows.registry.json"]);
    expect(r.files["config/projects/foo/exclusions.json"]).toMatchObject({ addresses: [], labels: {} });
    expect(r.files["config/projects/foo.json"].classification.exclusions).toBe("config/projects/foo/exclusions.json");
    expect(r.files["config/projects.json"].projects.map((p) => p.slug)).toEqual(["tel", "foo"]);
    expect(r.files["config/projects/foo.json"].ticker).toBe("FOO");
    expect(r.files["config/projects/foo.json"].capabilities.projectWallets).toBe(false);
    expect(r.files["data/foo/forensics/wallet-flows.registry.json"].knownWallets).toEqual([]);
    expect(r.files["config/projects/foo/ledger.json"].stablecoins.ethereum.map((s) => s.symbol)).toEqual(["USDC", "USDT"]);
    expect(validateScaffold(r).errors).toEqual([]);
  });

  it("wallets seed the ledger but leave the tab off until a report exists", () => {
    const r = scaffold(args({ wallets: ["0x" + "cd".repeat(20) + ":Treasury"] }), registry);
    expect(r.files["config/projects/foo.json"].capabilities.projectWallets).toBe(false);
    expect(r.files["config/projects/foo/ledger.json"].developerWallets[0]).toMatchObject({ label: "Treasury", chains: ["ethereum"] });
  });

  it("scaffolds the first-run config every refresh needs, and stays off the site while onboarding", () => {
    const r = scaffold(args({ supplyTarget: 10_000_000_000, image: "/tokens/foo.png", historyStart: "2024-01-18" }), registry);
    const cfg = r.files["config/projects/foo.json"];
    expect(cfg.supply.target).toBe(10_000_000_000);
    expect(cfg.image).toBe("/tokens/foo.png");
    expect(cfg.pipeline.historyStart).toBe("2024-01-18");
    expect(cfg.staking).toEqual([]);
    expect(cfg.health.feeds["funding-wallets.json"].disabled).toBe(true);
    expect(cfg.treasury.categories).toEqual([]);
    expect(r.files["config/projects.json"].projects.at(-1)).toMatchObject({ slug: "foo", onboarding: true });
    expect(r.files["config/projects.json"].projects[0].onboarding).toBeUndefined();
  });

  it("lists only the treasury categories a supplied wallet fills", () => {
    const w = (cls) => `0x${"cd".repeat(20)}:W:${cls}`;
    expect(scaffold(args({ wallets: [w("association")] }), registry).files["config/projects/foo.json"].treasury.categories).toEqual(["treasury"]);
    // team/holdings buckets can be emptied, which aborts append-treasury-history (ONDO/ZBCN list treasury only): an empty list, never absent
    expect(scaffold(args({ wallets: [w("holdings")] }), registry).files["config/projects/foo.json"].treasury.categories).toEqual([]);
  });

  it("writes holders.megaHolderThreshold = supply.target / 5 from the first scaffold, and no tiers (the runner derives them)", () => {
    const cfg = scaffold(args({ supplyTarget: 10_000_000_000 }), registry).files["config/projects/foo.json"];
    expect(cfg.holders).toEqual({ megaHolderThreshold: 2_000_000_000 });
    const tiers = projectHolderTiers({ config: cfg });
    expect(tiers.megaHolderThreshold).toBe(2_000_000_000);
    expect(tiers.distributionTiers[0].label).toBe("500M+"); // tiers still the shared default until derived
    expect(scaffold(args({}), registry).files["config/projects/foo.json"].holders).toBeUndefined();
  });

  it("keeps the first holders block valid for any positive supply (tiny supplies get a retailThreshold below the mega cut)", () => {
    for (const supplyTarget of [1_000, 100, 1]) {
      const cfg = scaffold(args({ supplyTarget }), registry).files["config/projects/foo.json"];
      expect(cfg.holders.megaHolderThreshold).toBe(supplyTarget / 5);
      expect(cfg.holders.retailThreshold, `supply ${supplyTarget}`).toBeLessThan(cfg.holders.megaHolderThreshold);
      expect(() => projectHolderTiers({ config: cfg }), `supply ${supplyTarget}`).not.toThrow();
    }
    // above the shared default retailThreshold the block is unchanged: no retailThreshold is written
    expect(scaffold(args({ supplyTarget: 10_000 }), registry).files["config/projects/foo.json"].holders).toEqual({ megaHolderThreshold: 2_000 });
  });

  it("refuses a bad supply target, image path or history start", () => {
    expect(() => scaffold(args({ supplyTarget: 0 }), registry)).toThrow(/supply-target/);
    expect(() => scaffold(args({ image: "https://x/y.png" }), registry)).toThrow(/--image/);
    expect(() => scaffold(args({ historyStart: "18/01/2024" }), registry)).toThrow(/history-start/);
  });

  it("supports Solana", () => {
    expect(chainEntry("solana:ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU:6", 0)).toMatchObject({ vm: "solana", origin: true, rpc: { envPrefix: "SOLANA" } });
  });

  it("refuses bad input and duplicates", () => {
    expect(() => scaffold(args({ slug: "Bad Slug" }), registry)).toThrow(/slug/);
    expect(() => scaffold(args({ slug: "tel" }), registry)).toThrow(/already/);
    expect(() => scaffold(args({ chains: ["ethereum:0x12:18"] }), registry)).toThrow(/0x token/);
    expect(() => scaffold(args({ chains: [] }), registry)).toThrow(/--chain/);
  });

  it("writes into --root and refuses to overwrite", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addproj-"));
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config/projects.json"), JSON.stringify(registry));
    const inv = path.join(tmp, "inv.json");
    fs.writeFileSync(inv, JSON.stringify({ chains: [{ chain: "polygon", vm: "evm", status: "configured", tokens: [{ address: "0x" + "ab".repeat(20) }], source: "test" }, { chain: "base", status: "not-found", reason: "no code at the address", source: "detect-token-chains" }] }));
    const argv = ["--slug", "foo", "--name", "Foo", "--ticker", "FOO", "--chain", "polygon:0x" + "ab".repeat(20) + ":18", "--root", tmp, "--inventory", inv];
    main(argv, { logger: quiet });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "config/projects/foo/ledger.json"), "utf8")).chains).toEqual(["polygon"]);
    expect(fs.existsSync(path.join(tmp, "data/foo/forensics/wallet-flows.registry.json"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "config/projects/foo/exclusions.json"), "utf8"))).toMatchObject({ addresses: [], labels: {} });
    expect(() => main(argv, { logger: quiet })).toThrow(/already/);
    main([...argv, "--dry-run", "--force"], { logger: quiet });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "config/projects/foo/chains-inventory.json"), "utf8")).chains.map((c) => c.status)).toEqual(["configured", "not-found"]);
  });

  it("prints effective paths under --root and only the real next steps after --write", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addproj-out-"));
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config/projects.json"), JSON.stringify(registry));
    const inv = path.join(tmp, "inv.json");
    fs.writeFileSync(inv, JSON.stringify({ chains: [{ chain: "polygon", vm: "evm", status: "configured", tokens: [{ address: "0x" + "ab".repeat(20) }], source: "test" }] }));
    const lines = [];
    const logger = { log: (m) => lines.push(String(m)), warn() {} };
    main(["--slug", "foo", "--name", "Foo", "--ticker", "FOO", "--chain", "polygon:0x" + "ab".repeat(20) + ":18", "--supply-target", "1000000", "--root", tmp, "--inventory", inv], { logger });
    const out = lines.join("\n");
    expect(out).toContain(`write ${path.join(tmp, "config/projects/foo.json")}`);
    expect(out).not.toMatch(/write config\/projects/);
    expect(out).toContain("gh workflow run onboard-project.yml -f project=foo");
    expect(out).toContain("npm run onboard:check -- --project foo");
    expect(out).toContain(`git -C ${tmp} diff`);
    for (const dropped of ["wallet-candidates", "capabilities.projectWallets", "check-go-live"]) expect(out).not.toContain(dropped);
    expect(out).toMatch(/Still manual/);
    // a second run in dry-run mode prints the effective path too
    const dry = [];
    main(["--slug", "bar", "--name", "Bar", "--ticker", "BAR", "--chain", "polygon:0x" + "ab".repeat(20) + ":18", "--root", tmp, "--inventory", inv, "--dry-run"], { logger: { log: (m) => dry.push(String(m)), warn() {} } });
    expect(dry.join("\n")).toContain(`would write ${path.join(tmp, "config/projects/bar.json")}`);
  });

  it("chain & contract discovery comes first: no inventory, or an inventory that misses a chain, is refused", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "addproj-inv-"));
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config/projects.json"), JSON.stringify(registry));
    const base = ["--slug", "foo", "--name", "Foo", "--ticker", "FOO", "--chain", "polygon:0x" + "ab".repeat(20) + ":18", "--root", tmp];
    expect(() => main(base, { logger: quiet })).toThrow(/--inventory .* is required/);
    const write = (rows) => {
      const f = path.join(tmp, `inv-${Math.random()}.json`);
      fs.writeFileSync(f, JSON.stringify({ chains: rows }));
      return f;
    };
    expect(() => main([...base, "--inventory", write([{ chain: "base", status: "not-found", reason: "x", source: "s" }])], { logger: quiet })).toThrow(/polygon: configured chain missing/);
    const pol = { chain: "polygon", status: "configured", tokens: [{ address: "0x" + "ab".repeat(20) }], source: "s" };
    expect(() => main([...base, "--inventory", write([pol, { chain: "solana", status: "candidate", source: "coingecko" }])], { logger: quiet })).toThrow(/undecided candidate/);
    expect(() => main([...base, "--inventory", write([pol, { chain: "bsc", status: "excluded", source: "bscscan" }])], { logger: quiet })).toThrow(/needs a reason/);
    expect(fs.existsSync(path.join(tmp, "config/projects/foo.json"))).toBe(false);
  });
});
