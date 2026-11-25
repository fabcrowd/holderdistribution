// The jobs that commit a project's rpc-usage.json after waiting in the holders-refresh
// group start from the branch tip (not the commit that queued the run) and push through
// scripts/push-main.sh, which merges usage counters on its rebase. The ledger job started
// from the queued commit and conflicted on data/hedera/rpc-usage.json on 2026-11-21 and
// 2026-11-24 (run 45397815066).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOWS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const CASES = { "refresh-ledger.yml": "ledger", "refresh-wallet-flows.yml": "wallet-flows" };

const usageCommitJobs = (file) => {
  const doc = parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8"));
  return Object.entries(doc.jobs).filter(([, job]) => (job.steps ?? []).some((s) => /rpc-usage\.json/.test(s.run ?? "")));
};

describe("rpc-usage.json writers check out the branch tip and push through push-main.sh", () => {
  for (const [file, jobId] of Object.entries(CASES)) {
    it(`${file} job ${jobId}`, () => {
      const jobs = usageCommitJobs(file);
      expect(jobs.map(([id]) => id)).toEqual([jobId]);
      const steps = jobs[0][1].steps;
      const checkout = steps.find((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
      expect(checkout?.with?.ref).toBe("${{ github.ref }}");
      const commit = steps.find((s) => /rpc-usage\.json/.test(s.run ?? ""));
      expect(commit.run).toMatch(/bash scripts\/push-main\.sh/);
      expect(commit.run).not.toMatch(/git push|git rebase/);
    });
  }

  it("push-main.sh enables the rpc-usage merge driver per command and still aborts other conflicts", () => {
    const helper = fs.readFileSync(path.resolve(WORKFLOWS, "..", "..", "scripts", "push-main.sh"), "utf8");
    expect(helper).toContain("rpc-usage.json merge=rpc-usage");
    expect(helper).toContain("merge.rpc-usage.driver=node");
    expect(helper).toContain("core.attributesFile=");
    const code = helper.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/git config\s/);
    expect(helper).toMatch(/git rebase --abort/);
  });
});
