import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { jobEnv, loadNightlyJobs, nightlyPlan, projectOutputPath, jobStatusFor } from "./nightlyPlan.js";
import { workflowMatrix } from "../workflow-paths.js";
import { loadRegistry, resolveProject } from "./projects.js";

describe("nightly job list (config/nightly-jobs.json)", () => {
  const jobs = loadNightlyJobs();

  it("every job declares a dataset, providers, a budget and a workflow that exists", () => {
    for (const j of jobs) {
      expect(j.dataset, j.id).toBeTruthy();
      expect(Array.isArray(j.providers) && j.providers.length > 0, j.id).toBe(true);
      expect(Number.isFinite(j.alchemyCuPerNight), j.id).toBe(true);
      expect(["enforce", "warn"]).toContain(j.budgetMode);
      expect(fs.existsSync(`.github/workflows/${j.workflow}`), j.workflow).toBe(true);
      for (const o of j.outputs ?? []) expect(o.maxAgeHours, `${j.id} ${o.path}`).toBeGreaterThan(0);
    }
  });

  it("alchemy is always the last resort, and only alchemyOnly jobs have no free provider", () => {
    for (const j of jobs) {
      if (j.providers.includes("alchemy")) expect(j.providers.at(-1), j.id).toBe("alchemy");
      const free = j.providers.filter((p) => p !== "alchemy");
      expect(free.length === 0, j.id).toBe(j.alchemyOnly === true);
    }
  });

  it("the ledger spends no Alchemy CU by default (public first, 0 CU, enforced)", () => {
    const l = jobs.find((j) => j.id === "ledger");
    expect(l.providers[0]).toBe("public");
    expect(l.alchemyCuPerNight).toBe(0);
    expect(l.budgetMode).toBe("enforce");
  });
});

describe("parity: every project produces every data set", () => {
  const plan = nightlyPlan();
  const datasets = [...new Set(plan.jobs.map((j) => j.dataset))];

  for (const p of plan.projects) {
    it(`${p.slug}: config loads`, () => expect(p.error).toBeUndefined());
    for (const ds of datasets) {
      it(`${p.slug}: data set "${ds}" runs or is waived with a reason`, () => {
        const covering = plan.jobs.filter((j) => j.dataset === ds).map((j) => p.jobs.find((x) => x.id === j.id));
        const ok = covering.some((s) => s.status === "run" || (s.status === "waived" && s.reason.trim().length > 10));
        expect(ok, `${p.slug} ${ds}: ${JSON.stringify(covering)}`).toBe(true);
      });
    }
  }

  it("a waiver without a reason is rejected", () => {
    const project = { slug: "x", config: { nightly: { waivers: { ledger: "" } } } };
    expect(() => jobStatusFor({ id: "ledger", requires: [] }, project, new Set())).toThrow(/reason/);
  });
});

describe("matrices come from the plan", () => {
  it("--job keeps only the projects that run the job; a named slug always runs", () => {
    const all = loadRegistry().map((p) => p.slug);
    const plan = nightlyPlan();
    for (const job of plan.jobs) {
      const want = plan.projects.filter((p) => p.jobs.find((j) => j.id === job.id)?.status === "run").map((p) => p.slug);
      expect(workflowMatrix("all", process.cwd(), { job: job.id }).include.map((e) => e.slug).sort()).toEqual([...want].sort());
    }
    expect(workflowMatrix(all[0], process.cwd(), { job: "cex-candidates" }).include).toHaveLength(1);
    expect(workflowMatrix("all").include.map((e) => e.slug)).toEqual(workflowMatrix("all", process.cwd(), { job: "holders" }).include.map((e) => e.slug));
  });

  it("scheduled data workflows no longer hardcode TEL", () => {
    for (const f of ["refresh-wallet-flows.yml", "detect-cex-candidates.yml", "sync-cex-wallets.yml", "refresh-ledger.yml", "refresh-tel-holders.yml"]) {
      const y = fs.readFileSync(`.github/workflows/${f}`, "utf8");
      expect(y, f).not.toMatch(/inputs\.project \|\| 'tel'/);
      expect(y, f).not.toMatch(/\["tel"/);
      expect(y, f).toMatch(/--job [a-z-]+/);
    }
  });

  it("jobEnv exports provider order and budget for the rpc.js guard", () => {
    expect(jobEnv("history-gaps")).toMatchObject({ HD_JOB_ID: "history-gaps", HD_JOB_PROVIDERS: "alchemy", HD_JOB_ALCHEMY_ONLY: "true" });
  });

  it("output paths map like workflow-paths files mode; {slug} is per-project for TEL too", () => {
    const tel = resolveProject("tel");
    const z = resolveProject("zebec-network");
    expect(projectOutputPath(tel, "public/data/a.json")).toBe("public/data/a.json");
    expect(projectOutputPath(z, "public/data/a.json")).toBe("public/data/zebec-network/a.json");
    expect(projectOutputPath(z, "data/forensics/w.json")).toBe("data/zebec-network/forensics/w.json");
    expect(projectOutputPath(tel, "data/{slug}/ledger/ledger.json")).toBe("data/tel/ledger/ledger.json");
  });
});
