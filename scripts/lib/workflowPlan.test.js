import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProject } from "./projects.js";
import { workflowMatrix, workflowPlan, DEFAULT_TIMEOUT_MINUTES } from "../workflow-paths.js";

/**
 * The registry-driven refresh (.github/workflows/refresh-tel-holders.yml) takes
 * its project list and every per-project stage difference from these helpers,
 * so onboarding a token is config only (docs/MULTI-TOKEN.md "Onboarding").
 */
const repo = path.resolve(".");

describe("workflowMatrix", () => {
  it("all: every registered project, default (TEL) first, with its configured timeout", () => {
    const { include, skipped } = workflowMatrix("all", repo);
    expect(skipped).toEqual([]);
    expect(include.map((p) => p.slug)).toEqual(["tel", "zebec-network"]);
    const configured = include.map((p) => resolveProject(p.slug, repo).config?.pipeline?.workflowTimeoutMinutes);
    expect(include.map((p) => p.timeout)).toEqual(configured);
    expect(include[0].ticker).toBe("TEL");
  });

  it("empty or missing selection means all (scheduled runs have no inputs)", () => {
    expect(workflowMatrix("", repo).include).toHaveLength(2);
    expect(workflowMatrix(undefined, repo).include).toHaveLength(2);
  });

  it("a slug selects exactly that project; an unknown slug throws", () => {
    expect(workflowMatrix("zebec-network", repo).include.map((p) => p.slug)).toEqual(["zebec-network"]);
    expect(() => workflowMatrix("nope", repo)).toThrow(/unknown project "nope"/);
  });

  it("a broken project config is skipped under all (never blocks the others) but fails when named", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-matrix-"));
    try {
      fs.mkdirSync(path.join(tmp, "config/projects"), { recursive: true });
      fs.copyFileSync(path.join(repo, "config/projects.json"), path.join(tmp, "config/projects.json"));
      fs.copyFileSync(path.join(repo, "config/projects/tel.json"), path.join(tmp, "config/projects/tel.json"));
      // zebec-network is registered but its config file is missing here.
      const out = workflowMatrix("all", tmp);
      expect(out.include.map((p) => p.slug)).toEqual(["tel"]);
      expect(out.skipped.map((p) => p.slug)).toEqual(["zebec-network"]);
      expect(() => workflowMatrix("zebec-network", tmp)).toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to a default timeout when the project sets none", () => {
    expect(DEFAULT_TIMEOUT_MINUTES).toBe(60);
  });
});

describe("per-project timeouts", () => {
  it("are bounded so a stuck job cannot burn the Actions minute budget", () => {
    for (const p of workflowMatrix("all", repo).include) {
      expect(p.timeout).toBeGreaterThan(0);
      expect(p.timeout).toBeLessThanOrEqual(120);
    }
  });
});

describe("workflowPlan", () => {
  it("TEL: publishes (no skip tag), has EVM chains, verifies exactly the files the YAML used to list", () => {
    const plan = workflowPlan(resolveProject("tel", repo), repo);
    expect(plan.HD_TICKER).toBe("TEL");
    expect(plan.HD_COMMIT_TAG).toBe("");
    expect(plan.HD_HAS_EVM).toBe("true");
    expect(plan.HD_REQUIRED_FILES.split(" ").sort()).toEqual(
      [
        "funding-wallets.json", "tel-holders.json", "holders-summary.json", "holders-history.json", "cex-wallets.json",
        "cex-flows.json", "cex-balance-history.json", "holders-lite.json", "holders-checkpoint.json",
        "holder-transitions.json", "holders-ever-checkpoint.json", "supply-reconciliation.json", "treasury-history.json",
        "classification-changelog.json",
      ].sort(),
    );
  });

  it("zebec-network: [skip netlify], no EVM chains (no gap fill), Solana staking overlay, no funding-wallets", () => {
    const plan = workflowPlan(resolveProject("zebec-network", repo), repo);
    expect(plan.HD_COMMIT_TAG).toBe(" [skip netlify]");
    expect(plan.HD_HAS_EVM).toBe("false");
    const files = plan.HD_REQUIRED_FILES.split(" ");
    expect(files).toContain("solana-staking.json");
    expect(files).not.toContain("funding-wallets.json");
    expect(files).toEqual(expect.arrayContaining(["cex-wallets.json", "cex-flows.json", "cex-balance-history.json"]));
  });
});
