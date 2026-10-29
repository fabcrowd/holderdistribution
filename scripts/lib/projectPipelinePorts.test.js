/**
 * Second batch of pipeline ports (docs/MULTI-TOKEN.md "Pipeline"):
 *   - per-project working files: data/ for TEL, data/<slug>/ for others;
 *   - the newly ported scripts run for a non-legacy project and write ONLY
 *     under public/data/<slug>/ (never TEL's root files);
 *   - TEL constants the RPC scanners depend on are unchanged;
 *   - workflow commit paths: identical for TEL, public/data/<slug>/** otherwise;
 *   - the gated wallet-flows generator resolves under data/<slug>/forensics/.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
  projectChains,
  projectClassificationRelPath,
  projectWork,
  projectWorkDir,
  projectWorkPath,
  resolveProject,
} from "./projects.js";
import { resolveStakeChangedTarget } from "./stakerTarget.js";
import { exchangeFlowChains } from "./exchangeFlowChains.js";
import { mapWorkflowFiles, workflowPaths } from "../workflow-paths.js";

const repo = path.resolve(".");
const tel = resolveProject("tel", repo);
const X = (c) => `0x${c.repeat(40)}`;

const DEMO = {
  slug: "demo",
  name: "Demo",
  ticker: "DMO",
  supply: { target: 1_000_000 },
  chains: [
    { key: "ethereum", name: "Ethereum", chainId: 1, origin: true, fromBlock: 123, explorer: "https://etherscan.io",
      tokens: [{ generation: "v1", address: X("a"), decimals: 18, deployBlock: 120 }] },
    { key: "arbitrum", name: "Arbitrum", chainId: 42161, explorer: "https://arbiscan.io", blocksPerDay: 345600,
      tokens: [{ generation: "v1", address: X("b"), decimals: 6, deployBlock: 77 }] },
  ],
  classification: {
    exclusions: "config/projects/demo/exclusions.json",
    cexWallets: "config/projects/demo/cex-wallets.json",
    changelog: "config/projects/demo/classification-changelog.json",
  },
};
// "bare" declares no classification files at all.
const BARE = { slug: "bare", name: "Bare", ticker: "BRE", supply: { target: 5 }, chains: DEMO.chains.slice(0, 1) };

let tmp;
const write = (rel, obj) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), typeof obj === "string" ? obj : JSON.stringify(obj));
};
const read = (rel) => JSON.parse(fs.readFileSync(path.join(tmp, rel), "utf8"));
const exists = (rel) => fs.existsSync(path.join(tmp, rel));
// Scripts log OS-native paths; assertions match posix paths, so normalize the output.
const posixOutput = (text) => text.split(path.sep).join("/");
const run = (script, args = []) => {
  const r = spawnSync(process.execPath, [path.join(repo, "scripts", script), ...args], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, HD_PROJECT: "" },
  });
  return { ...r, stdout: posixOutput(r.stdout), stderr: posixOutput(r.stderr) };
};
// Every file under public/data/ and data/ that is NOT inside <slug>/.
const rootLeaks = (slug) => {
  const out = [];
  for (const base of ["public/data", "data"]) {
    const dir = path.join(tmp, base);
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name === slug) continue;
      out.push(`${base}/${e.name}`);
    }
  }
  return out;
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-ports-"));
  write("config/projects.json", { projects: [
    { slug: "tel", name: "Telcoin", ticker: "TEL", default: true },
    { slug: "demo", name: "Demo", ticker: "DMO" },
    { slug: "bare", name: "Bare", ticker: "BRE" },
  ] });
  write("config/projects/tel.json", { slug: "tel", ticker: "TEL", data: { legacyRoot: true }, chains: [] });
  write("config/projects/demo.json", DEMO);
  write("config/projects/bare.json", BARE);
  write("config/projects/demo/exclusions.json", { addresses: [X("d")], labels: {} });
  write("config/projects/demo/cex-wallets.json", { wallets: [{ address: X("e"), label: "DemoEx", walletName: "DemoEx 1" }] });
  write("config/projects/demo/classification-changelog.json", {
    schemaVersion: 1,
    events: [{ id: "e1", date: "2026-10-01", type: "manual", summary: "demo", affects: { artifacts: [] } }],
  });
  write("public/data/demo/tel-holders.json", {
    generatedAt: "2026-10-24T00:00:00Z", chainOrder: ["ethereum", "arbitrum"], chains: {}, combined: {}, source: "fixture",
    wallets: [
      { address: X("1"), ethereum_balance: 600_000, arbitrum_balance: 0, total_balance: 600_000 },
      { address: X("e"), ethereum_balance: 300_000, arbitrum_balance: 0, total_balance: 300_000 },
    ],
  });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("per-project working files (data/)", () => {
  it("TEL keeps data/ exactly", () => {
    expect(projectWorkDir(tel)).toBe("data");
    expect(projectWorkPath(tel, "holders-asof-blocks.json", repo)).toBe(path.join(repo, "data/holders-asof-blocks.json"));
    const work = projectWork(tel, repo);
    expect(work("tier-outflows-days.json")).toBe(path.join(repo, "data/tier-outflows-days.json"));
    expect(work.rel("rebuild-transfers-polygon.ndjson")).toBe("data/rebuild-transfers-polygon.ndjson");
    expect(work.dir).toBe(path.join(repo, "data"));
  });

  it("a non-legacy project gets data/<slug>/ and cannot escape it", () => {
    const demo = resolveProject("demo", tmp);
    expect(projectWorkDir(demo)).toBe("data/demo");
    expect(projectWork(demo, tmp).rel("cex-candidates.json")).toBe("data/demo/cex-candidates.json");
    expect(() => projectWorkPath(demo, "../tier-outflows-days.json", tmp)).toThrow();
    expect(() => projectWorkPath(demo, "/etc/passwd", tmp)).toThrow();
  });

  it("per-project transfer caches stay gitignored like TEL's", () => {
    const r = spawnSync("git", ["check-ignore", "data/demo/rebuild-transfers-ethereum.ndjson", "data/demo/asof-window-1-2.ndjson",
      "data/demo/rebuild-transfers-base.json", "data/rebuild-transfers-polygon.ndjson"], { cwd: repo, encoding: "utf8" });
    expect(r.stdout.trim().split("\n")).toHaveLength(4);
  });
});

describe("TEL constants the RPC scanners use are unchanged", () => {
  it("exchange-flow table: same chains, divisor 100 (TEL 2 decimals)", () => {
    const flows = exchangeFlowChains(tel, projectChains(tel, repo), {});
    expect(Object.keys(flows)).toEqual(["ethereum", "polygon", "base"]);
    for (const c of Object.values(flows)) expect(c.divisor).toBe(100);
  });
  it("tier-outflows: chains ethereum/polygon/base all at 2 decimals", () => {
    const chains = projectChains(tel, repo);
    for (const k of ["ethereum", "polygon", "base"]) expect(Number(chains[k].decimals)).toBe(2);
  });
  it("StakeChanged contract (tier-outflows / rebuild-history) is the Polygon staking contract", () => {
    const t = resolveStakeChangedTarget(tel, repo);
    expect(t.chain).toBe("polygon");
    expect(t.contract).toBe("0x92e43aec69207755cb1e6a8dc589aae630476330");
  });
  it("classification rel paths are the config/ root files", () => {
    expect(projectClassificationRelPath(tel, "cexWallets", repo)).toBe("config/cex-wallets.json");
    expect(projectClassificationRelPath(tel, "changelog", repo)).toBe("config/classification-changelog.json");
  });
});

describe("ported scripts end to end for a non-legacy project (fixture repo, no network)", () => {
  it("sync-classification-changelog copies the project's own changelog", () => {
    const r = run("sync-classification-changelog.js", ["--project", "demo"]);
    expect(r.status, r.stderr).toBe(0);
    expect(read("public/data/demo/classification-changelog.json").events.map((e) => e.id)).toEqual(["e1"]);
    expect(rootLeaks("demo")).toEqual([]);
  });

  it("pull-cex-wallets publishes the project's own CEX list", () => {
    const r = run("pull-cex-wallets.js", ["--project", "demo"]);
    expect(r.status, r.stderr).toBe(0);
    const out = read("public/data/demo/cex-wallets.json");
    expect(out.wallets.map((w) => w.address)).toEqual([X("e")]);
    expect(out.source.configPath).toBe("config/projects/demo/cex-wallets.json");
    expect(exists("public/data/demo/cex-flows.json")).toBe(true);
    expect(rootLeaks("demo")).toEqual([]);
  });

  it("resync-chain-holders uses the project's non-retail set and data dir", () => {
    const r = run("resync-chain-holders.js", ["--project", "demo"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/exclusions 1, CEX config 1, DEX config 0/);
    expect(exists("public/data/demo/holders-summary.json")).toBe(true);
    expect(rootLeaks("demo")).toEqual([]);
  });

  it("validate-outputs checks public/data/<slug>/, not TEL's root", () => {
    const r = run("validate-outputs.js", ["--project", "demo"]);
    expect(r.status).toBe(1); // holders-history / holders-lite not generated in this fixture
    expect(r.stdout).toMatch(/OK {3}tel-holders\.json/);
    expect(r.stdout).toMatch(/OK {3}cex-wallets\.json/);
    expect(r.stderr).toMatch(/public\/data\/demo\/holders-lite\.json/);
  });

  it("check-feed-consistency reads the project's dir (fails on its missing feeds, not TEL's)", () => {
    const r = run("check-feed-consistency.js", ["--project", "demo"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/public\/data\/demo\//);
    expect(r.stderr).not.toMatch(/public\/data\/(?!demo\/)[a-z-]+\.json/);
  });

  it("a project with no classification files gets empty lists, never TEL's", () => {
    const c = run("pull-cex-wallets.js", ["--project", "bare"]);
    expect(c.status, c.stderr).toBe(0);
    expect(read("public/data/bare/cex-wallets.json").wallets).toEqual([]);
    const s = run("sync-classification-changelog.js", ["--project", "bare"]);
    expect(s.status, s.stderr).toBe(0);
    expect(read("public/data/bare/classification-changelog.json").events).toEqual([]);
    expect(rootLeaks("demo").filter((p) => p !== "public/data/bare")).toEqual([]);
  });

  it("sync-cex-wallets-dune refuses a project without a CEX file or Dune query (exit 2, no network)", () => {
    const r = run("sync-cex-wallets-dune.js", ["--project", "bare"]);
    expect(r.status).toBe(2);
  });

  it("sync-cex-wallets-dune --source spellbook is candidates-only and Solana-only (exit 2, no network)", () => {
    expect(run("sync-cex-wallets-dune.js", ["--project", "demo", "--source", "spellbook"]).status).toBe(2);
    expect(run("sync-cex-wallets-dune.js", ["--project", "bare", "--candidates", "--source", "spellbook"]).status).toBe(2);
  });

  it("generate-wallet-flows runs for demo: no forensics registry = skip before any RPC (exit 0, nothing written)", () => {
    const r = run("generate-wallet-flows.js", ["--project", "demo"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/no registry at data\/demo\/forensics\/wallet-flows\.registry\.json/);
    expect(exists("data/demo/forensics/wallet-flows.json")).toBe(false);
    expect(exists("data/forensics")).toBe(false);
  });
});

describe("ported scripts carry no TEL-root path literals", () => {
  const PORTED = [
    "append-exchange-flows-from-cache", "check-feed-consistency", "detect-cex-candidates", "extend-transfer-caches",
    "fill-history-gaps", "generate-holder-transitions", "generate-tier-outflows", "pull-cex-wallets",
    "rebuild-history-from-logs", "recompute-history-from-git", "resync-chain-holders", "sync-cex-wallets-dune",
    "sync-classification-changelog", "validate-outputs", "pull-holders-rpc", "generate-holders-lite",
    "generate-wallet-flows",
  ];
  // Strip comments (block + line) so documentation may still name the TEL files.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const BAD = [
    /["'`]public\/data\//,
    /["'`]config\/(chains|exclusions|cex-wallets|dex-contracts|classification-changelog)\.json/,
    /["'`]data\//,
    /path\.join\(\s*["'`]data["'`]/,
    /["'`]public["'`]\s*,\s*["'`]data["'`]/,
  ];
  for (const name of PORTED) {
    it(`${name}.js`, () => {
      const src = code(fs.readFileSync(path.join(repo, "scripts", `${name}.js`), "utf8"));
      expect(src).toMatch(/ported:\s*true/);
      for (const re of BAD) expect(src, `${re}`).not.toMatch(re);
    });
  }
});

describe("workflow commit paths (scripts/workflow-paths.js)", () => {
  const TEL_FILES = ["public/data/tier-outflows.json", "data/tier-outflows-days.json", "config/cex-wallets.json", "public/data/nope.json"];

  it("TEL: the file list is returned unchanged (byte-identical git add)", () => {
    expect(mapWorkflowFiles(tel, TEL_FILES, repo)).toEqual(TEL_FILES);
    expect(workflowPaths(tel, repo)).toEqual({
      HD_PROJECT_SLUG: "tel", HD_LEGACY_ROOT: "true", HD_DATA_DIR: "public/data", HD_WORK_DIR: "data",
      HD_CEX_CONFIG: "config/cex-wallets.json",
    });
  });

  it("non-TEL: maps into public/data/<slug>/ and data/<slug>/, drops missing files, adds the slug dir", () => {
    const demo = resolveProject("demo", tmp);
    write("data/demo/tier-outflows-days.json", "{}");
    write("public/data/demo/tier-outflows.json", "{}");
    expect(mapWorkflowFiles(demo, TEL_FILES, tmp)).toEqual([
      "public/data/demo/tier-outflows.json",
      "data/demo/tier-outflows-days.json",
      "config/projects/demo/cex-wallets.json",
      "public/data/demo",
    ]);
    expect(workflowPaths(demo, tmp)).toMatchObject({ HD_DATA_DIR: "public/data/demo", HD_WORK_DIR: "data/demo", HD_LEGACY_ROOT: "false" });
    const bare = resolveProject("bare", tmp);
    expect(mapWorkflowFiles(bare, ["config/cex-wallets.json"], tmp)).toEqual(["public/data/bare"]);
    expect(() => mapWorkflowFiles(demo, ["netlify.toml"], tmp)).toThrow(/shared with TEL/);
    expect(() => mapWorkflowFiles(demo, ["public/data/../x.json"], tmp)).toThrow();
  });

  it("CLI files mode: TEL echoes, demo maps", () => {
    const t = run("workflow-paths.js", ["files", "public/data/a.json", "data/b.json"]);
    expect(t.status, t.stderr).toBe(0);
    expect(t.stdout.trim()).toBe("public/data/a.json data/b.json");
    const d = run("workflow-paths.js", ["--project", "demo", "files", "public/data/tier-outflows.json"]);
    expect(d.status, d.stderr).toBe(0);
    expect(d.stdout.trim()).toBe("public/data/demo/tier-outflows.json public/data/demo");
    expect(run("workflow-paths.js", ["--project", "nope"]).status).toBe(2);
  });

  it("every data workflow stages through workflow-paths (no bare public/data git add left)", () => {
    const dir = path.join(repo, ".github/workflows");
    const COMMITTING = [
      "detect-cex-candidates", "fill-history-gaps", "generate-tier-outflows", "pipeline-watchdog", "rebuild-holders-history",
      "recompute-holders-history", "refresh-staker-balances", "refresh-tel-holders", "refresh-zebec-network", "scan-exchange-flows",
      "sync-cex-wallets",
    ];
    for (const name of COMMITTING) {
      const src = fs.readFileSync(path.join(dir, `${name}.yml`), "utf8");
      expect(src, name).toMatch(/node scripts\/workflow-paths\.js >> "\$GITHUB_ENV"/);
      expect(src, name).toMatch(/workflow-paths\.js files /);
      expect(src, name).not.toMatch(/git add (-A -- )?(public\/)?data\//);
      expect(src, name).not.toMatch(/FILES(_TO_CHECK)?="[^"]*public\/data\//);
      expect(src, name).not.toMatch(/only TEL is pipeline-ready today/);
    }
  });
});
