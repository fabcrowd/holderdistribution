import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chainEntry, main, scaffold, validateScaffold } from "./add-project.js";

const quiet = { log() {}, warn() {} };
const registry = { projects: [{ slug: "tel", name: "Telcoin", ticker: "TEL", default: true, legacyRoot: true }] };
const args = (extra = {}) => ({ slug: "foo", name: "Foo", ticker: "foo", chains: ["ethereum:0x" + "ab".repeat(20) + ":18"], wallets: [], stables: [], ...extra });

describe("add-project", () => {
  it("scaffolds a valid registry entry, project config, ledger config and empty wallet registry", () => {
    const r = scaffold(args(), registry);
    expect(Object.keys(r.files)).toEqual(["config/projects.json", "config/projects/foo.json", "config/projects/foo/ledger.json", "data/foo/forensics/wallet-flows.registry.json"]);
    expect(r.files["config/projects.json"].projects.map((p) => p.slug)).toEqual(["tel", "foo"]);
    expect(r.files["config/projects/foo.json"].ticker).toBe("FOO");
    expect(r.files["config/projects/foo.json"].capabilities.projectWallets).toBe(true);
    expect(r.files["data/foo/forensics/wallet-flows.registry.json"].knownWallets).toEqual([]);
    expect(r.files["config/projects/foo/ledger.json"].stablecoins.ethereum.map((s) => s.symbol)).toEqual(["USDC", "USDT"]);
    expect(validateScaffold(r).errors).toEqual([]);
  });

  it("wallets turn on the gated tab", () => {
    const r = scaffold(args({ wallets: ["0x" + "cd".repeat(20) + ":Treasury"] }), registry);
    expect(r.files["config/projects/foo.json"].capabilities.projectWallets).toBe(true);
    expect(r.files["config/projects/foo/ledger.json"].developerWallets[0]).toMatchObject({ label: "Treasury", chains: ["ethereum"] });
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
    expect(() => main(argv, { logger: quiet })).toThrow(/already/);
    main([...argv, "--dry-run", "--force"], { logger: quiet });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "config/projects/foo/chains-inventory.json"), "utf8")).chains.map((c) => c.status)).toEqual(["configured", "not-found"]);
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
