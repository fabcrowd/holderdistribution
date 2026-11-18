// Data check (npm run check:data): moved unchanged from scripts/lib/trackedFileSizes.test.js.
// Runs for every --project: it guards the whole tracked tree, which every per-project nightly commits to.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SNAPSHOT_FAIL_BYTES } from "../lib/snapshotFormat.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("tracked data files", () => {
  it("none reaches the size the snapshot writer refuses (GitHub rejects 100 MiB)", () => {
    const files = execFileSync("git", ["ls-files", "-z", "public/data", "data"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const offenders = [];
    for (const file of files) {
      let size;
      try {
        size = fs.statSync(path.join(ROOT, file)).size;
      } catch {
        continue;
      }
      if (size >= SNAPSHOT_FAIL_BYTES) offenders.push(`${file} (${(size / 1024 / 1024).toFixed(2)} MiB)`);
    }
    expect(offenders, `Tracked files at or above ${SNAPSHOT_FAIL_BYTES / 1024 / 1024} MiB: ${offenders.join(", ")}`).toEqual([]);
  });
});
