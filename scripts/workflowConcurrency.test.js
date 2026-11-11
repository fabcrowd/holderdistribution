import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOWS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
);
const SHARED_GROUP = "holders-refresh";

// A workflow that pushes to main without the shared group can race another
// writer on the same public/data files and hit a rebase conflict. GitHub keeps
// only ONE pending run per group, so a scheduled run queued behind a long job
// is silently cancelled by a newer arrival. Those workflows stay out of the
// group, and each exemption below states why.
const ALLOWLIST = {
  "strip-dead-rpc-key.yml":
    "one-shot manual dispatch that edits only .env.enc",
  "onboard-project.yml":
    "dispatches and waits on holders-refresh workflows, so joining that group would deadlock; it pushes only config edits through push-main.sh's rebase-retry",
  "detect-cex-candidates.yml":
    "weekly cron (Sunday 02:00 UTC); behind a long run it would be replaced as pending by the 06:00 refresh and dropped for a week",
};

const WRITES_MAIN = /push-main\.sh|git(\s+-C\s+\S+)?\s+push/;

function writesMain(text) {
  const code = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  return WRITES_MAIN.test(code);
}

const workflowFiles = fs
  .readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith(".yml"))
  .sort();

describe("workflow concurrency for main writers", () => {
  it("finds workflows to check", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  for (const file of workflowFiles) {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
    if (!writesMain(text)) continue;

    if (file in ALLOWLIST) {
      it(`${file} is allowlisted: ${ALLOWLIST[file]}`, () => {
        expect(ALLOWLIST[file].length).toBeGreaterThan(0);
      });
      continue;
    }

    it(`${file} uses concurrency group ${SHARED_GROUP}`, () => {
      const doc = parse(text);
      expect(doc.concurrency?.group).toBe(SHARED_GROUP);
      expect(doc.concurrency["cancel-in-progress"]).toBe(false);
    });
  }

  it("writer detection ignores comment lines", () => {
    expect(writesMain("# bash scripts/push-main.sh\n  - run: echo hi")).toBe(false);
    expect(writesMain("  - run: bash scripts/push-main.sh")).toBe(true);
  });

  it("writer detection matches git -C <dir> push", () => {
    expect(writesMain("  - run: git -C repo push origin HEAD:main")).toBe(true);
  });

  it("allowlist has no stale entries", () => {
    for (const file of Object.keys(ALLOWLIST)) {
      expect(workflowFiles).toContain(file);
    }
  });
});
