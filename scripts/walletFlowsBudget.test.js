import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const MIN_TAIL_MS = 10 * 60_000; // receipt checks, 72h seller scan, balances, report write after the scan budget

// The EVM wallet-flows scan saves its progress per segment and stops itself at WALLET_FLOWS_MAX_MS.
// Without the budget, a state-reset rescan that does not fit in the job is killed and never converges.
const doc = parse(fs.readFileSync(path.join(WORKFLOWS_DIR, "refresh-wallet-flows.yml"), "utf8"));
const job = doc.jobs["wallet-flows"];
const step = job.steps.find((s) => /generate-wallet-flows\.js/.test(s.run ?? ""));

describe("refresh-wallet-flows EVM scan budget", () => {
  it("finds the EVM generator step (not the Solana one)", () => {
    expect(step?.id).toBe("evm");
    expect(step.run).not.toMatch(/solana/);
  });

  it("sets WALLET_FLOWS_MAX_MS with room for the tail before the step and job timeouts", () => {
    const budget = Number(step.env?.WALLET_FLOWS_MAX_MS);
    expect(Number.isFinite(budget) && budget > 0, "WALLET_FLOWS_MAX_MS must be set on the step").toBe(true);
    expect(budget + MIN_TAIL_MS).toBeLessThanOrEqual(Number(step["timeout-minutes"]) * 60_000);
    expect(Number(step["timeout-minutes"])).toBeLessThan(Number(job["timeout-minutes"]));
  });

  it("does not leak the EVM budget to the Solana step (it reads the same variable)", () => {
    expect(job.env?.WALLET_FLOWS_MAX_MS).toBeUndefined();
  });

  it("commits state after a partial run and skips only the go-live verify", () => {
    const commit = job.steps.find((s) => s.name === "Commit if changed");
    expect(commit.run).toContain("wallet-flows-evm-state.json");
    expect(String(commit.if)).toContain("steps.evm.outcome == 'failure'");
    const verify = job.steps.find((s) => s.name === "Verify report");
    expect(verify.if).toBe("steps.evm.outputs.partial != 'true' && steps.hedera.outputs.partial != 'true'");
  });

  it("the generator writes the report only after validation, and nothing else writes it", () => {
    const src = fs.readFileSync(path.resolve(WORKFLOWS_DIR, "..", "..", "scripts", "generate-wallet-flows.js"), "utf8");
    const writes = [...src.matchAll(/writeFile\(OUT\b/g)].map((m) => m.index);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBeGreaterThan(src.indexOf("validateWalletFlowsReport(report)"));
  });

  it("commits state whether a step that hit timeout-minutes is reported as failure or cancelled", () => {
    const commit = job.steps.find((s) => s.name === "Commit if changed");
    expect(String(commit.if)).toContain("success()");
    expect(String(commit.if)).toContain("steps.evm.outcome == 'failure'");
    expect(String(commit.if)).toContain("steps.evm.outcome == 'cancelled'");
  });

  it("flags every partial run and fails it when the published report is past the go-live age limit", () => {
    const names = job.steps.map((s) => s.name);
    const flag = job.steps.find((s) => s.name === "Flag partial run");
    expect(flag, "a Flag partial run step").toBeDefined();
    expect(names.indexOf("Flag partial run")).toBeGreaterThan(names.indexOf("Commit if changed"));
    expect(String(flag.if)).toContain("steps.evm.outputs.partial == 'true'");
    expect(flag.run).toContain("::warning");
    expect(flag.run).toContain("GITHUB_STEP_SUMMARY");
    expect(flag.run).toContain("::error");
    expect(flag.run).toContain("re-dispatch this workflow");
    expect(flag.run).toContain("process.exit(1)");
    // The limit comes from go-live, never a second constant; no report yet stays green.
    expect(flag.run).toContain("MAX_REPORT_AGE_HOURS");
    expect(flag.run).toContain("goLive.js");
    expect(flag.run).not.toMatch(/\b48\b/);
    expect(flag.run).toMatch(/!fs\.existsSync\(file\)[\s\S]*process\.exit\(0\)/);
  });
});

describe("refresh-wallet-flows Hedera scan", () => {
  const hedera = job.steps.find((s) => /generate-wallet-flows-hedera\.js/.test(s.run ?? ""));
  const names = job.steps.map((s) => s.name);

  it("runs only for a project with a Hedera chain, before the commit, with its own budget under the step timeout", () => {
    expect(hedera?.id).toBe("hedera");
    expect(String(hedera.if)).toContain("env.HD_HEDERA_FLOWS == 'true'");
    expect(names.indexOf(hedera.name)).toBeLessThan(names.indexOf("Commit if changed"));
    const budget = Number(hedera.env?.HEDERA_WALLET_FLOWS_MAX_MS);
    expect(Number.isFinite(budget) && budget > 0).toBe(true);
    expect(budget + MIN_TAIL_MS).toBeLessThanOrEqual(Number(hedera["timeout-minutes"]) * 60_000);
    expect(job.env?.HEDERA_WALLET_FLOWS_MAX_MS).toBeUndefined();
  });

  it("commits its state after a partial, failed or cancelled run and flags a partial run like the EVM scan", () => {
    const commit = job.steps.find((s) => s.name === "Commit if changed");
    expect(commit.run).toContain("wallet-flows-hedera-state.json");
    for (const outcome of ["failure", "cancelled"]) expect(String(commit.if)).toContain(`steps.hedera.outcome == '${outcome}'`);
    expect(commit.env.PARTIAL).toContain("steps.hedera.outputs.partial == 'true'");
    expect(String(job.steps.find((s) => s.name === "Flag partial run").if)).toContain("steps.hedera.outputs.partial == 'true'");
  });

  it("does not rely on --strict: every non-complete end is a partial output or a non-zero exit", () => {
    expect(hedera.run).not.toContain("--strict");
    const src = fs.readFileSync(path.resolve(WORKFLOWS_DIR, "..", "..", "scripts", "generate-wallet-flows-hedera.js"), "utf8");
    expect(src).not.toMatch(/argv\.includes\("--strict"\)/);
    expect(src).toMatch(/\.catch\([\s\S]*process\.exitCode = 1;/);
    expect(src).not.toMatch(/process\.exitCode = [^1]/);
    expect(src.match(/"partial=true\\n"/g)).toHaveLength(1); // one writer, reached by announceIncomplete from every non-complete end
    expect(src.match(/announceIncomplete\(/g).length).toBeGreaterThanOrEqual(4);
  });

  it("a failed or cancelled Hedera step is committed as a partial run and flagged by the stale-report rule", () => {
    const commit = job.steps.find((s) => s.name === "Commit if changed");
    for (const outcome of ["failure", "cancelled"]) {
      expect(String(commit.env.PARTIAL)).toContain(`steps.hedera.outcome == '${outcome}'`);
      expect(String(job.steps.find((s) => s.name === "Flag partial run").if)).toContain(`steps.hedera.outcome == '${outcome}'`);
    }
    const flag = job.steps.find((s) => s.name === "Flag partial run");
    expect(String(flag.if)).toContain("!cancelled()");
    expect(flag.run).toContain("MAX_REPORT_AGE_HOURS");
    expect(commit.run).toContain("Advance wallet-flows scan state (partial)");
  });

  it("the generator writes the report only after validation and only from a complete scan", () => {
    const src = fs.readFileSync(path.resolve(WORKFLOWS_DIR, "..", "..", "scripts", "generate-wallet-flows-hedera.js"), "utf8");
    const writes = src.split("writeAtomic(outFile").length - 1;
    expect(writes).toBe(1);
    expect(src.indexOf("writeAtomic(outFile")).toBeGreaterThan(src.indexOf("validateWalletFlowsReport(report"));
    expect(src.indexOf("writeAtomic(outFile")).toBeGreaterThan(src.indexOf("if (!state.complete)"));
  });
});
