import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nativeDecisionsFor } from "./lib/chainAdapters.js";
import { nightlyPlan } from "./lib/nightlyPlan.js";
import { hederaNativeDecisions } from "./lib/hedera/nativeDecisions.js";
import { validateAnswers } from "./lib/onboardAnswers.js";
import { largeHolderFindings, nextStep, onboardingSteps } from "./lib/onboardRun.js";
import { parseArgs, snapshotLocal } from "./onboard-run.js";
import { workflowMatrix } from "./workflow-paths.js";

const TODAY = "2026-11-13";
const hederaConfig = {
  slug: "foo",
  data: { legacyRoot: false },
  chains: [{ key: "hedera", vm: "hedera" }],
  classification: { cexWallets: "config/projects/foo/cex-wallets.json" },
  staking: [],
  supply: { target: 50_000_000_000 },
  holders: { defaultTiers: "test", megaHolderThreshold: 10_000_000_000 },
  capabilities: { projectWallets: false },
};
const files = { "config/projects/foo/cex-wallets.json": { wallets: [{ address: "0.0.1" }] }, "public/data/foo/tel-holders.json": { wallets: [] } };
const plan = (extra) => onboardingSteps({ slug: "foo", config: hederaConfig, readJson: (rel) => files[rel] ?? null, today: TODAY, onboardingFlag: true, ...extra });
const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

describe("native coin decisions (one answers-shaped format)", () => {
  it("compose into a valid onboarding-answers/1 record with the wallet, dex and cex decisions", () => {
    const d = hederaNativeDecisions();
    const { errors } = validateAnswers({
      version: "onboarding-answers/1",
      address: "native",
      chain: "hedera",
      historyStart: d.historyStart,
      staking: { decision: "none", evidence: "network staking is informational" },
      wallets: [{ chain: "hedera", address: "0.0.800", label: "Reward account", class: "treasury", source: "owner decision", confidence: "high" }],
      dex: { decision: "pools", evidence: "owner decision", pools: [{ chain: "hedera", address: "0.0.1456985", label: "WHBAR", source: "owner decision" }] },
      cex: { decision: "list", evidence: "owner decision", wallets: [{ chain: "hedera", address: "0.0.615421", exchange: "Bybit", source: "PoR", confidence: "high" }] },
      largeHolders: d.largeHolders,
    });
    expect(errors).toEqual([]);
  });

  it("only a project with a native-coin chain gets decisions", async () => {
    expect(await nativeDecisionsFor({ chains: [{ key: "ethereum", vm: "evm" }, { key: "solana", vm: "solana" }] })).toBeNull();
    expect(await nativeDecisionsFor({ chains: [{ key: "hedera", vm: "hedera" }] })).toMatchObject({ historyStart: "forward-only" });
  });

  it("the runner settles history from them when there is no answers record, and blocks without them", () => {
    expect(byId(plan({ nativeDecisions: hederaNativeDecisions() })).history).toMatchObject({ done: true });
    expect(byId(plan({ nativeDecisions: null })).history).toMatchObject({ done: false, blocked: expect.any(String) });
  });

  it("an acknowledged-retail account is not a finding; any other account over 1% blocks with the adapter Fix", () => {
    const wallets = [
      { address: "0.0.640701", total_telcoin_balance: 3_140_000_000, hedera_balance: 3_140_000_000 },
      { address: "0.0.999", total_telcoin_balance: 700_000_000, hedera_balance: 700_000_000 },
    ];
    const decisions = hederaNativeDecisions();
    const findings = largeHolderFindings({ wallets, chainKeys: ["hedera"], supplyTarget: 50e9, megaThreshold: 10e9, isNonRetail: () => false, rows: decisions.largeHolders });
    expect(findings.map((f) => [f.address, f.kind])).toEqual([["0.0.999", "missing"]]);
    const s = byId(plan({ nativeDecisions: decisions, largeHolders: findings }));
    expect(s["large-holders"].blocked).toMatch(/nativeDecisions\.js[\s\S]*HEDERA_LARGE_HOLDERS/);
    expect(nextStep(Object.values(s))).toMatchObject({ id: "large-holders" });
  });

  it("acknowledged retail above megaHolderThreshold goes through the derived raise, not a hand-set number", () => {
    const wallets = [{ address: "0.0.640701", total_telcoin_balance: 12_000_000_000, hedera_balance: 12_000_000_000 }];
    const findings = largeHolderFindings({ wallets, chainKeys: ["hedera"], supplyTarget: 50e9, megaThreshold: 10e9, isNonRetail: () => false, rows: hederaNativeDecisions().largeHolders });
    expect(findings).toMatchObject([{ kind: "dropped", aboveMega: true }]);
    expect(byId(plan({ nativeDecisions: hederaNativeDecisions(), largeHolders: findings, onboardingFlag: false }))["mega-threshold"].action).toEqual({ edit: "raise-mega-threshold" });
  });
});

describe("onboard-run --local", () => {
  it("is valid only with --dry-run", () => {
    expect(() => parseArgs(["--project", "foo", "--local"])).toThrow(/--local .*only with --dry-run/);
    expect(parseArgs(["--project", "foo", "--dry-run", "--local"])).toMatchObject({ dryRun: true, local: true });
    expect(parseArgs(["--project", "foo", "--dry-run"]).local).toBe(false);
  });

  it("copies the working tree's config and this project's data, nothing of another project", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "local-tree-"));
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(cwd, rel), text);
    };
    put("config/projects/foo.json", JSON.stringify({ data: { legacyRoot: false } }));
    put("public/data/foo/tel-holders.json", "{}");
    put("public/data/other/tel-holders.json", "{}");
    put("data/foo/x.json", "{}");
    const dir = snapshotLocal("foo", cwd);
    try {
      expect(fs.existsSync(path.join(dir, "config/projects/foo.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "public/data/foo/tel-holders.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "data/foo/x.json"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "public/data/other"))).toBe(false);
      expect(fs.existsSync(path.join(cwd, "config/projects/foo.json"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("npm run onboard -- --chain hedera --write (stubbed network)", () => {
  it("writes the registry and ledger wallets with the scaffold, and a second run changes nothing", async () => {
    const { main } = await import("./onboard.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-scaffold-"));
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.copyFileSync(path.resolve("config/nightly-jobs.json"), path.join(root, "config/nightly-jobs.json"));
    fs.writeFileSync(path.join(root, "config/projects.json"), JSON.stringify({ projects: [{ slug: "tel", name: "Telcoin", ticker: "TEL", default: true, legacyRoot: true }] }));
    const json = (body) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body });
    vi.stubGlobal("fetch", async (url) => {
      const u = String(url);
      if (u.includes("/network/supply")) return json({ total_supply: 5000000000000000000, released_supply: 4400000000000000000, timestamp: "1794354509.905415104" });
      if (u.includes("coingecko")) return json({ id: "hedera-hashgraph", name: "Hedera", symbol: "hbar", image: { large: "https://img.example/hbar.png" }, platforms: {} });
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    });
    const quiet = { log() {}, warn() {} };
    const snapshot = () => {
      const out = {};
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else out[path.relative(root, p).split(path.sep).join("/")] = fs.readFileSync(p, "utf8");
        }
      };
      walk(root);
      return out;
    };
    try {
      await main(["--chain", "hedera", "--write", "--root", root], { logger: quiet });
      const first = snapshot();
      const registry = JSON.parse(first["data/hedera/forensics/wallet-flows.registry.json"]);
      expect(registry.knownWallets.length).toBeGreaterThan(500);
      const ledger = JSON.parse(first["config/projects/hedera/ledger.json"]);
      expect(ledger.developerWallets.map((w) => w.address).sort()).toEqual(registry.knownWallets.map((w) => w.address).sort());
      expect(Object.keys(first).some((f) => f.includes("answers"))).toBe(false);
      const config = JSON.parse(first["config/projects/hedera.json"]);
      expect(config.supply.circulating.subtract).toEqual(expect.arrayContaining(["holdings", "team"]));
      expect(config.pipeline).toMatchObject({ workflowTimeoutMinutes: 270, holdersScanTimeoutMinutes: 120 });
      expect(workflowMatrix("hedera", root, { job: "holders" }).include[0]).toMatchObject({ timeout: 270, holdersTimeout: 120, holdersRetryTimeout: 35 });
      // Every nightly data set runs or is waived with a reason for the scaffolded coin (the registry-wide parity rule).
      const hedera = nightlyPlan(root).projects.find((p) => p.slug === "hedera");
      const plan = nightlyPlan(root);
      for (const dataset of new Set(plan.jobs.map((j) => j.dataset))) {
        const covering = plan.jobs.filter((j) => j.dataset === dataset).map((j) => hedera.jobs.find((x) => x.id === j.id));
        expect(covering.some((s) => s.status === "run" || (s.status === "waived" && s.reason.trim().length > 10)), dataset).toBe(true);
      }
      await main(["--chain", "hedera", "--write", "--root", root], { logger: quiet });
      expect(snapshot()).toEqual(first);
      expect(JSON.parse(snapshot()["config/projects/hedera.json"]).pipeline).toEqual(config.pipeline);
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
