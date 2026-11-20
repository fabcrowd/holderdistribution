import { describe, it, expect } from "vitest";
import { diffFiles, mismatchIssue } from "./store-compare.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

describe("diffFiles", () => {
  it("reports changed and missing files and nothing for equal ones", async () => {
    const stored = { "public/data/a.json": H1, "public/data/b.json": H2 };
    const diffs = await diffFiles({ "public/data/b.json": H1, "public/data/a.json": H1, "public/data/c.json": H2 }, async (p) => stored[p] ?? null);
    expect(diffs).toEqual([
      { path: "public/data/b.json", expected: H1, actual: H2 },
      { path: "public/data/c.json", expected: H2, actual: null },
    ]);
  });

  it("is empty when every file matches", async () => {
    expect(await diffFiles({ "x.json": H1 }, async () => H1)).toEqual([]);
  });
});

describe("mismatchIssue", () => {
  it("is an error that names the coin and caps the list of files", () => {
    const diffs = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.json`, expected: H1, actual: i === 0 ? null : H2 }));
    const issue = mismatchIssue("tel", "holders", diffs, 20);
    expect(issue).toMatchObject({ code: "store-file-mismatch", severity: "error", slug: "tel" });
    expect(issue.title).toBe("holders tel: 12 of 20 files differ between the store and the generated files");
    expect(issue.detail).toContain("f0.json (missing from the store)");
    expect(issue.detail).toContain("and 2 more");
  });
});
