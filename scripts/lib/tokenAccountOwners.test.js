import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadNonRetailSet } from "./nonRetailSet.js";
import { projectNonRetailPaths, projectRoleAddresses, ROLE_SUPPLY_CATEGORIES } from "./projects.js";
import { mergeRoleExclusions } from "./reconcileSupply.js";

const VAULT_TOKEN_ACCOUNT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
const VAULT_OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM_STAKING = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";

const project = {
  slug: "fixture",
  legacy: false,
  config: {
    slug: "fixture",
    chains: [
      { key: "solana", vm: "solana", contracts: { vault: { address: VAULT_TOKEN_ACCOUNT, role: "staking" } } },
      { key: "ethereum", contracts: { staking: { address: EVM_STAKING, role: "staking" } } },
    ],
  },
};
const snapshot = { tokenAccountOwnersByChain: { solana: { [VAULT_TOKEN_ACCOUNT]: VAULT_OWNER } } };

const emptyPaths = (paths) => ({ ...paths, exclusionsPath: null, cexPath: null, dexPath: null });

describe("token-account owners in the non-retail set", () => {
  it("includes the owner of a contracts{} token account (shared path used by lite/history/resync)", async () => {
    const { set } = await loadNonRetailSet(emptyPaths(projectNonRetailPaths(project, os.tmpdir(), snapshot)));
    expect(set.has(VAULT_TOKEN_ACCOUNT)).toBe(true);
    expect(set.has(VAULT_OWNER)).toBe(true);
    expect(set.has(EVM_STAKING.toLowerCase())).toBe(true);
  });

  it("is a no-op without tokenAccountOwnersByChain (EVM unchanged)", () => {
    const without = projectNonRetailPaths(project, os.tmpdir());
    expect(projectNonRetailPaths(project, os.tmpdir(), {})).toEqual(without);
    expect(projectNonRetailPaths(project, os.tmpdir(), null)).toEqual(without);
    expect(without.extraAddresses).not.toContain(VAULT_OWNER);
  });

  it("agrees with every address reconcile-supply labels from the same snapshot", async () => {
    const merged = mergeRoleExclusions(
      { addresses: [], labels: {} },
      projectRoleAddresses(project.config),
      ROLE_SUPPLY_CATEGORIES,
      snapshot.tokenAccountOwnersByChain,
    );
    const { set } = await loadNonRetailSet(emptyPaths(projectNonRetailPaths(project, os.tmpdir(), snapshot)));
    for (const address of merged.addresses) expect(set.has(address), address).toBe(true);
  });
});

// Behavioural coverage: run each caller as a real process on a fixture project
// in a temp root. A crash while building the set (e.g. a TDZ ReferenceError)
// fails these; resync additionally proves the owner is dropped from retail.
describe("every caller builds the non-retail set with owners (spawned on a fixture)", () => {
  const SLUG = "fx";
  const MINT = "So11111111111111111111111111111111111111112";
  const ALICE = "7dvTVafoMm52sjyJCHkHZv119MecicqFCrgjq8RcLxJ6";
  const repo = path.resolve(".");
  let tmp;

  const write = (rel, obj) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), JSON.stringify(obj));
  };
  const holder = (address, balance) => ({ address, balance });
  const run = (script, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [path.join(repo, "scripts", script)], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, HD_PROJECT: SLUG, SOLANA_RPC_URL: "https://127.0.0.1:9", ...extraEnv },
    });
    return { status: r.status, out: `${r.stdout}
${r.stderr}` };
  };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-owners-"));
    write("config/projects.json", { projects: [{ slug: SLUG, name: "Fx", ticker: "FX", default: true }] });
    write(`config/projects/${SLUG}.json`, {
      slug: SLUG, name: "Fx", ticker: "FX",
      data: { legacyRoot: false, dir: `public/data/${SLUG}` },
      supply: { target: 1e6, generationsSumOneToOne: false },
      chains: [{
        key: "solana", name: "Solana", vm: "solana", origin: true, bridge: "native",
        rpc: { envPrefix: "SOLANA", publicUrls: ["https://127.0.0.1:9"] },
        tokens: [{ address: MINT, program: "spl-token", decimals: 6, status: "canonical", symbol: "FX" }],
        contracts: { vault: { address: VAULT_TOKEN_ACCOUNT, role: "staking" } },
      }],
    });
    write(`config/projects/${SLUG}/exclusions.json`, { addresses: [], labels: {} });
  });

  // Fresh snapshot per test: resync rewrites it, which would hide the owner from later scripts.
  beforeEach(() => {
    write(`public/data/${SLUG}/tel-holders.json`, {
      generatedAt: "2026-11-07T00:00:00Z",
      thresholds: { retail: 1000, megaHolder: 1e12, minTelRaw: 1 },
      chainOrder: ["solana"],
      source: { snapshotDate: "2026-11-07" },
      combined: { holderCount: 2, totalBalance: 7000 },
      asOf: { date: "2026-11-07", blocks: { solana: 1 }, settled: false, live: ["solana"] },
      tokenAccountOwnersByChain: { solana: { [VAULT_TOKEN_ACCOUNT]: VAULT_OWNER } },
      chains: { solana: { key: "solana", holders: [holder(VAULT_OWNER, 5000), holder(ALICE, 2000)], metrics: {} } },
      wallets: [{ address: VAULT_OWNER, solana_balance: 5000, total_telcoin_balance: 5000 }, { address: ALICE, solana_balance: 2000, total_telcoin_balance: 2000 }],
    });
  });

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const crashed = (out) => /ReferenceError|before initialization|is not defined/.test(out);

  const readOut = (file) => JSON.parse(fs.readFileSync(path.join(tmp, file), "utf8"));

  it("generate-holders-lite counts only the real retail holder", () => {
    expect(run("generate-holders-lite.js").status).toBe(0);
    const metrics = readOut(`public/data/${SLUG}/holders-lite.json`).views.combined.metrics;
    expect(metrics.retail).toEqual({ count: 1, balance: 2000 });
  });

  it("generate-holders-history counts only the real holder as ever-held (cumulativeHolders = 1)", () => {
    const r = run("generate-holders-history.js");
    expect(r.status, r.out).toBe(0);
    const row = readOut(`public/data/${SLUG}/holders-history.json`).entries.at(-1);
    expect(row.cumulativeHolders).toBe(1);
  });

  it("detect-cex-candidates does not flag the vault owner", () => {
    const r = run("detect-cex-candidates.js", { CEX_CANDIDATE_MIN_BALANCE: "3000" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/^0 candidate wallet\(s\)/m);
  });

  it("resync-chain-holders drops the vault owner from retail", () => {
    const r = run("resync-chain-holders.js");
    expect(r.out).not.toMatch(/ReferenceError/);
    expect(r.status, r.out).toBe(0);
    const snap = JSON.parse(fs.readFileSync(path.join(tmp, `public/data/${SLUG}/tel-holders.json`), "utf8"));
    expect(snap.chains.solana.holders.map((h) => h.address)).toEqual([ALICE]);
    expect(snap.chains.solana.metrics.retail.totalBalance ?? snap.chains.solana.metrics.totalBalance).toBe(2000);
  });

  // Each caller must run past its set-building step: exit 0, or (for scripts
  // that need git history / RPC the fixture lacks) fail only AFTER the marker
  // that proves the set was built.
  for (const [script, marker] of [
    ["generate-holders-lite.js", /Non-retail set: 2 addresses/],
    ["generate-holder-transitions.js", /Non-retail set: 2 addresses/],
    ["rebuild-history-from-logs.js", /Non-retail set: 2 /],
    ["recompute-history-from-git.js", /Current non-retail set: 2 addresses/],
    ["rebuild-holders-history-solana.js", /Non-retail set: 2 addresses/],
  ]) {
    it(`${script} builds the non-retail set with the vault owner`, () => {
      const r = run(script);
      expect(crashed(r.out), r.out).toBe(false);
      if (marker) expect(r.out).toMatch(marker);
      else expect(r.status, r.out).toBe(0);
    });
  }
});
