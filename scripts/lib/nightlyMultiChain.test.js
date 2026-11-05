/**
 * Multi-chain projects (EVM + Solana) through the nightly plan, provider order,
 * budget guard and status writer — and Solana never touches Alchemy.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main as addProject } from "../add-project.js";
import { jobEnv, nightlyPlan, providersFor } from "./nightlyPlan.js";
import { projectStatus } from "../write-pipeline-status.js";
import { __resetBudgetGuardForTests, __resetRpcMetricsForTests, alchemyBlocked, guardAlchemyCall, resolveJobEnv } from "./rpcMetrics.js";
import { solanaCallWithFailover, solanaRpcCandidates, __resetSolanaRpcForTests } from "./solana/rpc.js";
import { __resetRpcCachesForTests } from "./rpc.js";

const repo = path.resolve(import.meta.dirname, "../..");
const quiet = { log() {}, warn() {} };
const EVM = "0x" + "1f".repeat(20);
const MINT = "75hbt6uvDqjPZ9WgFtMhBnTeyHw7cinoHiz4FD2vEz2d";

function sandbox(chains, waivers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-mc-"));
  fs.cpSync(path.join(repo, "config"), path.join(root, "config"), { recursive: true });
  const inv = path.join(root, "inv.json");
  fs.writeFileSync(inv, JSON.stringify({ chains: chains.map(([key, addr]) => ({ chain: key, vm: key === "solana" ? "solana" : "evm", status: "configured", tokens: [{ address: addr }], source: "fixture" })) }));
  const argv = ["--slug", "multi", "--name", "Multi", "--ticker", "MLT", "--root", root, "--inventory", inv];
  for (const [key, addr, dec] of chains) argv.push("--chain", `${key}:${addr}:${dec}`);
  const cwd = process.cwd();
  process.chdir(root); // add-project resolves --inventory relative to cwd; plan reads root
  try {
    addProject(argv, { logger: quiet });
  } finally {
    process.chdir(cwd);
  }
  if (waivers) {
    const f = path.join(root, "config/projects/multi.json");
    const c = JSON.parse(fs.readFileSync(f, "utf8"));
    c.nightly = { waivers };
    fs.writeFileSync(f, JSON.stringify(c));
  }
  return root;
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  __resetRpcMetricsForTests();
  __resetBudgetGuardForTests();
  __resetSolanaRpcForTests?.();
  __resetRpcCachesForTests?.();
});

describe("multi-chain project (ethereum + base + solana)", () => {
  const root = sandbox([["ethereum", EVM, 18], ["base", EVM, 18], ["solana", MINT, 6]], { "cex-sync": "No Dune query for this token yet (test waiver)." });
  const plan = nightlyPlan(root);
  const p = plan.projects.find((x) => x.slug === "multi");

  it("gets both VMs' capabilities and every applicable job, plus per-project waivers", () => {
    expect(p.error).toBeUndefined();
    expect(p.capabilities).toEqual(expect.arrayContaining(["evm", "solana", "forensicsRegistry", "ledgerConfig"]));
    const st = Object.fromEntries(p.jobs.map((j) => [j.id, j.status]));
    expect(st).toMatchObject({ holders: "run", "solana-flows": "run", "tier-outflows": "run", "history-gaps": "run", ledger: "run", "wallet-flows": "run", "cex-candidates": "run", "cex-sync": "waived" });
  });

  it("keeps Alchemy (EVM chains) and Helius (Solana) in its provider lists, Alchemy last", () => {
    const holders = p.jobs.find((j) => j.id === "holders");
    expect(holders.providers).toEqual(["public", "helius", "alchemy"]);
    for (const j of p.jobs) if (j.providers.includes("alchemy")) expect(j.providers.at(-1)).toBe("alchemy");
  });

  it("status writer reports every job for the project (runs, waivers with reasons)", () => {
    const rep = projectStatus("multi", { root, plan });
    expect(rep.jobs.map((j) => j.id)).toEqual(plan.jobs.map((j) => j.id));
    expect(rep.jobs.find((j) => j.id === "cex-sync")).toMatchObject({ status: "waived", reason: expect.stringMatching(/Dune/) });
    expect(rep.jobs.find((j) => j.id === "holders").outputs[0].path).toBe("public/data/multi/holders-summary.json");
  });
});

describe("Solana never uses Alchemy", () => {
  const root = sandbox([["solana", MINT, 6]]);
  const plan = nightlyPlan(root);
  const p = plan.projects.find((x) => x.slug === "multi");

  it("a Solana-only project lists no 'alchemy' provider in any job, and alchemyOnly jobs do not run", () => {
    for (const j of p.jobs) expect(j.providers, j.id).not.toContain("alchemy");
    expect(p.jobs.find((j) => j.id === "history-gaps").status).not.toBe("run");
    expect(providersFor({ providers: ["public", "helius", "alchemy"] }, new Set(["solana"]))).toEqual(["public", "helius"]);
  });

  it("the same holds for the real Solana project (zebec-network) in this repo", () => {
    const z = nightlyPlan().projects.find((x) => x.slug === "zebec-network");
    for (const j of z.jobs) expect(j.providers, j.id).not.toContain("alchemy");
    for (const id of ["holders", "exchange-flows", "solana-flows", "solana-staking", "wallet-flows", "ledger"]) {
      expect(jobEnv(id, process.cwd(), "zebec-network")).toMatchObject({ HD_JOB_ALCHEMY_CU_BUDGET: "0", HD_JOB_BUDGET_MODE: "enforce" });
      expect(jobEnv(id, process.cwd(), "zebec-network").HD_JOB_PROVIDERS).not.toMatch(/alchemy/);
    }
  });

  it("the guard hard-blocks Alchemy for a project without an EVM chain, even in warn-mode jobs", () => {
    const env = { HD_JOB_ID: "holders", HD_HAS_EVM: "false" };
    expect(resolveJobEnv(env)).toMatchObject({ HD_JOB_PROVIDERS: "public,helius", HD_JOB_ALCHEMY_CU_BUDGET: "0", HD_JOB_BUDGET_MODE: "enforce" });
    expect(alchemyBlocked(env)).toBe(true);
    expect(() => guardAlchemyCall("eth_blockNumber", env)).toThrow(/budget/);
  });

  it("Solana RPC pools drop Alchemy URLs and the failover never calls one", async () => {
    process.env.SOLANA_RPC_0 = "https://solana-mainnet.g.alchemy.com/v2/fake";
    process.env.SOLANA_RPC_1 = "https://mainnet.helius-rpc.com/?api-key=fake";
    const cands = solanaRpcCandidates("solana");
    expect(cands.some((u) => /alchemy/.test(u))).toBe(false);
    expect(cands).toContain("https://mainnet.helius-rpc.com/?api-key=fake");
    const called = [];
    const r = await solanaCallWithFailover(["https://solana-mainnet.g.alchemy.com/v2/fake", "https://mainnet.helius-rpc.com/?api-key=fake"], "getSlot", [], { call: async (u) => (called.push(u), 1), logger: quiet });
    expect(r).toBe(1);
    expect(called).toEqual(["https://mainnet.helius-rpc.com/?api-key=fake"]);
  });
});
