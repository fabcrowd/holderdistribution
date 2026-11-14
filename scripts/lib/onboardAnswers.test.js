import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main as addProject, scaffold, validateScaffold } from "../add-project.js";
import { WALLET_CLASSES, appliedMismatches, applyAnswers, buildAnswersTemplate, readProjectFiles, validateAnswers, writeBlockers } from "./onboardAnswers.js";
import { projectRoleAddresses, resolveProject } from "./projects.js";

const repo = path.resolve(import.meta.dirname, "../..");
const quiet = { log() {}, warn() {} };
const registry = { projects: [{ slug: "tel", name: "Telcoin", ticker: "TEL", default: true, legacyRoot: true }] };
const example = () => JSON.parse(fs.readFileSync(path.join(repo, "config/onboarding.answers.example.json"), "utf8"));

const SOL = {
  mint: "75hbt6uvDqjPZ9WgFtMhBnTeyHw7cinoHiz4FD2vEz2d",
  treasury: "8EKdKDq6GunEvgmJfxuK8fad7zWY4oTjnfKDEfo6weWe",
  vault: "ErF9raeVUf1H7EgSDuApS1NYhBkAcnnVas9zmEK23sTE",
  pool: "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w",
  cex: "6FEVkH17P9y8Q9aCkDdPcMDjvj7SVxrTETaYEm8f51Jy",
};
const solanaAnswers = (over = {}) => ({
  version: "onboarding-answers/1",
  address: SOL.mint,
  chain: "solana",
  slug: "fake-sol",
  name: "Fake Sol",
  ticker: "FSOL",
  include: [],
  historyStart: "forward-only",
  staking: { decision: "none", evidence: "docs.fake-sol.example has no staking page; no vault in the top 20 holders" },
  wallets: [
    { chain: "solana", address: SOL.treasury, label: "Treasury", class: "treasury", source: "https://solscan.io/account/" + SOL.treasury, confidence: "high" },
    { chain: "solana", address: SOL.vault, label: "Reward vault", class: "reward-vault", source: "docs page", confidence: "medium" },
  ],
  dex: { decision: "pools", evidence: "https://dexscreener.com/solana/" + SOL.mint, pools: [{ chain: "solana", address: SOL.pool, label: "Orca pool", source: "https://solscan.io/account/" + SOL.pool }] },
  cex: { decision: "list", evidence: "Solscan tag", wallets: [{ chain: "solana", address: SOL.cex, exchange: "Crypto.com", source: "https://solscan.io/account/" + SOL.cex, confidence: "high" }] },
  largeHolders: [],
  ...over,
});

function onboardInto(root, answers, chainSpec, vm, extra = []) {
  const [chain, address] = chainSpec.split(":");
  const inv = path.join(root, "inv.json");
  fs.writeFileSync(inv, JSON.stringify({ chains: [{ chain, vm, status: "configured", tokens: [{ address }], source: "test fixture" }] }));
  const file = path.join(root, "answers.json");
  fs.writeFileSync(file, JSON.stringify(answers));
  return addProject(["--slug", answers.slug, "--name", answers.name, "--ticker", answers.ticker, "--chain", chainSpec, "--root", root, "--inventory", inv, "--answers", file, ...extra], { logger: quiet });
}
const newRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "answers-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config/projects.json"), JSON.stringify(registry));
  return root;
};
const snapshot = (root) => {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
};
const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
const canon = (a) => (/^0x/i.test(a) ? a.toLowerCase() : a);
/** Non-retail exactly as the pipeline sees it: a contracts{} role or an exclusions label. */
const nonRetail = (root, slug) => {
  const cfg = readJson(root, `config/projects/${slug}.json`);
  const set = new Set(Object.values(projectRoleAddresses(cfg)).flat().map((e) => canon(e.address)));
  for (const a of Object.keys(readJson(root, `config/projects/${slug}/exclusions.json`).labels)) set.add(canon(a));
  return set;
};
const errorsOf = (mutate) => {
  const a = example();
  mutate(a);
  return validateAnswers(a).errors.join("\n");
};

describe("validateAnswers", () => {
  it("accepts the shipped example and a Solana answers file", () => {
    expect(validateAnswers(example()).errors).toEqual([]);
    expect(validateAnswers(solanaAnswers()).errors).toEqual([]);
  });

  it("rejects the generated template: every decision fails with a how-to", () => {
    const template = buildAnswersTemplate({ address: "0x00000000000000000000000000000000000f00d1", chain: "ethereum", slug: "x-token", name: "X", ticker: "X", historyStart: "2024-01-01" });
    const msg = validateAnswers(template).errors.join("\n");
    expect(msg).toMatch(/staking\.decision: "FILL_ME" is not allowed; use one of: none \| contracts/);
    expect(msg).toMatch(/dex\.decision: .*none \| pools.*DexScreener/);
    expect(msg).toMatch(/cex\.decision: .*spellbook \| list \| none-known/);
    expect(msg).toMatch(/staking\.evidence: required: a URL or one sentence/);
    expect(msg).toMatch(/wallets\[0\]\.address: "FILL_ME" is not a valid evm address/);
    expect(msg).toMatch(/wallets\[0\]\.class: .*treasury \| team \| holdings \| association \| escrow \| reward-vault/);
  });

  it("names the field, the allowed values and what to do", () => {
    expect(errorsOf((a) => { a.staking.decision = "maybe"; })).toMatch(/staking\.decision: "maybe" is not allowed; use one of: none \| contracts \| unresolved\. .*stake/);
    expect(errorsOf((a) => { a.staking.evidence = "  "; })).toMatch(/staking\.evidence: required/);
    expect(errorsOf((a) => { delete a.dex; })).toMatch(/dex: missing\. DexScreener/);
    expect(errorsOf((a) => { a.wallets = []; })).toMatch(/wallets: needs at least 1 row\(s\)\. .*go-live needs a non-empty forensics registry/);
    expect(errorsOf((a) => { a.wallets[0].class = "whale"; })).toMatch(/wallets\[0\]\.class: "whale" is not allowed; use one of: treasury/);
    expect(errorsOf((a) => { a.wallets[0].confidence = "sure"; })).toMatch(/wallets\[0\]\.confidence: "sure" is not allowed; use one of: high \| medium \| low/);
    expect(errorsOf((a) => { a.wallets[0].address = "0x12"; })).toMatch(/wallets\[0\]\.address: "0x12" is not a valid evm address/);
    expect(errorsOf((a) => { a.wallets[0].chain = "polygon"; })).toMatch(/wallets\[0\]\.chain: "polygon" is not one of this project's chains \(ethereum\); add the chain to include\[\]/);
    expect(errorsOf((a) => { a.historyStart = "soon"; })).toMatch(/historyStart: "soon" is not allowed; use "YYYY-MM-DD" or "forward-only"/);
    expect(errorsOf((a) => { delete a.historyStart; })).toMatch(/historyStart/);
    expect(errorsOf((a) => { a.stakng = {}; })).toMatch(/unknown field\(s\) stakng; allowed: version, address/);
    expect(errorsOf((a) => { a.staking.contracts[0].deployBlock = undefined; })).toMatch(/deployBlock: required integer for stakeChanged/);
    expect(errorsOf((a) => { a.staking.contracts[0].kind = "zebecStakeV1"; })).toMatch(/kind zebecStakeV1 needs a solana chain, got ethereum/);
    expect(errorsOf((a) => { a.staking = { decision: "none", evidence: "docs checked", contracts: a.staking.contracts }; })).toMatch(/staking\.contracts: must be empty when decision is "none"/);
    expect(errorsOf((a) => { a.largeHolders[0].address = "0x000000000000000000000000000000000000dddd"; })).toMatch(/decision "labelled" but 0x0+dddd is not in wallets\/dex\/cex\/staking/);
    expect(errorsOf((a) => { a.wallets.push({ ...a.wallets[0] }); })).toMatch(/duplicate ethereum:0x/);
    expect(errorsOf((a) => { a.cex = { decision: "list", evidence: "x y z", wallets: [] }; })).toMatch(/cex\.wallets: needs at least 1 row\(s\) when decision is "list"/);
  });

  it('accepts a largeHolders row with decision "unknown" and keeps it in the parsed output', () => {
    const a = example();
    a.largeHolders = [{ chain: "ethereum", address: "0x000000000000000000000000000000000000dddd", decision: "unknown", note: "traced; identity not established" }];
    const { errors, answers } = validateAnswers(a);
    expect(errors).toEqual([]);
    expect(answers.largeHolders).toEqual([expect.objectContaining({ decision: "unknown", note: "traced; identity not established" })]);
  });

  it('allows cex "spellbook" only when every chain is EVM', () => {
    const a = solanaAnswers({ cex: { decision: "spellbook", evidence: "sync fills it" } });
    const msg = validateAnswers(a).errors.join("\n");
    expect(msg).toMatch(/cex\.decision: "spellbook" only works when every chain is EVM \(project chains: solana\); use "list" with at least one exchange wallet, or "none-known"/);
    expect(validateAnswers(solanaAnswers({ cex: { decision: "none-known", evidence: "Solscan top-50 holders checked, no exchange tags" } })).errors).toEqual([]);
  });

  it("a list field that is present but not an array is an error, whatever the decision", () => {
    expect(errorsOf((a) => { a.staking = { decision: "none", evidence: "docs checked", contracts: { a: 1 } }; })).toMatch(/staking\.contracts: must be an array/);
    expect(errorsOf((a) => { a.staking.contracts = { a: 1 }; })).toMatch(/staking\.contracts: must be an array/);
    expect(errorsOf((a) => { a.dex = { decision: "none", evidence: "no pool anywhere", pools: "x" }; })).toMatch(/dex\.pools: must be an array/);
    expect(errorsOf((a) => { a.cex = { decision: "spellbook", evidence: "sync fills it", wallets: { a: 1 } }; })).toMatch(/cex\.wallets: must be an array/);
    expect(errorsOf((a) => { a.cex = { decision: "spellbook", evidence: "sync fills it", rejected: {} }; })).toMatch(/cex\.rejected: must be an array/);
    expect(errorsOf((a) => { a.cex = { decision: "spellbook", evidence: "sync fills it", rejected: null }; })).toMatch(/cex\.rejected: must be an array/);
    expect(errorsOf((a) => { a.wallets = { a: 1 }; })).toMatch(/wallets: must be an array/);
    expect(errorsOf((a) => { a.largeHolders = "none"; })).toMatch(/largeHolders: must be an array/);
    expect(errorsOf((a) => { a.include = "polygon"; })).toMatch(/include: must be an array/);
  });

  it('staking "none" with contracts, and "contracts" without any, are errors', () => {
    const contracts = example().staking.contracts;
    expect(errorsOf((a) => { a.staking = { decision: "none", evidence: "docs checked", contracts }; })).toMatch(/staking\.contracts: must be empty when decision is "none"/);
    expect(errorsOf((a) => { a.staking = { decision: "contracts", evidence: "docs checked", contracts: [] }; })).toMatch(/staking\.contracts: needs at least 1 row\(s\) when decision is "contracts"/);
    expect(errorsOf((a) => { a.staking = { decision: "contracts", evidence: "docs checked" }; })).toMatch(/staking\.contracts: needs at least 1 row\(s\)/);
  });

  it("an address cannot be both a project wallet and an exchange wallet", () => {
    const a = solanaAnswers({ cex: { decision: "list", evidence: "Solscan tag", wallets: [{ chain: "solana", address: SOL.treasury, exchange: "Crypto.com", source: "Solscan tag", confidence: "high" }] } });
    expect(validateAnswers(a).errors.join("\n")).toMatch(new RegExp(`cex\\.wallets: ${SOL.treasury} is also in wallets; an address is either a project wallet or an exchange wallet, not both`));
    expect(validateAnswers(solanaAnswers()).errors).toEqual([]);
  });

  it("validates Solana addresses by their vm", () => {
    const msg = validateAnswers(solanaAnswers({ wallets: [{ chain: "solana", address: "0x" + "ab".repeat(20), label: "w", class: "team", source: "docs page", confidence: "low" }] })).errors.join("\n");
    expect(msg).toMatch(/wallets\[0\]\.address: .* is not a valid solana address/);
  });
});

describe("expansion into a scratch root", () => {
  const evmSpec = "ethereum:0x00000000000000000000000000000000000f00d1:18";

  it("EVM: every wallet is non-retail and labelled, the registry is filled, categories have a balance source", () => {
    const root = newRoot();
    const answers = example();
    onboardInto(root, answers, evmSpec, "evm");
    const slug = "example-token";
    const set = nonRetail(root, slug);
    for (const w of answers.wallets) expect(set.has(canon(w.address)), `${w.class} ${w.address}`).toBe(true);
    expect(set.has("0x0000000000000000000000000000000000009001")).toBe(true); // dex pool
    expect(set.has("0x00000000000000000000000000000000000057a1")).toBe(true); // staking contract

    const cfg = readJson(root, `config/projects/${slug}.json`);
    const roles = Object.fromEntries(Object.values(cfg.chains[0].contracts).map((c) => [c.address, c.role]));
    expect(roles).toMatchObject({
      "0x000000000000000000000000000000000000ca5e": "treasury",
      "0x000000000000000000000000000000000007ea11": "holdings",
      "0x00000000000000000000000000000000000e5c70": "staking",
      "0x0000000000000000000000000000000000009001": "dex",
      "0x00000000000000000000000000000000000057a1": "staking",
    });
    expect(roles["0x0000000000000000000000000000000000a550c1"]).toBeUndefined(); // association: exclusions label, as ondo

    const exclusions = readJson(root, `config/projects/${slug}/exclusions.json`);
    expect(exclusions.labels["0x0000000000000000000000000000000000a550c1"]).toMatchObject({ category: "treasury", evidenceTier: "owner-supplied" });
    expect(exclusions.addresses).toContain("0x0000000000000000000000000000000000a550c1");

    const reg = readJson(root, `data/${slug}/forensics/wallet-flows.registry.json`);
    expect(reg.knownWallets.map((w) => w.entityClass).sort()).toEqual(["association", "holdings", "holdings", "treasury"]);
    for (const w of reg.knownWallets) expect(w).toMatchObject({ chains: ["ethereum"], source: expect.any(String), confidence: expect.stringMatching(/high|medium|low/) });
    const ledger = readJson(root, `config/projects/${slug}/ledger.json`);
    expect(ledger.developerWallets.map((w) => w.address).sort()).toEqual(reg.knownWallets.map((w) => w.address).sort());

    // treasury.categories lists only the bucket proven never to reach 0 (append-treasury-history aborts on an omitted category); team/holdings stay out
    expect(cfg.treasury.categories).toEqual(["treasury"]);
    // owner decision 2026-11-12: team/holdings (and treasury/association) leave circulating
    expect(cfg.supply.circulating.subtract).toEqual(["treasury", "holdings"]);
    expect(cfg.supply.developerHoldings.subcategories.map((s) => s.category).sort()).toEqual(["holdings", "staking", "treasury"]);

    // staking: contracts decision keeps the funding-wallets feed on, no waiver
    expect(cfg.staking).toEqual([expect.objectContaining({ chain: "ethereum", kind: "stakeChanged", deployBlock: 17050000 })]);
    expect(cfg.health.feeds["funding-wallets.json"]).toBeUndefined();
    expect(cfg.nightly.waivers["staker-balances"]).toBeUndefined();
    // cex spellbook: empty list the sync fills + classification
    expect(readJson(root, `config/projects/${slug}/cex-wallets.json`)).toEqual({ wallets: [] });
    expect(cfg.classification.cexWallets).toBe(`config/projects/${slug}/cex-wallets.json`);
    expect(cfg.pipeline.historyStart).toBe("2023-04-12");
    expect(cfg.description).toMatch(/governance token/);

    const record = readJson(root, `config/projects/${slug}/onboarding.answers.json`);
    expect(record).toMatchObject({ version: "onboarding-answers/1", slug, historyStart: "2023-04-12", largeHolders: [expect.objectContaining({ decision: "labelled" })] });
    expect(resolveProject(slug, root).slug).toBe(slug);
  });

  it("Solana: CEX list file + classification, forward-only history, none-staking waiver and disabled feed", () => {
    const root = newRoot();
    onboardInto(root, solanaAnswers(), `solana:${SOL.mint}:6`, "solana");
    const slug = "fake-sol";
    const cfg = readJson(root, `config/projects/${slug}.json`);
    expect(cfg.pipeline?.historyStart).toBeUndefined();
    expect(cfg.staking).toEqual([]);
    expect(cfg.health.feeds["funding-wallets.json"]).toEqual({ disabled: true });
    expect(cfg.nightly.waivers["staker-balances"]).toMatch(/^\[answers\] No staking mechanism: docs\.fake-sol/);
    expect(readJson(root, `config/projects/${slug}/cex-wallets.json`).wallets).toEqual([expect.objectContaining({ address: SOL.cex, label: "Crypto.com", walletName: "Crypto.com" })]);
    expect(cfg.classification.cexWallets).toBe(`config/projects/${slug}/cex-wallets.json`);
    const set = nonRetail(root, slug);
    expect(set.has(SOL.treasury) && set.has(SOL.vault) && set.has(SOL.pool)).toBe(true);
    expect(readJson(root, `data/${slug}/forensics/wallet-flows.registry.json`).knownWallets.length).toBe(2);
    expect(cfg.treasury.categories).toEqual(["treasury"]); // reward vaults feed "staking", which is not listed
    expect(resolveProject(slug, root).slug).toBe(slug);
  });

  it("re-applying the same answers is idempotent and keeps hand edits outside their scope", () => {
    const root = newRoot();
    const answers = example();
    onboardInto(root, answers, evmSpec, "evm");
    const slug = "example-token";
    const cfgPath = path.join(root, `config/projects/${slug}.json`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.holders = { distributionTiers: [{ label: "1M+", min: 1000000, max: null }] };
    cfg.chains[0].contracts.handBridge = { address: "0x00000000000000000000000000000000000b81d9", role: "bridge", $comment: "hand edit" };
    fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
    const before = snapshot(root);
    const second = onboardInto(root, answers, evmSpec, "evm");
    expect(second.reapplied).toBe(true);
    expect(second.changed).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    const after = readJson(root, `config/projects/${slug}.json`);
    expect(after.holders.distributionTiers).toHaveLength(1);
    expect(after.chains[0].contracts.handBridge.role).toBe("bridge");
  });

  it("a changed answer replaces only the answers-derived entries", () => {
    const root = newRoot();
    const answers = example();
    onboardInto(root, answers, evmSpec, "evm");
    const trimmed = { ...answers, wallets: answers.wallets.filter((w) => w.class !== "team"), staking: { decision: "none", evidence: "docs checked: staking was removed", contracts: [] }, largeHolders: [] };
    onboardInto(root, trimmed, evmSpec, "evm");
    const cfg = readJson(root, "config/projects/example-token.json");
    const addresses = Object.values(cfg.chains[0].contracts).map((c) => c.address);
    expect(addresses).not.toContain("0x000000000000000000000000000000000007ea11");
    expect(addresses).not.toContain("0x00000000000000000000000000000000000057a1");
    expect(cfg.staking).toEqual([]);
    expect(cfg.health.feeds["funding-wallets.json"]).toEqual({ disabled: true });
    expect(cfg.nightly.waivers["staker-balances"]).toMatch(/^\[answers\]/);
    expect(readJson(root, "data/example-token/forensics/wallet-flows.registry.json").knownWallets.map((w) => w.label)).not.toContain("Example team vesting wallet");
  });

  it("re-applying without a wallet prints what it removed and leaves no stale category (team wallet A removed)", () => {
    const teamOnly = (extra = []) => ({ ...example(), largeHolders: [], wallets: [{ chain: "ethereum", address: "0x00000000000000000000000000000000000c1a55", label: "Team A", class: "team", source: "docs page", confidence: "low" }, ...extra] });
    const treasury = { chain: "ethereum", address: "0x000000000000000000000000000000000000ca5e", label: "Treasury", class: "treasury", source: "docs page", confidence: "low" };
    const files = scaffold({ slug: "foo", name: "Foo", ticker: "FOO", chains: [evmSpec], stables: [], wallets: [] }, registry).files;
    const first = applyAnswers(files, validateAnswers(teamOnly([treasury])).answers, { slug: "foo" });
    expect(first["config/projects/foo.json"].supply.circulating.subtract).toEqual(["treasury", "holdings"]);
    const removed = [];
    const second = applyAnswers(first, validateAnswers({ ...teamOnly(), wallets: [treasury] }).answers, { slug: "foo", onRemoved: (r) => removed.push(r) });
    const cfg = second["config/projects/foo.json"];
    expect(removed.map((r) => `${r.file}|${r.address}|${r.label}`)).toEqual(expect.arrayContaining([
      "config/projects/foo.json|0x00000000000000000000000000000000000c1a55|Team A",
      "config/projects/foo/ledger.json|0x00000000000000000000000000000000000c1a55|Team A",
      "data/foo/forensics/wallet-flows.registry.json|0x00000000000000000000000000000000000c1a55|Team A",
    ]));
    expect(removed.some((r) => /supply\.circulating\.subtract "holdings"/.test(r.label))).toBe(true);
    expect(cfg.supply.circulating.subtract).toEqual(["treasury"]);
    expect(cfg.supply.developerHoldings.subcategories.map((s) => s.category)).toEqual(["treasury"]);
    expect(cfg.treasury.categories).toEqual(["treasury"]);
    // a hand-written holdings wallet keeps its bucket even when the answers no longer list one
    const handHeld = structuredClone(first);
    handHeld["config/projects/foo.json"].chains[0].contracts.handHoldings = { address: "0x00000000000000000000000000000000000dead1", role: "holdings" };
    const kept = applyAnswers(handHeld, validateAnswers({ ...teamOnly(), wallets: [treasury] }).answers, { slug: "foo" });
    expect(kept["config/projects/foo.json"].supply.circulating.subtract).toEqual(["treasury", "holdings"]);
  });

  it("treasury.categories never lists team/holdings and stays an empty list (not absent) for a token with no treasury wallet", () => {
    const answers = { ...example(), largeHolders: [], wallets: [{ chain: "ethereum", address: "0x00000000000000000000000000000000000c1a55", label: "Team A", class: "team", source: "docs page", confidence: "low" }] };
    const files = scaffold({ slug: "foo", name: "Foo", ticker: "FOO", chains: [evmSpec], stables: [], wallets: [] }, registry).files;
    const cfg = applyAnswers(files, validateAnswers(answers).answers, { slug: "foo" })["config/projects/foo.json"];
    expect(cfg.treasury.categories).toEqual([]);
    expect(cfg.supply.circulating.subtract).toEqual(["holdings"]);
  });

  it("--wallet goes through the same expansion: role + label, never left as retail", () => {
    const base = { slug: "foo", name: "Foo", ticker: "FOO", chains: [evmSpec], stables: [], wallets: [] };
    const a = "0x00000000000000000000000000000000000a11ce";
    const t = "0x00000000000000000000000000000000000b0b00";
    const r = scaffold({ ...base, wallets: [`${a}:Labs:association`, `${t}:Safe:treasury`] }, registry);
    expect(validateScaffold(r).errors).toEqual([]);
    const cfg = r.files["config/projects/foo.json"];
    expect(Object.values(cfg.chains[0].contracts)).toEqual([expect.objectContaining({ address: t, role: "treasury" })]);
    expect(r.files["config/projects/foo/exclusions.json"].labels[a]).toMatchObject({ category: "treasury" });
    expect(cfg.treasury.categories).toEqual(["treasury"]);
    expect(r.files["data/foo/forensics/wallet-flows.registry.json"].knownWallets).toHaveLength(2);
  });

  it("team and holdings wallets each put their category in supply.circulating.subtract; escrow and reward vaults do not", () => {
    const subtractFor = (cls) => {
      const answers = { ...example(), largeHolders: [], wallets: [{ chain: "ethereum", address: "0x00000000000000000000000000000000000c1a55", label: `w ${cls}`, class: cls, source: "docs page", confidence: "low" }] };
      const files = scaffold({ slug: "foo", name: "Foo", ticker: "FOO", chains: [evmSpec], stables: [], wallets: [] }, registry).files;
      const out = applyAnswers(files, validateAnswers(answers).answers, { slug: "foo" });
      const cfg = out["config/projects/foo.json"];
      expect(appliedMismatches(validateAnswers(answers).answers, out, "foo"), cls).toEqual([]);
      return [cfg.supply?.circulating?.subtract ?? [], cfg.supply.developerHoldings.subcategories.map((s) => s.category)];
    };
    for (const cls of ["team", "holdings"]) {
      const [subtract, categories] = subtractFor(cls);
      expect(subtract, cls).toContain("holdings");
      expect(categories, cls).toContain("holdings");
    }
    for (const cls of ["escrow", "reward-vault"]) expect(subtractFor(cls)[0], cls).not.toContain("holdings");
  });

  it("appliedMismatches flags a team wallet whose category was dropped from circulating.subtract", () => {
    const root = newRoot();
    const answers = example();
    onboardInto(root, answers, evmSpec, "evm");
    const files = readProjectFiles(root, "example-token");
    files["config/projects/example-token.json"].supply.circulating.subtract = ["treasury"];
    const msg = appliedMismatches(validateAnswers(answers).answers, files, "example-token").join("\n");
    expect(msg).toMatch(/team vesting wallet\): supply\.circulating\.subtract lacks "holdings"/);
  });

  it("every wallet class maps to a config shape the pipeline reads", () => {
    for (const cls of WALLET_CLASSES) {
      const answers = { ...example(), largeHolders: [], wallets: [{ chain: "ethereum", address: "0x00000000000000000000000000000000000c1a55", label: `w ${cls}`, class: cls, source: "docs page", confidence: "low" }] };
      const files = scaffold({ slug: "foo", name: "Foo", ticker: "FOO", chains: [evmSpec], stables: [], wallets: [] }, registry).files;
      const out = applyAnswers(files, validateAnswers(answers).answers, { slug: "foo" });
      const cfg = out["config/projects/foo.json"];
      const roles = Object.values(cfg.chains[0].contracts).map((c) => c.role);
      const labelled = Object.keys(out["config/projects/foo/exclusions.json"].labels);
      expect(roles.length + labelled.length, cls).toBeGreaterThan(0);
    }
  });

  it("--force needs ONBOARD_FORCE=<slug> and says what it overwrites", () => {
    const root = newRoot();
    onboardInto(root, example(), evmSpec, "evm");
    expect(() => onboardInto(root, example(), evmSpec, "evm", ["--force"])).toThrow(/--force rewrites every scaffold file and drops hand edits: .*config\/projects\/example-token\.json.*ONBOARD_FORCE=example-token/s);
    process.env.ONBOARD_FORCE = "example-token";
    try {
      expect(() => onboardInto(root, example(), evmSpec, "evm", ["--force"])).not.toThrow();
    } finally {
      delete process.env.ONBOARD_FORCE;
    }
  });
});

describe("staking decision: none, contracts, unresolved", () => {
  const evmSpec = "ethereum:0x00000000000000000000000000000000000f00d1:18";
  const withStaking = (staking) => ({ ...example(), staking });
  const unresolved = { decision: "unresolved", evidence: "docs.example.org describes a vote-escrow lock; its program address is not published" };

  it("validates all three decisions", () => {
    expect(validateAnswers(example()).errors).toEqual([]); // contracts
    expect(validateAnswers(withStaking({ decision: "none", evidence: "searched docs and explorer: no staking" })).errors).toEqual([]);
    expect(validateAnswers(withStaking(unresolved)).errors).toEqual([]);
    expect(validateAnswers(withStaking({ ...unresolved, contracts: example().staking.contracts })).errors.join("\n")).toMatch(/staking\.contracts: must be empty when decision is "unresolved"/);
    expect(validateAnswers(withStaking({ decision: "unresolved" })).errors.join("\n")).toMatch(/staking\.evidence: required/);
  });

  it("the template hint separates none from unresolved", () => {
    const t = buildAnswersTemplate({ address: "0x00000000000000000000000000000000000f00d1", chain: "ethereum", slug: "x-token", name: "X", ticker: "X" });
    expect(t.staking.$howTo).toMatch(/"none" = you searched the project docs and the explorer and NO staking, locking or vote-escrow mechanism exists/);
    expect(t.staking.$howTo).toMatch(/cannot verify its address, set "unresolved" and stop/);
  });

  it("writeBlockers names the reason for unresolved only", () => {
    expect(writeBlockers(validateAnswers(withStaking(unresolved)).answers).join("\n")).toMatch(/mechanism exists and its contract\/program address is not verified.*must not claim there is none.*custody-only/s);
    expect(writeBlockers(validateAnswers(example()).answers)).toEqual([]);
    expect(writeBlockers(validateAnswers(withStaking({ decision: "none", evidence: "searched docs and explorer: no staking" })).answers)).toEqual([]);
  });

  it("--write refuses unresolved and writes nothing; a dry run accepts it", () => {
    const root = newRoot();
    const written = () => Object.keys(snapshot(root)).filter((rel) => rel.startsWith("config") && rel !== path.join("config", "projects.json") || rel.startsWith("data"));
    expect(() => onboardInto(root, withStaking(unresolved), evmSpec, "evm")).toThrow(/cannot be written yet:.*must not claim there is none/s);
    expect(written()).toEqual([]);
    expect(() => onboardInto(root, withStaking(unresolved), evmSpec, "evm", ["--dry-run"])).not.toThrow();
    expect(written()).toEqual([]);
    // "contracts" and "none" still write
    expect(() => onboardInto(root, example(), evmSpec, "evm")).not.toThrow();
  });
});

describe("cex.rejected", () => {
  const SOLANA_CEX = { chain: "solana", address: SOL.cex, exchange: "Crypto.com", source: "Solscan tag", confidence: "high" };
  const reject = (rejected, cex = {}) => solanaAnswers({ cex: { decision: "none-known", evidence: "checked", wallets: [], rejected, ...cex } });

  it("accepts rejected rows with a note and returns them normalized", () => {
    const { errors, answers } = validateAnswers(reject([{ chain: "solana", address: SOL.cex, note: "label belongs to a custody wallet" }]));
    expect(errors).toEqual([]);
    expect(answers.cex.rejected).toEqual([{ chain: "solana", address: SOL.cex, note: "label belongs to a custody wallet" }]);
    expect(validateAnswers(solanaAnswers()).answers.cex.rejected).toEqual([]);
  });

  it("requires an address of the project's chain, a note, and no overlap with cex.wallets", () => {
    expect(validateAnswers(reject([{ chain: "solana", address: SOL.cex }])).errors.join("\n")).toMatch(/cex\.rejected\[0\]\.note: required/);
    expect(validateAnswers(reject([{ chain: "solana", address: "0x12", note: "not an exchange wallet here" }])).errors.join("\n")).toMatch(/cex\.rejected\[0\]\.address/);
    const both = validateAnswers(reject([{ chain: "solana", address: SOL.cex, note: "not an exchange wallet here" }], { decision: "list", wallets: [SOLANA_CEX] }));
    expect(both.errors.join("\n")).toMatch(/is also in cex\.wallets; accept it or reject it, not both/);
  });

  it("the template carries an empty rejected list", () => {
    const t = buildAnswersTemplate({ address: SOL.mint, chain: "solana", slug: "x-token", name: "X", ticker: "X" });
    expect(t.cex.rejected).toEqual([]);
  });
});

describe("re-applying changed answers", () => {
  const evmSpec = "ethereum:0x00000000000000000000000000000000000f00d1:18";
  const polySpec = "polygon:0x00000000000000000000000000000000000f00d2:18";
  const A1 = "0x00000000000000000000000000000000000c1a55";
  const T1 = "0x000000000000000000000000000000000000ca5e";
  const CFG = "config/projects/foo.json";
  const LEDGER = "config/projects/foo/ledger.json";
  const REGISTRY = "data/foo/forensics/wallet-flows.registry.json";
  const wallet = (address, cls, label, chain = "ethereum") => ({ chain, address, label, class: cls, source: "docs page", confidence: "low" });
  const answersOf = (wallets, over = {}) => {
    const { errors, answers } = validateAnswers({ ...example(), largeHolders: [], wallets, ...over });
    expect(errors).toEqual([]);
    return answers;
  };
  const fresh = (chains = [evmSpec]) => scaffold({ slug: "foo", name: "Foo", ticker: "FOO", chains, stables: [], wallets: [] }, registry).files;
  const collect = () => {
    const events = { removed: [], reclassified: [], conflicts: [] };
    return { events, hooks: { slug: "foo", onRemoved: (r) => events.removed.push(r), onReclassified: (r) => events.reclassified.push(r), onConflict: (r) => events.conflicts.push(r) } };
  };
  const goneRows = (events) => events.removed.filter((r) => r.address !== "-");
  const contractsAt = (files, chain = "ethereum") => Object.values(files[CFG].chains.find((c) => c.key === chain).contracts);

  it("a class change is one reclassified line, not a removal, and equals a fresh apply of the new answers", () => {
    const first = applyAnswers(fresh(), answersOf([wallet(A1, "team", "Wallet A")]), { slug: "foo" });
    const next = answersOf([wallet(A1, "treasury", "Wallet A")]);
    const { events, hooks } = collect();
    const second = applyAnswers(first, next, hooks);
    expect(goneRows(events)).toEqual([]);
    expect(events.reclassified).toEqual([{ chain: "ethereum", address: A1, from: { class: "team", label: "Wallet A" }, to: { class: "treasury", label: "Wallet A" } }]);
    expect(second).toEqual(applyAnswers(fresh(), next, { slug: "foo" }));
  });

  it("a label change is reported too; a wallet really gone is still a removal", () => {
    const first = applyAnswers(fresh(), answersOf([wallet(A1, "team", "Wallet A"), wallet(T1, "treasury", "Treasury")]), { slug: "foo" });
    const { events, hooks } = collect();
    applyAnswers(first, answersOf([wallet(A1, "team", "Wallet A renamed")]), hooks);
    expect(events.reclassified).toEqual([expect.objectContaining({ address: A1, from: { class: "team", label: "Wallet A" }, to: { class: "team", label: "Wallet A renamed" } })]);
    expect(goneRows(events).map((r) => `${r.file}|${r.address}`).sort()).toEqual([`${CFG}|${T1}`, `${LEDGER}|${T1}`, `${REGISTRY}|${T1}`].sort());
  });

  it("a hand-written row for an answers wallet survives, is not duplicated or reclassified, and is reported as a conflict (warning, not a validation error)", () => {
    const files = fresh();
    files[CFG].chains[0].contracts.handBridge = { address: A1, role: "bridge", $comment: "hand edit" };
    files[LEDGER].developerWallets.push({ address: A1, label: "Hand row", group: "holdings", entityClass: "holdings", chains: ["ethereum"] });
    const first = applyAnswers(files, answersOf([wallet(A1, "team", "Wallet A")]), { slug: "foo" });
    const { events, hooks } = collect();
    const second = applyAnswers(first, answersOf([wallet(A1, "treasury", "Wallet A")]), hooks);
    for (const out of [first, second]) {
      expect(contractsAt(out).filter((c) => c.address === A1)).toEqual([{ address: A1, role: "bridge", $comment: "hand edit" }]);
      expect(out[LEDGER].developerWallets.filter((r) => r.address === A1)).toEqual([{ address: A1, label: "Hand row", group: "holdings", entityClass: "holdings", chains: ["ethereum"] }]);
    }
    expect(events.conflicts.map((c) => `${c.file}|${c.address}`).sort()).toEqual([`${CFG}|${A1}`, `${LEDGER}|${A1}`]);
  });

  it("the same address on two EVM chains keeps both rows and removes each independently", () => {
    const both = answersOf([wallet(A1, "team", "Wallet A"), wallet(A1, "team", "Wallet A", "polygon")], { include: ["polygon"] });
    const first = applyAnswers(fresh([evmSpec, polySpec]), both, { slug: "foo" });
    expect(contractsAt(first, "ethereum").some((c) => c.address === A1)).toBe(true);
    expect(contractsAt(first, "polygon").some((c) => c.address === A1)).toBe(true);
    expect(first[LEDGER].developerWallets.filter((r) => r.address === A1)).toEqual([expect.objectContaining({ chains: ["ethereum", "polygon"] })]);

    const { events, hooks } = collect();
    const second = applyAnswers(first, answersOf([wallet(A1, "team", "Wallet A")], { include: ["polygon"] }), hooks);
    expect(goneRows(events)).toEqual([{ file: CFG, address: A1, label: "Wallet A" }]);
    expect(contractsAt(second, "ethereum").some((c) => c.address === A1)).toBe(true);
    expect(contractsAt(second, "polygon").some((c) => c.address === A1)).toBe(false);
    expect(second[LEDGER].developerWallets.filter((r) => r.address === A1)).toEqual([expect.objectContaining({ chains: ["ethereum"] })]);

    const third = applyAnswers(first, answersOf([wallet(A1, "team", "Wallet A", "polygon")], { include: ["polygon"] }), { slug: "foo" });
    expect(contractsAt(third, "ethereum").some((c) => c.address === A1)).toBe(false);
    expect(contractsAt(third, "polygon").some((c) => c.address === A1)).toBe(true);
  });

  it("removing the last treasury wallet empties treasury.categories and drops treasury from subtract, unless a hand-written wallet still uses it", () => {
    const first = applyAnswers(fresh(), answersOf([wallet(A1, "team", "Team A"), wallet(T1, "treasury", "Treasury")]), { slug: "foo" });
    expect(first[CFG].treasury.categories).toEqual(["treasury"]);
    const teamOnly = answersOf([wallet(A1, "team", "Team A")]);
    const second = applyAnswers(first, teamOnly, { slug: "foo" });
    expect(second[CFG].treasury.categories).toEqual([]);
    expect(second[CFG].supply.circulating.subtract).toEqual(["holdings"]);
    expect(second[CFG].supply.developerHoldings.subcategories.map((s) => s.category)).toEqual(["holdings"]);

    const handHeld = structuredClone(first);
    handHeld[CFG].chains[0].contracts.handTreasury = { address: "0x00000000000000000000000000000000000dead2", role: "treasury" };
    const kept = applyAnswers(handHeld, teamOnly, { slug: "foo" });
    expect(kept[CFG].treasury.categories).toEqual(["treasury"]);
    expect(kept[CFG].supply.circulating.subtract).toEqual(["treasury", "holdings"]);
  });

  it("a hand-added circulating.subtract category the answers never produced survives a re-apply", () => {
    const first = applyAnswers(fresh(), answersOf([wallet(A1, "team", "Team A"), wallet(T1, "treasury", "Treasury")]), { slug: "foo" });
    first[CFG].supply.circulating.subtract.push("council");
    const teamOnly = answersOf([wallet(A1, "team", "Team A")]);
    const second = applyAnswers(first, teamOnly, { slug: "foo" });
    expect(second[CFG].supply.circulating.subtract).toEqual(["holdings", "council"]);
    expect(applyAnswers(second, teamOnly, { slug: "foo" })[CFG].supply.circulating.subtract).toEqual(["holdings", "council"]);
  });

  it("the CLI prints one reclassified line (not a removed line) for a class change and warns about a hand-written conflict", () => {
    const root = newRoot();
    const base = { ...example(), largeHolders: [] };
    onboardInto(root, base, evmSpec, "evm");
    const slug = "example-token";
    const cfgFile = path.join(root, `config/projects/${slug}.json`);
    const cfg = readJson(root, `config/projects/${slug}.json`);
    cfg.chains[0].contracts.handBridge = { address: "0x00000000000000000000000000000000000b81d9", role: "bridge" };
    fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    const team = base.wallets.find((w) => w.class === "team");
    const handAddress = "0x00000000000000000000000000000000000b81d9";
    const changed = { ...base, wallets: [...base.wallets.filter((w) => w !== team), { ...team, class: "treasury" }, { ...team, address: handAddress, label: "Bridge wallet", class: "holdings" }] };
    const lines = [];
    const inv = path.join(root, "inv.json");
    const file = path.join(root, "answers.json");
    fs.writeFileSync(file, JSON.stringify(changed));
    addProject(["--slug", slug, "--name", "Example Token", "--ticker", "EXMP", "--chain", evmSpec, "--root", root, "--inventory", inv, "--answers", file], { logger: { log: (l) => lines.push(l), warn() {} } });
    const text = lines.join("\n");
    expect(text).toContain(`reclassified ${team.address}: team (${team.label}) -> treasury (${team.label})`);
    expect(text).not.toMatch(new RegExp(`removed [^\\n]*: ${team.address}`));
    expect(text).toMatch(new RegExp(`WARNING kept hand-written .*example-token\\.json: ${handAddress}`));
  });

  it("applying the same answers twice leaves every written file byte-identical (EVM and Solana)", () => {
    const cases = [
      [example(), evmSpec, "evm", "example-token"],
      [solanaAnswers(), `solana:${SOL.mint}:6`, "solana", "fake-sol"],
    ];
    for (const [answers, spec, vm, slug] of cases) {
      const root = newRoot();
      onboardInto(root, answers, spec, vm);
      const before = snapshot(root);
      const again = onboardInto(root, answers, spec, vm);
      expect(again.changed, slug).toEqual([]);
      expect(snapshot(root), slug).toEqual(before);
      expect(Object.keys(before).some((rel) => rel.endsWith("cex-wallets.json")), slug).toBe(true);
    }
  });
});
