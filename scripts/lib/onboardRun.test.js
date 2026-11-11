import { describe, expect, it } from "vitest";
import { nextStep, onboardingSteps } from "./onboardRun.js";
import { projectHolderTiers } from "./holderTiers.js";
import { tierFingerprint } from "./tierFingerprint.js";

const TODAY = "2026-11-11";
const baseConfig = (over = {}) => ({
  slug: "foo",
  data: { legacyRoot: false },
  chains: [{ key: "ethereum", vm: "evm" }],
  classification: { cexWallets: "config/projects/foo/cex-wallets.json" },
  staking: [],
  capabilities: { projectWallets: false },
  pipeline: { historyStart: "2024-01-18" },
  ...over,
});
const OWN_TIERS = [
  { label: "1M+", min: 1_000_000, max: null },
  { label: "1K-1M", min: 1_000, max: 1_000_000 },
  { label: "1-1K", min: 1, max: 1_000 },
];
const row = (date, chains) => ({ date, chains: Object.fromEntries(chains.map((c) => [c, { holderCount: 1 }])) });
const lite = (labels) => ({ views: { combined: { distribution: labels.map((label) => ({ label, count: 1 })) } } });

/** Files on main for a project that has finished every step. */
const complete = (config) => {
  const labels = projectHolderTiers({ config }).distributionTiers.map((t) => t.label);
  const chains = config.chains.map((c) => c.key);
  return {
    "config/projects/foo/cex-wallets.json": { wallets: [{ address: "0x1" }] },
    "public/data/foo/tel-holders.json": { wallets: [] },
    "public/data/foo/holders-lite.json": lite(labels),
    "public/data/foo/holders-history.json": { entries: [row("2024-01-18", chains), row("2026-11-10", chains)] },
    "public/data/foo/exchange-flow-history.json": { entries: [{ date: "2026-11-10" }] },
    "public/data/foo/cex-balance-history.json": { entries: [{ date: "2024-01-18" }] },
    "public/data/foo/tier-outflows.json": { complete: true, tierFingerprint: tierFingerprint(projectHolderTiers({ config }).distributionTiers) },
    "data/foo/forensics/wallet-flows.json": { generated: "x" },
    "data/foo/ledger/ledger.json": { generated: "x" },
  };
};
const steps = (config, files, extra = {}) => onboardingSteps({ slug: "foo", config, readJson: (rel) => files[rel] ?? null, today: TODAY, ...extra });

describe("onboardingSteps", () => {
  it("a fresh EVM scaffold starts with the CEX sync, then the snapshot", () => {
    const config = baseConfig();
    const s = steps(config, {});
    expect(nextStep(s)).toMatchObject({ id: "cex-wallets", action: { workflow: "sync-cex-wallets.yml", inputs: { project: "foo" } } });
    const afterCex = steps(config, { "config/projects/foo/cex-wallets.json": { wallets: [{ address: "0x1" }] } });
    expect(nextStep(afterCex)).toMatchObject({ id: "snapshot", action: { workflow: "refresh-holders.yml" } });
  });

  it("a Solana project without a reviewed CEX list is blocked, not dispatched", () => {
    const s = steps(baseConfig({ chains: [{ key: "solana", vm: "solana" }], classification: {} }), {});
    const first = nextStep(s);
    expect(first.id).toBe("cex-wallets");
    expect(first.action).toBeUndefined();
    expect(first.blocked).toMatch(/cex-dune-candidates/);
  });

  it("derives tiers after the first snapshot, then refreshes so feeds use them", () => {
    const files = { ...complete(baseConfig()) };
    files["public/data/foo/holders-lite.json"] = lite(["500M+", "1-250K"]);
    const s = steps(baseConfig(), files);
    expect(nextStep(s)).toMatchObject({ id: "tiers", action: { edit: "derive-tiers" } });
    const withTiers = baseConfig({ holders: { distributionTiers: OWN_TIERS } });
    expect(nextStep(steps(withTiers, files))).toMatchObject({ id: "snapshot-on-tiers", action: { workflow: "refresh-holders.yml" } });
  });

  it("rebuilds history per EVM chain from pipeline.historyStart", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" }, chains: [{ key: "ethereum", vm: "evm" }, { key: "base", vm: "evm" }] });
    const files = complete(config);
    files["public/data/foo/holders-history.json"].entries.shift();
    const step = nextStep(steps(config, files));
    expect(step.id).toBe("history");
    expect(step.action.inputs).toEqual({ project: "foo", chain: "ethereum", start: "2024-01-18" });
    expect(step.action.more.map((a) => a.inputs.chain)).toEqual(["base"]);
  });

  it("redoes only the chain whose history is still missing", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" }, chains: [{ key: "ethereum", vm: "evm" }, { key: "base", vm: "evm" }] });
    const files = complete(config);
    files["public/data/foo/holders-history.json"].entries[0] = row("2024-01-18", ["ethereum"]);
    const step = nextStep(steps(config, files));
    expect(step).toMatchObject({ id: "history", why: expect.stringMatching(/missing on base$/) });
    expect(step.action.inputs.chain).toBe("base");
    expect(step.action.more).toEqual([]);
  });

  it("checks the tiers in use from holders-lite, which every refresh rewrites", () => {
    const config = baseConfig({ holders: { distributionTiers: OWN_TIERS } });
    const files = { ...complete(config), "public/data/foo/holders-lite.json": lite(["500M+", "1-250K"]) };
    expect(nextStep(steps(config, files))).toMatchObject({ id: "snapshot-on-tiers" });
  });

  it("skips the history backfill when no history start is set", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" }, pipeline: {} });
    expect(steps(config, complete(config)).map((s) => s.id)).not.toContain("history");
  });

  it("re-runs the exchange-flow scan until its newest row is at most 3 days old", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" } });
    const files = { ...complete(config), "public/data/foo/exchange-flow-history.json": { entries: [{ date: "2026-10-01" }] } };
    expect(nextStep(steps(config, files))).toMatchObject({ id: "exchange-flows", action: { inputs: { max_blocks_per_run: "3000000" } } });
  });

  it("treats tier outflows on other tiers as not done", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" } });
    const files = { ...complete(config), "public/data/foo/tier-outflows.json": { complete: true, tierFingerprint: "0000000000000000" } };
    expect(nextStep(steps(config, files))).toMatchObject({ id: "tier-outflows", why: expect.stringMatching(/other tiers/) });
  });

  it("adds the staker step only for a StakeChanged-style staking contract", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" }, staking: [{ chain: "ethereum", kind: "stakeChanged" }] });
    expect(nextStep(steps(config, complete(config)))).toMatchObject({ id: "staker-balances" });
    expect(steps(baseConfig(), {}).map((s) => s.id)).not.toContain("staker-balances");
  });

  it("never dispatches a workflow that cannot read the project's chain (Hedera)", () => {
    const config = baseConfig({ chains: [{ key: "hedera", vm: "hedera" }], classification: { cexWallets: "config/projects/foo/cex-wallets.json" }, holders: { defaultTiers: "test" } });
    const files = complete(baseConfig({ holders: { defaultTiers: "test" } }));
    delete files["public/data/foo/exchange-flow-history.json"];
    const s = steps(config, files);
    const byId = Object.fromEntries(s.map((x) => [x.id, x]));
    expect(byId["cex-wallets"].done).toBe(true);
    expect(byId["exchange-flows"]).toMatchObject({ done: false, blocked: expect.stringMatching(/not built for vm hedera/) });
    expect(byId["exchange-flows"].action).toBeUndefined();
    for (const x of s.filter((y) => !y.done && y.action?.workflow)) {
      expect(["snapshot", "snapshot-on-tiers"], `${x.id} dispatches ${x.action.workflow}`).toContain(x.id);
    }
    const noList = steps({ ...config, classification: {} }, {});
    expect(nextStep(noList)).toMatchObject({ id: "cex-wallets", blocked: expect.stringMatching(/no verified public source.*hedera/) });
  });

  it("reads a legacy-root project's feeds from public/data/ and its work files from data/", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" }, data: { legacyRoot: true }, capabilities: { projectWallets: true } });
    const moved = Object.fromEntries(
      Object.entries(complete(config)).map(([rel, doc]) => [rel.replace("public/data/foo/", "public/data/").replace("data/foo/forensics/", "data/forensics/"), doc]),
    );
    expect(nextStep(steps(config, moved, { goLive: [], onboardingFlag: false }))).toBeNull();
  });

  it("turns the Developer wallets tab on once the ledger exists, then gates on check-go-live", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" } });
    expect(nextStep(steps(config, complete(config)))).toMatchObject({ id: "developer-wallets-tab", action: { edit: "enable-project-wallets" } });
    const on = { ...config, capabilities: { projectWallets: true } };
    const blocked = nextStep(steps(on, complete(on), { goLive: ["foo: image is not set"], onboardingFlag: true }));
    expect(blocked).toMatchObject({ id: "go-live", blocked: "foo: image is not set" });
    expect(nextStep(steps(on, complete(on), { goLive: [], onboardingFlag: true }))).toMatchObject({ id: "list-on-site", action: { edit: "clear-onboarding-flag" } });
    expect(nextStep(steps(on, complete(on), { goLive: [], onboardingFlag: false }))).toBeNull();
  });
});
