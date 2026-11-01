import { describe, expect, it } from "vitest";
import { buildReceipt, parseStatusPorcelain } from "./changeReceipt.js";

describe("parseStatusPorcelain", () => {
  it("maps porcelain lines to status and path", () => {
    const text = " M src/App.tsx\n?? scripts/lib/new.js\nA  docs/x.md\n";
    expect(parseStatusPorcelain(text)).toEqual([
      { status: "modified", path: "src/App.tsx" },
      { status: "untracked", path: "scripts/lib/new.js" },
      { status: "added", path: "docs/x.md" },
    ]);
  });

  it("returns an empty list for a clean tree", () => {
    expect(parseStatusPorcelain("")).toEqual([]);
  });
});

describe("buildReceipt", () => {
  const base = {
    objective: "Add harness conventions",
    branch: "main",
    head: "9fa8277",
    changed: [{ status: "modified", path: "CLAUDE.md" }],
    diffStat: " CLAUDE.md | 2 +-",
    generatedAt: "2026-10-31T12:00:00Z",
  };

  it("states that no checks ran when none were recorded", () => {
    const out = buildReceipt({ ...base, checks: [] });
    expect(out).toContain("## NOT VERIFIED");
    expect(out).toContain("No checks were run");
    expect(out).toContain("## VERIFIED\n- none");
  });

  it("lists passing checks under VERIFIED and failing ones under FAILED", () => {
    const out = buildReceipt({
      ...base,
      checks: [
        { name: "typecheck", ok: true, summary: "exit 0" },
        { name: "check:feeds", ok: false, summary: "exit 1: holders drop 3%" },
      ],
    });
    expect(out).toContain("- PASS typecheck: exit 0");
    expect(out).toContain("- FAIL check:feeds: exit 1: holders drop 3%");
  });

  it("records git facts, uncommitted state and approval needs", () => {
    const out = buildReceipt({
      ...base,
      checks: [],
      unverified: ["production deploy"],
      approvalNeeded: ["git commit"],
    });
    expect(out).toContain("Branch: main @ 9fa8277");
    expect(out).toContain("Commits made in this run: none");
    expect(out).toContain("1 uncommitted change(s)");
    expect(out).toContain("- production deploy");
    expect(out).toContain("- git commit");
  });

  it("marks an empty approval list explicitly", () => {
    const out = buildReceipt({ ...base, checks: [] });
    expect(out).toContain("## APPROVAL NEEDED\n- none");
  });
});

describe("summarizeOutput", () => {
  it("strips ANSI colour codes and prefers the test-count line", async () => {
    const { summarizeOutput } = await import("./changeReceipt.js");
    const raw = "\u001b[31m ⎯⎯⎯⎯ \u001b[39m\n Tests  \u001b[1m1500 passed\u001b[22m\n";
    expect(summarizeOutput(raw)).toBe("Tests  1500 passed");
  });

  it("falls back to the last non-empty line", async () => {
    const { summarizeOutput } = await import("./changeReceipt.js");
    expect(summarizeOutput("building\n\nall good\n")).toBe("all good");
  });

  it("returns an empty string for empty output", async () => {
    const { summarizeOutput } = await import("./changeReceipt.js");
    expect(summarizeOutput("")).toBe("");
  });
});

describe("summarizeOutput signal selection", () => {
  it("does not treat a test name containing 'errors' as the result", async () => {
    const { summarizeOutput } = await import("./changeReceipt.js");
    const raw = " Tests  1500 passed (1500)\nstderr | falls back on upstream errors and timeouts\n";
    expect(summarizeOutput(raw)).toBe("Tests  1500 passed (1500)");
  });
});

describe("summarizeOutput prefers the test summary over later stderr", () => {
  it("returns the Tests count even when a retry message follows it", async () => {
    const { summarizeOutput } = await import("./changeReceipt.js");
    const raw = " Tests  10 passed (10)\n alchemy network error: fetch failed — retrying in 60000ms\n";
    expect(summarizeOutput(raw)).toBe("Tests  10 passed (10)");
  });
});
