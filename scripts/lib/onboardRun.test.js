import { describe, expect, it } from "vitest";
import {
  blockedMessage,
  ceilToLadder,
  cexCandidatesFromSpellbook,
  cexReviewApplies,
  cexReviewPending,
  editAwaitsReviewMessage,
  largeHolderFindings,
  megaRaise,
  megaThresholdFor,
  nextStep,
  noRunAppearedMessage,
  notOnMainMessage,
  onboardingSteps,
  STEP_VMS,
  sizingFromSnapshot,
  stuckMessage,
  timeBudgetMessage,
  usageMessage,
  workflowFailedMessage,
} from "./onboardRun.js";
import { projectHolderTiers } from "./holderTiers.js";
import { tierFingerprint } from "./tierFingerprint.js";

const TODAY = "2026-11-11";
const baseConfig = (over = {}) => ({
  slug: "foo",
  data: { legacyRoot: false },
  chains: [{ key: "ethereum", vm: "evm" }],
  classification: { cexWallets: "config/projects/foo/cex-wallets.json" },
  staking: [],
  supply: { target: 1_000_000_000 },
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
const stamp = (date, settled = true) => ({ date, blocks: { ethereum: 1 }, settled });

/** Files on main for a project that has finished every step. */
const complete = (config) => {
  const labels = projectHolderTiers({ config }).distributionTiers.map((t) => t.label);
  const chains = config.chains.map((c) => c.key);
  return {
    "config/projects/foo/cex-wallets.json": { wallets: [{ address: "0x1" }] },
    "public/data/foo/tel-holders.json": { wallets: [] },
    "public/data/foo/holders-lite.json": lite(labels),
    "public/data/foo/holders-history.json": { entries: [row("2024-01-18", chains), row("2026-11-10", chains)] },
    "public/data/foo/exchange-flow-history.json": { asOf: stamp("2026-11-10"), entries: [] },
    "public/data/foo/cex-balance-history.json": { entries: [{ date: "2024-01-18" }] },
    "public/data/foo/tier-outflows.json": { complete: true, tierFingerprint: tierFingerprint(projectHolderTiers({ config }).distributionTiers) },
    "data/foo/forensics/wallet-flows.json": { generated: "x" },
    "data/foo/forensics/wallet-flows.registry.json": { knownWallets: [{ address: "0x2" }] },
    "data/foo/ledger/ledger.json": { generated: "x" },
  };
};
const steps = (config, files, extra = {}) => onboardingSteps({ slug: "foo", config, readJson: (rel) => files[rel] ?? null, today: TODAY, ...extra });
const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

describe("onboardingSteps", () => {
  it("a fresh EVM scaffold starts with the CEX sync, then the snapshot", () => {
    const config = baseConfig();
    const s = steps(config, {});
    expect(nextStep(s)).toMatchObject({ id: "cex-wallets", action: { workflow: "sync-cex-wallets.yml", inputs: { project: "foo" } } });
    const afterCex = steps(config, { "config/projects/foo/cex-wallets.json": { wallets: [{ address: "0x1" }] } });
    expect(nextStep(afterCex)).toMatchObject({ id: "snapshot", action: { workflow: "refresh-holders.yml" } });
  });

  it("a Solana project without a reviewed CEX list is blocked with the answers field and the announced post-snapshot review", () => {
    const s = steps(baseConfig({ chains: [{ key: "solana", vm: "solana" }], classification: {} }), {});
    const first = nextStep(s);
    expect(first.id).toBe("cex-wallets");
    expect(first.action).toBeUndefined();
    // the candidates command needs a snapshot, so the first pass does not send the operator to it
    expect(first.blocked).not.toMatch(/--candidates/);
    expect(first.blocked).toMatch(/After the first snapshot the runner lists every labelled exchange wallet/);
    expect(first.blocked).toMatch(/"decision": "list"/);
    expect(first.blocked).toMatch(/none-known/);
    expect(first.blocked).toMatch(/--answers config\/projects\/foo\/onboarding\.answers\.json --write/);
  });

  it("an empty CEX list is done when the answers record none-known", () => {
    const config = baseConfig({ chains: [{ key: "solana", vm: "solana" }], classification: { cexWallets: "config/projects/foo/cex-wallets.json" } });
    const none = steps(config, { "config/projects/foo/cex-wallets.json": { wallets: [] } }, { answers: { cex: { decision: "none-known", evidence: "checked" } } });
    expect(none[0]).toMatchObject({ id: "cex-wallets", done: true, why: expect.stringMatching(/none-known/) });
    const without = steps(config, { "config/projects/foo/cex-wallets.json": { wallets: [] } });
    expect(without[0]).toMatchObject({ id: "cex-wallets", done: false });
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

  it("skips the history backfill when no history start is set and no flag or answers ask for a decision", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" }, pipeline: {} });
    expect(steps(config, complete(config)).map((s) => s.id)).not.toContain("history");
  });

  it("reports forward-only history as a deliberate skip", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" }, pipeline: {} });
    const s = steps(config, complete(config), { answers: { historyStart: "forward-only" } });
    expect(byId(s).history).toMatchObject({ done: true, why: "history: forward-only by owner decision (answers historyStart); no backfill steps" });
    expect(s.map((x) => x.id)).not.toContain("treasury-cex-history");
  });

  it("blocks an onboarding project whose history mode was never decided, with the fix", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" }, pipeline: {} });
    const history = byId(steps(config, complete(config), { onboardingFlag: true })).history;
    expect(history.done).toBe(false);
    expect(history.blocked).toMatch(/Fix:/);
    expect(history.blocked).toMatch(/"historyStart"/);
    expect(history.blocked).toMatch(/onboarding\.answers\.json/);
    expect(history.blocked).toMatch(/--write/);
  });

  it("uses the exchange-flow feed's own asOf stamp: a token with no CEX transfers still completes", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" } });
    const files = complete(config);
    files["public/data/foo/exchange-flow-history.json"] = { asOf: stamp("2026-11-10"), entries: [] };
    expect(byId(steps(config, files))["exchange-flows"].done).toBe(true);
  });

  it("re-runs the exchange-flow scan while the stamp is behind, unsettled or missing", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" } });
    for (const feed of [
      { asOf: stamp("2026-10-01"), entries: [{ date: "2026-11-10" }] },
      { asOf: { date: null, blocks: {}, settled: false }, entries: [{ date: "2026-11-10" }] },
      { entries: [{ date: "2026-11-10" }] },
    ]) {
      const files = { ...complete(config), "public/data/foo/exchange-flow-history.json": feed };
      expect(nextStep(steps(config, files))).toMatchObject({ id: "exchange-flows", action: { inputs: { max_blocks_per_run: "3000000" } } });
    }
  });

  it("Solana flow feeds: a complete scan stamp is done with zero transfers, an incomplete one (date null, settled false) is not, nor a settled stamp that is stale", () => {
    const config = baseConfig({ holders: { defaultTiers: "test" }, chains: [{ key: "solana", vm: "solana" }] });
    const feeds = {
      complete: [{ asOf: { date: "2026-11-10", blocks: { solana: 123 }, settled: true }, entries: [] }, true],
      noBlockButComplete: [{ asOf: { date: "2026-11-10", blocks: {}, settled: true, noBlock: ["solana"] }, entries: [] }, true],
      incomplete: [{ asOf: { date: null, blocks: {}, settled: false, incomplete: ["solana"] }, entries: [] }, false],
      staleSettled: [{ asOf: { date: "2026-10-20", blocks: { solana: 1 }, settled: true }, entries: [] }, false],
      empty: [{ entries: [] }, false],
    };
    for (const [name, [feed, done]] of Object.entries(feeds)) {
      const files = { ...complete(baseConfig({ holders: { defaultTiers: "test" } })), "public/data/foo/exchange-flow-history.json": feed };
      const step = byId(steps(config, files))["exchange-flows"];
      expect(step.done, name).toBe(done);
      if (!done) expect(step.action, name).toMatchObject({ workflow: "scan-exchange-flows.yml", inputs: { project: "foo" } });
    }
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

  it("dispatches Hedera's flow, wallet-flows and ledger workflows, and stops before the ones that cannot read it", () => {
    const config = baseConfig({ chains: [{ key: "hedera", vm: "hedera" }], classification: { cexWallets: "config/projects/foo/cex-wallets.json" }, holders: { defaultTiers: "test" } });
    const files = complete(baseConfig({ holders: { defaultTiers: "test" } }));
    delete files["public/data/foo/exchange-flow-history.json"];
    const s = steps(config, files);
    const ids = byId(s);
    expect(ids["cex-wallets"].done).toBe(true);
    expect(ids["exchange-flows"].blocked).toBeUndefined();
    expect(ids["exchange-flows"].action).toMatchObject({ workflow: "scan-exchange-flows.yml" });
    for (const x of s.filter((y) => !y.done && y.action?.workflow)) {
      expect(STEP_VMS[x.id] ?? ["hedera"], `${x.id} dispatches ${x.action.workflow}`).toContain("hedera");
    }
    const noList = steps({ ...config, classification: {} }, {});
    expect(nextStep(noList)).toMatchObject({ id: "cex-wallets", blocked: expect.stringMatching(/no verified public source.*hedera/) });
  });

  it("lists Hedera for exactly the steps built for it: flows, tier outflows, wallet flows and the ledger; history stays forward-only", () => {
    for (const id of ["exchange-flows", "tier-outflows", "wallet-flows", "ledger"]) expect(STEP_VMS[id], id).toContain("hedera");
    for (const id of ["history", "treasury-cex-history", "cex-wallets"]) expect(STEP_VMS[id], id).not.toContain("hedera");
  });

  it("stops loudly for a vm no workflow can read", () => {
    const config = baseConfig({ chains: [{ key: "x", vm: "cosmos" }], classification: { cexWallets: "config/projects/foo/cex-wallets.json" }, holders: { defaultTiers: "test" } });
    const files = complete(baseConfig({ holders: { defaultTiers: "test" } }));
    delete files["public/data/foo/exchange-flow-history.json"];
    const ids = byId(steps(config, files));
    expect(ids["exchange-flows"]).toMatchObject({ done: false, blocked: expect.stringMatching(/not built for vm cosmos/) });
    expect(ids["exchange-flows"].action).toBeUndefined();
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
    expect(blocked).toMatchObject({ id: "go-live", blocked: expect.stringContaining("foo: image is not set") });
    expect(blocked.blocked).toMatch(/Fix:/);
    expect(nextStep(steps(on, complete(on), { goLive: [], onboardingFlag: true }))).toMatchObject({ id: "list-on-site", action: { edit: "clear-onboarding-flag" } });
    expect(nextStep(steps(on, complete(on), { goLive: [], onboardingFlag: false }))).toBeNull();
  });
});

describe("registry, alignment and the onboarding flag", () => {
  const on = baseConfig({ holders: { defaultTiers: "test" }, capabilities: { projectWallets: true } });

  it("never dispatches wallet-flows for a registry with no known wallets", () => {
    const files = complete(on);
    delete files["data/foo/forensics/wallet-flows.json"];
    files["data/foo/forensics/wallet-flows.registry.json"] = { knownWallets: [] };
    const step = nextStep(steps(on, files));
    expect(step).toMatchObject({ id: "wallet-flows", blocked: expect.stringMatching(/lists no known wallets/) });
    expect(step.action).toBeUndefined();
    expect(step.blocked).toMatch(/--answers config\/projects\/foo\/onboarding\.answers\.json --write/);
  });

  it("refreshes once more until strict alignment passes, and never clears the flag while it fails", () => {
    const problems = ["foo: alignment: tier-outflows ends 2026-11-08 but holders-lite ends 2026-11-10 (fix: run the settled nightly)"];
    const failing = steps(on, complete(on), { goLive: [], onboardingFlag: true, alignment: problems });
    expect(nextStep(failing)).toMatchObject({ id: "alignment", action: { workflow: "refresh-holders.yml", inputs: { project: "foo" } } });
    const ids = failing.map((s) => s.id);
    expect(ids.indexOf("alignment")).toBeLessThan(ids.indexOf("go-live"));
    expect(ids.indexOf("alignment")).toBeLessThan(ids.indexOf("list-on-site"));
    const passing = steps(on, complete(on), { goLive: [], onboardingFlag: true, alignment: [] });
    expect(nextStep(passing)).toMatchObject({ id: "list-on-site" });
  });

  it("skips the alignment gate when it does not apply (already listed project)", () => {
    expect(steps(on, complete(on), { goLive: [] }).map((s) => s.id)).not.toContain("alignment");
  });
});

describe("largeHolderFindings", () => {
  const supplyTarget = 1_000_000_000;
  const megaThreshold = 200_000_000;
  const wallet = (address, balance, chain = "ethereum") => ({ address, total_telcoin_balance: balance, [`${chain}_balance`]: balance });
  const base = { chainKeys: ["ethereum", "base"], supplyTarget, megaThreshold, isNonRetail: (a) => a === "0xlabelled", explorerUrl: (c, a) => `https://x/${c}/${a}` };

  it("lists wallets above 1% of supply with no row, including mega wallets, and skips labelled and small ones", () => {
    const wallets = [wallet("0xmega", 300_000_000), wallet("0xbig", 20_000_000, "base"), wallet("0xlabelled", 400_000_000), wallet("0xsmall", 9_000_000)];
    const found = largeHolderFindings({ ...base, wallets });
    expect(found.map((f) => f.address)).toEqual(["0xmega", "0xbig"]);
    expect(found[0]).toMatchObject({ kind: "missing", aboveMega: true, share: 0.3, chain: "ethereum", url: "https://x/ethereum/0xmega" });
    expect(found[1]).toMatchObject({ chain: "base", aboveMega: false });
  });

  it("accepts a row for a wallet below the mega threshold but keeps flagging a retail row above it", () => {
    const wallets = [wallet("0xbig", 20_000_000), wallet("0xmega", 300_000_000)];
    const found = largeHolderFindings({ ...base, wallets, rows: [{ address: "0xBIG" }, { address: "0xmega" }] });
    expect(found.map((f) => [f.address, f.kind])).toEqual([["0xmega", "dropped"]]);
  });

  it('treats an "unknown" row like a "retail" row: a wallet below megaThreshold with that row raises no finding', () => {
    const wallets = [wallet("0xbig", 20_000_000)];
    expect(largeHolderFindings({ ...base, wallets, rows: [{ address: "0xbig", decision: "unknown" }] })).toEqual([]);
    expect(largeHolderFindings({ ...base, wallets, rows: [{ address: "0xbig", decision: "retail" }] })).toEqual([]);
  });

  it('treats an "unknown" row like a "retail" row: a wallet above megaThreshold with that row is dropped, identically to "retail"', () => {
    const wallets = [wallet("0xmega", 300_000_000)];
    const unknown = largeHolderFindings({ ...base, wallets, rows: [{ address: "0xmega", decision: "unknown" }] });
    const retail = largeHolderFindings({ ...base, wallets, rows: [{ address: "0xmega", decision: "retail" }] });
    expect(unknown).toHaveLength(1);
    expect(unknown[0].kind).toBe("dropped");
    expect(unknown).toEqual(retail);
  });

  it('keeps a "labelled" row out of the acknowledged set: the same wallet with a labelled row is "missing"', () => {
    const wallets = [wallet("0xmega", 300_000_000)];
    const found = largeHolderFindings({ ...base, isNonRetail: () => false, wallets, rows: [{ address: "0xmega", decision: "labelled" }] });
    expect(found.map((f) => [f.address, f.kind])).toEqual([["0xmega", "missing"]]);
  });
});

describe("sizingFromSnapshot", () => {
  const wallets = (balances) => balances.map((b, i) => ({ address: `0x${i}`, total_telcoin_balance: b }));
  const spread = Array.from({ length: 2000 }, (_, i) => 1 + (i * i) / 4);

  it("writes the full sizing block from retail wallets only", () => {
    const snapshot = { generatedAt: "2026-11-09T06:00:00Z", wallets: [...wallets(spread), { address: "0xtreasury", total_telcoin_balance: 900_000_000 }, { address: "0xwhale", total_telcoin_balance: 300_000_000 }] };
    const sized = sizingFromSnapshot({ slug: "foo", snapshot, isNonRetail: (a) => a === "0xtreasury", supplyTarget: 1_000_000_000, today: TODAY });
    expect(sized.blocked).toBeUndefined();
    expect(Object.keys(sized.holders)).toEqual(["$comment", "distributionTiers", "balanceRanges", "megaHolderThreshold", "retailThreshold", "concentrationBuckets"]);
    expect(sized.holders.$comment).toMatch(/2026-11-09/);
    expect(sized.holders.megaHolderThreshold).toBe(200_000_000);
    expect(sized.result.holders).toBe(2000);
  });

  it("blocks with the fix when one tier would hold more than 90% of wallets", () => {
    const sized = sizingFromSnapshot({ slug: "foo", snapshot: { wallets: wallets(Array(500).fill(5)) }, isNonRetail: () => false, supplyTarget: 1_000_000_000, today: TODAY });
    expect(sized.blocked).toMatch(/Fix:/);
    expect(sized.blocked).toMatch(/holders block of config\/projects\/foo\.json/);
    expect(sized.blocked).toMatch(/node scripts\/derive-holder-tiers\.js --project foo/);
  });
});

describe("stop messages: every one ends with a Fix: of exact commands or files", () => {
  const CONCRETE = /(gh |node |npm |config\/|public\/data\/|data\/|tasks\/)/;
  const solanaConfig = baseConfig({ chains: [{ key: "solana", vm: "solana", tokens: [{ address: "MintAddr", status: "canonical" }] }], classification: {}, pipeline: {} });
  const hederaConfig = baseConfig({ chains: [{ key: "hedera", vm: "hedera" }], holders: { defaultTiers: "test" } });
  const on = baseConfig({ holders: { defaultTiers: "test" }, capabilities: { projectWallets: true }, pipeline: {} });
  const missingLarge = [{ address: "0xmega", chain: "ethereum", balance: 300_000_000, share: 0.3, aboveMega: true, kind: "missing", url: "https://etherscan.io/address/0xmega" }];

  const scenarios = {
    "solana without CEX list": () => steps(solanaConfig, {}),
    "EVM without cexWallets file": () => steps(baseConfig({ classification: {} }), {}),
    "invalid answers": () => steps(baseConfig(), {}, { answers: {}, answersProblems: ["cex: missing"] }),
    "missing large-holder acks": () => steps(on, complete(on), { onboardingFlag: true, largeHolders: missingLarge, answers: { historyStart: "forward-only" } }),
    "history unset on an onboarding project": () => steps(on, complete(on), { onboardingFlag: true }),
    "history unset but answers name a date": () => steps(on, complete(on), { answers: { historyStart: "2024-01-01" } }),
    "empty forensics registry": () => {
      const files = complete(on);
      delete files["data/foo/forensics/wallet-flows.json"];
      files["data/foo/forensics/wallet-flows.registry.json"] = { knownWallets: [] };
      return steps(on, files);
    },
    "alignment failing then go-live failing": () => steps({ ...on, capabilities: { projectWallets: true } }, complete(on), { goLive: ["foo: image is not set"], alignment: ["foo: alignment: x"], onboardingFlag: true, answers: { historyStart: "forward-only" } }),
    "unsupported vm": () => steps(hederaConfig, {}),
  };

  for (const [name, build] of Object.entries(scenarios)) {
    it(`blocked state "${name}" carries Fix:`, () => {
      const list = build();
      const blocked = list.filter((s) => !s.done && s.blocked);
      expect(blocked.length, name).toBeGreaterThan(0);
      for (const s of blocked) {
        expect(blockedMessage(s), `${name}/${s.id}`).toMatch(/Fix:/);
        expect(s.blocked, `${name}/${s.id}`).toMatch(CONCRETE);
      }
    });
  }

  it("every step that dispatches or edits has a stuck message with Fix: and a concrete command", () => {
    const all = [
      ...Object.values(scenarios).flatMap((b) => b()),
      ...steps(baseConfig({ staking: [{ chain: "ethereum", kind: "stakeChanged" }] }), {}),
      ...steps(on, complete(on), { goLive: [], alignment: ["foo: alignment: x"], onboardingFlag: true, answers: { historyStart: "forward-only" } }),
      ...steps(baseConfig(), {}, { onboardingFlag: true }),
    ].filter((s) => s.action);
    expect(new Set(all.map((s) => s.id)).size).toBeGreaterThan(8);
    for (const s of all) {
      const msg = stuckMessage(s, "foo");
      expect(msg, s.id).toMatch(/Fix:/);
      expect(msg, s.id).toMatch(/gh workflow run onboard-project\.yml -f project=foo/);
      expect(msg, s.id).toMatch(CONCRETE);
    }
  });

  it("failed runs, bad dispatches, review stops, budget and usage errors all end in Fix:", () => {
    const failed = workflowFailedMessage({ workflow: "refresh-holders.yml", id: 42, conclusion: "failure", url: "https://github.com/o/r/actions/runs/42", slug: "foo" });
    expect(failed).toMatch(/Fix: gh run view 42 --log-failed/);
    expect(failed).toMatch(/https:\/\/github\.com\/o\/r\/actions\/runs\/42/);
    for (const msg of [
      failed,
      noRunAppearedMessage("refresh-holders.yml", "foo"),
      notOnMainMessage("foo"),
      editAwaitsReviewMessage({ files: ["config/projects/foo.json"], message: "tiers", slug: "foo" }),
      timeBudgetMessage({ id: "history" }, "foo"),
      usageMessage("--project <slug> is required"),
    ]) {
      expect(msg).toMatch(/Fix:/);
      expect(msg).toMatch(CONCRETE);
    }
  });
});

describe("representative messages", () => {
  it("prints the large-holder stop", () => {
    const on = baseConfig({ holders: { defaultTiers: "test" } });
    const findings = [{ address: "0xmega", chain: "ethereum", balance: 300_000_000, share: 0.3, aboveMega: true, kind: "missing", url: "https://etherscan.io/address/0xmega" }];
    const msg = steps(on, complete(on), { largeHolders: findings, answers: { address: "0xtoken", historyStart: "forward-only" } }).find((s) => s.id === "large-holders").blocked;
    expect(msg).toContain("0xmega on ethereum: 300,000,000 (30.00% of supply) https://etherscan.io/address/0xmega");
    expect(msg).toContain("npm run onboard -- --address 0xtoken --answers config/projects/foo/onboarding.answers.json --write");
    expect(msg).toMatch(/dropped from holder counts and retail/);
    expect(msg).toMatch(/gh workflow run onboard-project\.yml -f project=foo/);
    // acknowledging "retail" is enough; no instruction to hand-edit the project config
    expect(msg).toMatch(/runner raises holders\.megaHolderThreshold above it by itself/);
    expect(msg).toMatch(/"labelled" = .*ALSO add it under wallets, dex\.pools, cex\.wallets or staking\.contracts/);
    expect(msg).not.toMatch(/config\/projects\/foo\.json/);
    expect(msg).not.toMatch(/record a deliberate/);
  });
});

describe("megaHolderThreshold derived from the owner's recorded decisions", () => {
  it("ceilToLadder rounds up to 1 / 2.5 / 5 x 10^k", () => {
    expect([1, 1.1, 2.5, 2.6, 5, 5.1, 24.66e9, 25e9, 3.6e8].map(ceilToLadder)).toEqual([1, 2.5, 2.5, 5, 5, 10, 25e9, 25e9, 5e8]);
  });

  it("follows the ZBCN precedent: 20.55B top wallet on a 100B supply -> 25B", () => {
    expect(megaThresholdFor({ supplyTarget: 100e9, ackedBalances: [20.55e9] })).toBe(25e9);
  });

  it("is supply.target / 5 with no acknowledged whale, capped at supply.target, and never lowers an existing explicit value", () => {
    expect(megaThresholdFor({ supplyTarget: 1e9 })).toBe(2e8);
    expect(megaThresholdFor({ supplyTarget: 1e9, ackedBalances: [9.9e8] })).toBe(1e9);
    expect(megaThresholdFor({ supplyTarget: 1e9, existing: 9e8, ackedBalances: [3e8] })).toBe(9e8);
    expect(megaThresholdFor({ supplyTarget: 1e9, existing: 3e8, ackedBalances: [] })).toBe(3e8);
  });

  const supplyTarget = 1_000_000_000;
  const spread = Array.from({ length: 2000 }, (_, i) => 1 + (i * i) / 4);
  const retailWallets = spread.map((b, i) => ({ address: `0x${i}`, total_telcoin_balance: b, ethereum_balance: b }));
  const whale = (address, balance) => ({ address, total_telcoin_balance: balance, ethereum_balance: balance });
  const ack = (address) => ({ chain: "ethereum", address, decision: "retail", note: "traced" });

  it("sizes an acknowledged 30% whale into the tiers and puts the threshold above it", () => {
    const snapshot = { generatedAt: "2026-11-09T06:00:00Z", wallets: [...retailWallets, whale("0xwhale", 300_000_000)] };
    const sized = sizingFromSnapshot({ slug: "foo", snapshot, isNonRetail: () => false, supplyTarget, today: TODAY, largeHolderRows: [ack("0xwhale")] });
    expect(sized.blocked).toBeUndefined();
    expect(sized.holders.megaHolderThreshold).toBe(500_000_000);
    expect(sized.holders.megaHolderThreshold).toBeGreaterThan(300_000_000);
    expect(sized.result.holders).toBe(2001);
    expect(sized.holders.distributionTiers[0].min).toBeLessThanOrEqual(300_000_000);
  });

  it('an "unknown" acknowledgement sizes the same megaHolderThreshold as "retail"', () => {
    const snapshot = { generatedAt: "2026-11-09T06:00:00Z", wallets: [...retailWallets, whale("0xwhale", 300_000_000)] };
    const ackUnknown = (address) => ({ chain: "ethereum", address, decision: "unknown", note: "traced" });
    const withRetail = sizingFromSnapshot({ slug: "foo", snapshot, isNonRetail: () => false, supplyTarget, today: TODAY, largeHolderRows: [ack("0xwhale")] });
    const withUnknown = sizingFromSnapshot({ slug: "foo", snapshot, isNonRetail: () => false, supplyTarget, today: TODAY, largeHolderRows: [ackUnknown("0xwhale")] });
    expect(withUnknown.holders.megaHolderThreshold).toBe(withRetail.holders.megaHolderThreshold);
    expect(withUnknown.holders.megaHolderThreshold).toBe(500_000_000);
  });

  it("keeps an unacknowledged whale out of the sizing and a labelled one too", () => {
    const snapshot = { wallets: [...retailWallets, whale("0xwhale", 300_000_000), whale("0xlab", 250_000_000)] };
    const sized = sizingFromSnapshot({ slug: "foo", snapshot, isNonRetail: (a) => a === "0xlab", supplyTarget, today: TODAY, largeHolderRows: [] });
    expect(sized.holders.megaHolderThreshold).toBe(200_000_000);
    expect(sized.result.holders).toBe(2000);
  });

  it("never lowers an explicit higher threshold in the sizing step", () => {
    const sized = sizingFromSnapshot({ slug: "foo", snapshot: { wallets: retailWallets }, isNonRetail: () => false, supplyTarget, today: TODAY, existingMega: 600_000_000 });
    expect(sized.holders.megaHolderThreshold).toBe(600_000_000);
  });

  it("a labelled row for a wallet that is not actually non-retail still blocks the review", () => {
    const found = largeHolderFindings({ wallets: [whale("0xwhale", 300_000_000)], chainKeys: ["ethereum"], supplyTarget, megaThreshold: 200_000_000, isNonRetail: () => false, rows: [{ address: "0xwhale", decision: "labelled" }] });
    expect(found.map((f) => f.kind)).toEqual(["missing"]);
  });

  describe("lifecycle: scaffold -> large-holders -> tiers -> snapshot-on-tiers cannot cycle", () => {
    const scaffolded = baseConfig({ holders: { megaHolderThreshold: supplyTarget / 5 } });
    const answersOf = (rows) => ({ address: "0xtoken", historyStart: "2024-01-18", largeHolders: rows });
    const findingsFor = (config, wallets, rows) =>
      largeHolderFindings({ wallets, chainKeys: ["ethereum"], supplyTarget, megaThreshold: projectHolderTiers({ config }).megaHolderThreshold, isNonRetail: () => false, rows });
    const world = (config, wallets, rows, { snapshotMega, liteLabels } = {}) => {
      const files = {
        ...complete(config),
        "public/data/foo/tel-holders.json": { generatedAt: "2026-11-09T06:00:00Z", thresholds: { megaHolder: snapshotMega ?? projectHolderTiers({ config }).megaHolderThreshold }, wallets },
        "public/data/foo/holders-lite.json": lite(liteLabels ?? projectHolderTiers({ config }).distributionTiers.map((t) => t.label)),
      };
      return steps(config, files, { onboardingFlag: true, answers: answersOf(rows), largeHolders: findingsFor(config, wallets, rows) });
    };
    const wallets = [...retailWallets, whale("0xwhale", 300_000_000)];

    it("an unacknowledged whale blocks at large-holders with a Fix that never asks for a config hand edit", () => {
      const s = world(scaffolded, wallets, [], { liteLabels: ["500M+", "1-250K"] });
      expect(nextStep(s)).toMatchObject({ id: "large-holders", blocked: expect.stringContaining("0xwhale") });
      expect(nextStep(s).blocked).not.toMatch(/config\/projects\/foo\.json/);
    });

    it("walks scaffold -> ack -> tiers -> refresh -> done, then a later whale raises only the threshold and refreshes", () => {
      // 1. acknowledged retail: the review passes even though the whale is above the scaffold threshold
      const rows = [ack("0xwhale")];
      const defaultLabels = { liteLabels: ["500M+", "1-250K"] };
      const afterAck = world(scaffolded, wallets, rows, defaultLabels);
      expect(byId(afterAck)["large-holders"].done).toBe(true);
      expect(nextStep(afterAck)).toMatchObject({ id: "tiers", action: { edit: "derive-tiers" } });
      expect(byId(afterAck)["mega-threshold"].done).toBe(false); // handled after the tiers edit, never a stop

      // 2. the tiers edit writes the threshold above the whale and sizes it in
      const sized = sizingFromSnapshot({ slug: "foo", snapshot: { wallets }, isNonRetail: () => false, supplyTarget, today: TODAY, largeHolderRows: rows, existingMega: 200_000_000 });
      const tiered = { ...scaffolded, holders: { ...scaffolded.holders, ...sized.holders } };
      expect(tiered.holders.megaHolderThreshold).toBeGreaterThan(300_000_000);
      const afterTiers = world(tiered, wallets, rows, { snapshotMega: 200_000_000, liteLabels: defaultLabels.liteLabels });
      expect(nextStep(afterTiers)).toMatchObject({ id: "snapshot-on-tiers", action: { workflow: "refresh-holders.yml" } });
      expect(byId(afterTiers)["mega-threshold"].done).toBe(true);
      expect(byId(afterTiers)["mega-threshold"].action).toBeUndefined(); // a done step never carries an action

      // 3. the refresh ran on the new tiers and the new threshold: nothing left in the first-snapshot lifecycle
      const refreshed = world(tiered, wallets, rows);
      expect(byId(refreshed)["snapshot-on-tiers"].done).toBe(true);
      expect(refreshed.filter((s) => ["large-holders", "tiers", "mega-threshold", "snapshot-on-tiers"].includes(s.id)).every((s) => s.done)).toBe(true);

      // 4. a second whale is acknowledged later, above the written threshold: a small threshold-only edit, then a re-snapshot
      const wallets2 = [...wallets, whale("0xlater", 700_000_000)];
      const rows2 = [...rows, ack("0xlater")];
      const later = world(tiered, wallets2, rows2);
      expect(nextStep(later)).toMatchObject({ id: "mega-threshold", action: { edit: "raise-mega-threshold" } });
      expect(nextStep(later).blocked).toBeUndefined();
      const raised = megaRaise({ supplyTarget, current: tiered.holders.megaHolderThreshold, findings: findingsFor(tiered, wallets2, rows2).filter((f) => f.kind === "dropped") });
      expect(raised).toBe(1_000_000_000);
      const raisedConfig = { ...tiered, holders: { ...tiered.holders, megaHolderThreshold: raised } };
      expect(raisedConfig.holders.distributionTiers).toBe(tiered.holders.distributionTiers); // labels (join keys) untouched
      const stale = world(raisedConfig, wallets2, rows2, { snapshotMega: tiered.holders.megaHolderThreshold });
      expect(nextStep(stale)).toMatchObject({ id: "snapshot-on-tiers", action: { workflow: "refresh-holders.yml" } });
      const done = world(raisedConfig, wallets2, rows2);
      expect(done.filter((s) => ["large-holders", "tiers", "mega-threshold", "snapshot-on-tiers"].includes(s.id)).every((s) => s.done)).toBe(true);
    });

    it("applying the raise a second time changes nothing (no loop on a threshold already above every acknowledged wallet)", () => {
      const rows = [ack("0xwhale")];
      const sized = sizingFromSnapshot({ slug: "foo", snapshot: { wallets }, isNonRetail: () => false, supplyTarget, today: TODAY, largeHolderRows: rows, existingMega: 200_000_000 });
      const config = { ...scaffolded, holders: { ...scaffolded.holders, ...sized.holders } };
      expect(megaRaise({ supplyTarget, current: config.holders.megaHolderThreshold, findings: findingsFor(config, wallets, rows).filter((f) => f.kind === "dropped") })).toBeNull();
    });

    it("stops with a Fix when a threshold cannot be raised without exceeding the supply", () => {
      const rows = [ack("0xhuge")];
      const huge = [whale("0xhuge", supplyTarget * 1.5)];
      const config = baseConfig({ holders: { megaHolderThreshold: supplyTarget, distributionTiers: OWN_TIERS } });
      const s = world(config, huge, rows);
      expect(nextStep(s)).toMatchObject({ id: "mega-threshold", blocked: expect.stringMatching(/Fix:/) });
    });
  });
});

describe("non-EVM CEX review (candidates from the spellbook list, after the first snapshot)", () => {
  // Real base58 keys of other public accounts, used only as shaped fixtures.
  const BINANCE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const KRAKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const NOT_A_HOLDER = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  const sqlRow = (address, exchange) => `('solana', '${address}', '${exchange}', '${exchange} 1', 'hildobby', date '2024-01-01')`;
  const sql = `SELECT * FROM (VALUES ${sqlRow(BINANCE, "Binance")}, ${sqlRow(KRAKEN, "Kraken")}, ${sqlRow(NOT_A_HOLDER, "OKX")}) AS t`;
  const snapshot = { wallets: [{ address: BINANCE, total_telcoin_balance: 5_000_000 }, { address: KRAKEN, total_telcoin_balance: 100 }, { address: "Retail", total_telcoin_balance: 7 }], totals: {} };
  const config = baseConfig({ chains: [{ key: "solana", vm: "solana" }], classification: { cexWallets: "config/projects/foo/cex-wallets.json" } });
  const solanaFiles = { "config/projects/foo/cex-wallets.json": { wallets: [] }, "public/data/foo/tel-holders.json": snapshot };
  const candidates = cexCandidatesFromSpellbook(sql, snapshot, { chainKey: "solana", supplyTarget: 1_000_000_000, explorerUrl: (c, a) => `https://solscan.io/account/${a}` });
  const answers = (cex) => ({ cex: { evidence: "checked", wallets: [], rejected: [], ...cex } });
  const review = (a, cexCandidates = { candidates }) => byId(steps(config, solanaFiles, { answers: a, cexCandidates }))["cex-review"];

  it("keeps only labelled exchange wallets that hold the token, biggest first, with an explorer link", () => {
    expect(candidates.map((c) => [c.address, c.label, c.balance])).toEqual([[BINANCE, "Binance", 5_000_000], [KRAKEN, "Kraken", 100]]);
    expect(candidates[0]).toMatchObject({ chain: "solana", url: `https://solscan.io/account/${BINANCE}` });
  });

  it("none-known with unreviewed candidates is blocked with every candidate and the Fix", () => {
    const s = review(answers({ decision: "none-known" }));
    expect(s.done).toBe(false);
    for (const needle of [BINANCE, "Binance", "5,000,000", `https://solscan.io/account/${BINANCE}`, KRAKEN, "cex.wallets", "cex.rejected", '"list"', "--answers config/projects/foo/onboarding.answers.json --write", "gh workflow run onboard-project.yml -f project=foo", "--source spellbook --candidates"]) {
      expect(s.blocked, needle).toContain(needle);
    }
    expect(nextStep(steps(config, solanaFiles, { answers: answers({ decision: "none-known" }), cexCandidates: { candidates } }))).toMatchObject({ id: "cex-review" });
  });

  it("is done when every candidate is accepted or rejected", () => {
    const accepted = { chain: "solana", address: BINANCE, exchange: "Binance", source: "Solscan tag", confidence: "high" };
    const rejected = { chain: "solana", address: KRAKEN, note: "label belongs to a custody wallet" };
    expect(review(answers({ decision: "list", wallets: [accepted], rejected: [rejected] })).done).toBe(true);
    expect(review(answers({ decision: "none-known", rejected: [rejected, { ...rejected, address: BINANCE }] })).done).toBe(true);
    const half = review(answers({ decision: "list", wallets: [accepted] }));
    expect(half.done).toBe(false);
    expect(half.blocked).toContain(KRAKEN);
    expect(half.blocked).not.toContain(BINANCE);
  });

  it("is done when the candidate set is empty", () => {
    expect(review(answers({ decision: "none-known" }), { candidates: [] })).toMatchObject({ done: true });
  });

  it("blocks with the local command when the candidate list could not be built", () => {
    const s = review(answers({ decision: "none-known" }), { candidates: [], error: "spellbook fetch 503" });
    expect(s).toMatchObject({ done: false, blocked: expect.stringMatching(/spellbook fetch 503[\s\S]*--source spellbook --candidates/) });
  });

  it("waits for the snapshot and does not exist when the review does not apply", () => {
    const noSnap = byId(steps(config, { "config/projects/foo/cex-wallets.json": { wallets: [] } }, { answers: answers({ decision: "none-known" }), cexCandidates: { candidates: [] } }))["cex-review"];
    expect(noSnap).toMatchObject({ done: false, why: expect.stringMatching(/first snapshot/) });
    expect(noSnap.blocked).toBeUndefined();
    expect(steps(config, solanaFiles, { answers: answers({ decision: "none-known" }) }).map((s) => s.id)).not.toContain("cex-review");
  });

  it("applies to a Solana-only project and not to EVM or Hedera", () => {
    expect(cexReviewApplies(config)).toBe(true);
    expect(cexReviewApplies(baseConfig())).toBe(false);
    expect(cexReviewApplies(baseConfig({ chains: [{ key: "hedera", vm: "hedera" }] }))).toBe(false);
    expect(cexReviewApplies(baseConfig({ chains: [{ key: "ethereum", vm: "evm" }, { key: "solana", vm: "solana" }] }))).toBe(false);
  });

  describe("cexReviewPending compares per chain and per address form", () => {
    const sol = "6FEVkH17P9y8Q9aCkDdPcMDjvj7SVxrTETaYEm8f51Jy";
    const evm = "0x00000000000000000000000000000000000AbCdE";
    const decided = (rows) => ({ cex: { wallets: [], rejected: rows } });

    it("Solana base58 is case-sensitive, 0x addresses are not", () => {
      expect(cexReviewPending([{ chain: "solana", address: sol }], decided([{ chain: "solana", address: sol }]))).toEqual([]);
      expect(cexReviewPending([{ chain: "solana", address: sol }], decided([{ chain: "solana", address: sol.toLowerCase() }]))).toHaveLength(1);
      expect(cexReviewPending([{ chain: "ethereum", address: evm }], decided([{ chain: "ethereum", address: evm.toLowerCase() }]))).toEqual([]);
    });

    it("a decision on one chain never settles the same address on another chain", () => {
      expect(cexReviewPending([{ chain: "polygon", address: evm }], decided([{ chain: "ethereum", address: evm }]))).toHaveLength(1);
      expect(cexReviewPending([{ chain: "ethereum", address: evm }], { cex: { wallets: [{ chain: "ethereum", address: evm }], rejected: [] } })).toEqual([]);
    });
  });
});
