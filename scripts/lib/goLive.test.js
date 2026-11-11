import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goLiveProblems, MAX_REPORT_AGE_HOURS, requiredFeedFiles } from "./goLive.js";
import { NULL_TX_RETRY_RUNS } from "./solana/flowScan.js";
import { alignmentProblems } from "../check-go-live.js";
import { alignmentReport } from "../check-feed-alignment.js";
import { projectHolderTiers } from "./holderTiers.js";
import { tierFingerprint } from "./tierFingerprint.js";

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
  holders: { defaultTiers: "fixture keeps the shared default tiers" },
  ...over,
});
const FEED_DOC = { generatedAt: FRESH, entries: [{ date: "2026-11-04" }] };
const tierDoc = (over = {}) => ({ ...FEED_DOC, complete: true, tierFingerprint: tierFingerprint(projectHolderTiers(config()).distributionTiers), ...over });
const check = (over, opts = {}) => goLiveProblems({ slug: "demo", dataDir: "public/data/demo", config: config(over) }, { root, now: NOW, ...opts });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "golive-"));
  write("config/projects.json", { projects: [{ slug: "tel", default: true }, { slug: "demo" }] });
  write("public/tokens/demo.png", "x");
  write("config/projects/demo/cex-wallets.json", { wallets: [] });
  write("config/projects/demo/ledger.json", { developerWallets: [{ address: WALLET }] });
  for (const f of [...FEEDS, "funding-wallets.json"]) write(`public/data/demo/${f}`, FEED_DOC);
  write("public/data/demo/tier-outflows.json", tierDoc());
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

  it("fails when the project has neither its own tiers nor a recorded decision to keep the default", () => {
    expect(check({ holders: {} }).join("\n")).toMatch(/holders\.distributionTiers is not set.*derive-holder-tiers\.js --project demo/);
    const own = projectHolderTiers(config()).distributionTiers;
    write("public/data/demo/tier-outflows.json", tierDoc({ tierFingerprint: tierFingerprint(own) }));
    expect(check({ holders: { distributionTiers: own } })).toEqual([]);
  });

  it("fails a feed pipeline-health calls unhealthy: stale file or stale newest row", () => {
    write("public/data/demo/holders-lite.json", { generatedAt: STALE });
    write("public/data/demo/exchange-flow-history.json", { generatedAt: FRESH, entries: [{ date: "2026-10-01" }] });
    const out = check({}, { section: "feeds" }).join("\n");
    expect(out).toMatch(/holders-lite\.json is stale/);
    expect(out).toMatch(/exchange-flow-history\.json is stale-tail \(newest row \d+d old\)/);
  });

  it("reports a missing required feed once, not again as unhealthy", () => {
    fs.rmSync(path.join(root, "public/data/demo/holders-lite.json"));
    expect(check({}, { section: "feeds" }).filter((p) => p.includes("holders-lite.json"))).toHaveLength(1);
  });

  it("fails tier outflows that have not caught up or were built on other tiers", () => {
    write("public/data/demo/tier-outflows.json", tierDoc({ complete: false }));
    expect(check({}, { section: "feeds" }).join("\n")).toMatch(/tier-outflows\.json is not complete/);
    write("public/data/demo/tier-outflows.json", tierDoc({ tierFingerprint: "0000000000000000" }));
    expect(check({}, { section: "feeds" }).join("\n")).toMatch(/built on other tiers/);
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

  describe("held Solana flow cursor", () => {
    const SOLANA = { chains: [{ key: "solana", vm: "solana" }] };
    const writeCheckpoint = (unavailable) =>
      write("public/data/demo/exchange-flow-checkpoint.json", { chains: { solana: { complete: true, unavailable } } });

    it("fails while an unavailable transaction is still being retried", () => {
      writeCheckpoint([{ signature: "sig-held", slot: 1, blockTime: 1, attempts: NULL_TX_RETRY_RUNS - 1 }]);
      const out = check(SOLANA, { section: "feeds" }).join("\n");
      expect(out).toMatch(/held, retrying/);
      expect(out).toContain("sig-held");
    });

    it("treats a missing attempts count as a first failure still held", () => {
      writeCheckpoint([{ signature: "sig-new", slot: 1, blockTime: 1 }]);
      expect(check(SOLANA, { section: "feeds" }).join("\n")).toMatch(/held, retrying/);
    });

    it("passes once every unavailable transaction reached the retry limit", () => {
      writeCheckpoint([{ signature: "sig-gone", slot: 1, blockTime: 1, attempts: NULL_TX_RETRY_RUNS }]);
      expect(check(SOLANA, { section: "feeds" })).toEqual([]);
    });

    it("passes with no checkpoint or no unavailable entries", () => {
      expect(check(SOLANA, { section: "feeds" })).toEqual([]);
      writeCheckpoint([]);
      expect(check(SOLANA, { section: "feeds" })).toEqual([]);
    });

    it("is a go-live gate only: under feeds, never under wallet-flows or ledger", () => {
      writeCheckpoint([{ signature: "sig-held", slot: 1, blockTime: 1, attempts: 1 }]);
      expect(check(SOLANA, { section: "feeds" }).join("\n")).toMatch(/held, retrying/);
      expect(check(SOLANA, { section: "wallet-flows" })).toEqual([]);
      expect(check(SOLANA, { section: "ledger" })).toEqual([]);
    });

    it("no workflow invokes check-go-live with the feeds section (or without a section)", () => {
      const dir = path.resolve(process.cwd(), ".github/workflows");
      const calls = fs
        .readdirSync(dir)
        .filter((name) => /\.ya?ml$/.test(name))
        .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n").map((line) => ({ name, line })))
        .filter(({ line }) => line.includes("check-go-live.js") && !line.trimStart().startsWith("#"));
      expect(calls.length).toBeGreaterThan(0);
      for (const { name, line } of calls) {
        expect(line, `${name}: must pass --section wallet-flows or ledger`).toMatch(/--section\s+(wallet-flows|ledger)\b/);
      }
    });

    it("ignores the checkpoint of an EVM-only project", () => {
      writeCheckpoint([{ signature: "sig-held", slot: 1, blockTime: 1, attempts: 1 }]);
      expect(check({}, { section: "feeds" })).toEqual([]);
    });
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

describe("alignmentProblems (check-go-live.js)", () => {
  const asOf = (date, blocks = { ethereum: 100 }, extra = {}) => ({ generatedAt: "2026-11-05T01:00:00Z", asOf: { date, blocks, ...extra } });
  const ALIGN_FEEDS = ["exchange-flow-history.json", "tier-outflows.json", "cex-balance-history.json", "holders-history.json", "treasury-history.json", "holder-transitions.json", "holders-lite.json"];
  const align = () => alignmentProblems({ slug: "demo", dataDir: "public/data/demo", config: config() }, { root });

  beforeEach(() => {
    write("config/projects/demo.json", config());
    for (const f of ALIGN_FEEDS) write(`public/data/demo/${f}`, asOf("2026-11-04"));
    write("public/data/demo/date-blocks.json", { cutoffs: { ethereum: { "2026-11-05": 101 } } });
  });

  it("passes aligned, stamped feeds with cutoffs for every chain", () => {
    expect(align()).toEqual([]);
  });

  it("fails an unstamped feed", () => {
    write("public/data/demo/tier-outflows.json", { generatedAt: "2026-11-05T01:00:00Z", entries: [{ date: "2026-11-04" }] });
    expect(align().join("\n")).toMatch(/unstamped \(no asOf\): tier-outflows.*fill-history-gaps/);
  });

  it("fails differing settled end dates and names the feeds", () => {
    write("public/data/demo/holders-history.json", asOf("2026-11-03"));
    expect(align().join("\n")).toMatch(/end dates differ:.*holders-history=2026-11-03/);
  });

  it("fails differing blocks on a comparable chain", () => {
    write("public/data/demo/holders-lite.json", asOf("2026-11-04", { ethereum: 90 }));
    expect(align().join("\n")).toMatch(/ethereum blocks differ by 10/);
  });

  it("allows a live (settled:false) feed within 1 day, fails beyond it", () => {
    write("public/data/demo/holders-lite.json", asOf("2026-11-05", {}, { settled: false, live: ["solana"] }));
    expect(align()).toEqual([]);
    write("public/data/demo/holders-lite.json", asOf("2026-11-07", {}, { settled: false, live: ["solana"] }));
    expect(align().join("\n")).toMatch(/live feed date differs by 3 days/);
  });

  it("fails a required feed that is missing instead of skipping it", () => {
    fs.rmSync(path.join(root, "public/data/demo/tier-outflows.json"));
    expect(align().join("\n")).toMatch(/alignment: missing feed: tier-outflows/);
  });

  it("alignmentReport warns on a missing required feed outside strict", () => {
    fs.rmSync(path.join(root, "public/data/demo/holder-transitions.json"));
    const [r] = alignmentReport({ root, only: "demo" });
    expect(r.result.warnings).toContain("missing feed: holder-transitions");
    expect(r.result.ok).toBe(true);
  });

  it("requiredFeedFiles lists the workflow's required files plus the flow feeds", () => {
    const files = requiredFeedFiles({ slug: "demo", dataDir: "public/data/demo", config: config() }, root);
    expect(files).toEqual(expect.arrayContaining(ALIGN_FEEDS));
  });

  it("fails a chain without cutoffs and points at build-cutoffs.js", () => {
    write("public/data/demo/date-blocks.json", {});
    expect(align().join("\n")).toMatch(/no cutoffs for chain ethereum.*build-cutoffs\.js --project demo/);
  });
});
