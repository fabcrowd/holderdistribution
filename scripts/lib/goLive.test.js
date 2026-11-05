import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goLiveProblems, MAX_REPORT_AGE_HOURS } from "./goLive.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const FRESH = new Date(NOW - 3600_000).toISOString();
const STALE = new Date(NOW - (MAX_REPORT_AGE_HOURS + 1) * 3600_000).toISOString();
const WALLET = "0xabcdef1111111111111111111111111111111111";
const FEEDS = [
  "tel-holders.json", "holders-summary.json", "holders-history.json", "holders-lite.json", "holders-checkpoint.json",
  "holder-transitions.json", "holders-ever-checkpoint.json", "supply-reconciliation.json", "treasury-history.json",
  "classification-changelog.json", "cex-wallets.json", "cex-flows.json", "cex-balance-history.json",
  "exchange-flow-history.json", "tier-outflows.json",
];

let root;
const write = (rel, value) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const config = (over = {}) => ({
  slug: "demo",
  ticker: "DEMO",
  image: "/tokens/demo.png",
  data: { legacyRoot: false },
  supply: { target: 1000 },
  chains: [{ key: "ethereum", vm: "evm" }],
  gated: { forensics: true },
  capabilities: { projectWallets: true },
  classification: { cexWallets: "config/projects/demo/cex-wallets.json" },
  ...over,
});
const check = (over, opts = {}) => goLiveProblems({ slug: "demo", dataDir: "public/data/demo", config: config(over) }, { root, now: NOW, ...opts });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-"));
  write("config/projects.json", { projects: [{ slug: "tel", default: true }, { slug: "demo" }] });
  write("public/tokens/demo.png", "x");
  write("config/projects/demo/cex-wallets.json", { wallets: [] });
  write("config/projects/demo/ledger.json", { developerWallets: [{ address: WALLET }] });
  for (const f of FEEDS) write(`public/data/demo/${f}`, {});
  write("data/demo/forensics/wallet-flows.registry.json", { knownWallets: [{ address: WALLET }] });
  write("data/demo/forensics/wallet-flows.json", { generated: FRESH });
  write("data/demo/ledger/ledger.json", { generated: FRESH });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("goLiveProblems", () => {
  it("passes a fully wired project", () => {
    expect(check()).toEqual([]);
  });

  it.each([
    ["supply.target", { supply: {} }, /supply\.target/],
    ["image", { image: undefined }, /image/],
    ["cex list", { classification: {} }, /cexWallets/],
    ["forensics gate", { gated: {} }, /gated\.forensics/],
    ["developer wallets", { capabilities: {} }, /projectWallets/],
    ["feedsPending", { pipeline: { feedsPending: true } }, /feedsPending/],
    ["placeholder feed", { health: { feeds: { "tier-outflows.json": { placeholder: true } } } }, /placeholder/],
  ])("fails on %s", (_name, over, message) => {
    expect(check(over).join("\n")).toMatch(message);
  });

  it("fails when a required feed or flow feed is missing", () => {
    fs.rmSync(path.join(root, "public/data/demo/holders-lite.json"));
    fs.rmSync(path.join(root, "public/data/demo/tier-outflows.json"));
    const out = check().join("\n");
    expect(out).toMatch(/holders-lite\.json/);
    expect(out).toMatch(/tier-outflows\.json/);
  });

  it("fails on a stale or missing wallet-flows report", () => {
    write("data/demo/forensics/wallet-flows.json", { generated: STALE });
    expect(check().join("\n")).toMatch(/wallet-flows report is \d+h old/);
    fs.rmSync(path.join(root, "data/demo/forensics/wallet-flows.json"));
    expect(check().join("\n")).toMatch(/wallet-flows report missing/);
  });

  it("fails on a stale or missing ledger", () => {
    write("data/demo/ledger/ledger.json", { generated: STALE });
    expect(check().join("\n")).toMatch(/ledger report is \d+h old/);
    fs.rmSync(path.join(root, "data/demo/ledger/ledger.json"));
    expect(check().join("\n")).toMatch(/ledger report missing/);
  });

  it("fails when a ledger wallet is not in the forensics registry, ignoring EVM case", () => {
    const stranger = "0x2222222222222222222222222222222222222222";
    write("config/projects/demo/ledger.json", {
      developerWallets: [{ address: `0x${WALLET.slice(2).toUpperCase()}` }, { address: stranger }],
    });
    const out = check();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(stranger);
  });

  it("fails when a developer-class registry wallet is missing from the ledger, but not a relay", () => {
    const added = "0x3333333333333333333333333333333333333333";
    const relay = "0x4444444444444444444444444444444444444444";
    write("data/demo/forensics/wallet-flows.registry.json", {
      knownWallets: [
        { address: WALLET, entityClass: "treasury" },
        { address: added, entityClass: "holdings" },
        { address: relay, entityClass: "relay" },
      ],
    });
    const out = check();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(added);
    expect(out[0]).toMatch(/not in the ledger/);
  });

  it("keeps base58 case significant when comparing wallets", () => {
    const wallet = "AbCdEfGhJkLmNpQrStUvWxYz123456789AbCdEfGhJk";
    write("data/demo/forensics/wallet-flows.registry.json", { knownWallets: [{ address: wallet }] });
    write("config/projects/demo/ledger.json", { developerWallets: [{ address: wallet.toLowerCase() }] });
    expect(check().join("\n")).toMatch(/not in the forensics registry/);
  });

  it("limits the result to one section", () => {
    fs.rmSync(path.join(root, "data/demo/ledger/ledger.json"));
    expect(check({ supply: {} }, { section: "wallet-flows" })).toEqual([]);
    expect(check({ supply: {} }, { section: "ledger" }).join("\n")).toMatch(/ledger report missing/);
  });

  it("rejects an unknown section", () => {
    expect(() => check({}, { section: "nope" })).toThrow(/section/);
  });
});
