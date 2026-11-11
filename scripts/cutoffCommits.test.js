import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

// Scripts that resolve a missing day cutoff and save it to date-blocks.json (scripts/lib/dayBlocks.js).
const CUTOFF_WRITERS = /\b(pull-holders-rpc|scan-exchange-flows|generate-tier-outflows|fill-history-gaps|append-exchange-flows-from-cache|build-cutoffs)\.js\b/;

// A job that runs one of them and commits must stage date-blocks.json: the file is left
// modified otherwise, and the commit step's rebase stops on the unstaged change
// (generate-tier-outflows run 43021162173 scanned TEL and then failed to push).
const committingJobs = fs
  .readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith(".yml"))
  .flatMap((file) => {
    const doc = parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8"));
    return Object.entries(doc.jobs ?? {}).map(([jobId, job]) => {
      const runs = (job.steps ?? []).map((s) => s.run ?? "");
      return { file, jobId, writes: runs.some((r) => CUTOFF_WRITERS.test(r)), commits: runs.some((r) => /git commit/.test(r)), stages: runs.some((r) => /git add|FILES=/.test(r) && /date-blocks\.json/.test(r)) };
    });
  })
  .filter((j) => j.writes && j.commits);

describe("jobs that write day cutoffs commit them", () => {
  it("finds the nightly and the standalone scans", () => {
    expect(committingJobs.map((j) => j.file)).toEqual(expect.arrayContaining(["refresh-holders.yml", "generate-tier-outflows.yml", "scan-exchange-flows.yml"]));
  });

  for (const j of committingJobs) {
    it(`${j.file} ${j.jobId} stages date-blocks.json`, () => {
      expect(j.stages).toBe(true);
    });
  }
});
