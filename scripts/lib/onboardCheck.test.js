import { describe, expect, it } from "vitest";
import { gatePlan, logPathFor, summarize } from "./onboardCheck.js";

describe("gatePlan", () => {
  it("runs the six gates in order, the project one with strict alignment", () => {
    const plan = gatePlan({ slug: "foo" });
    expect(plan.map((g) => g.id)).toEqual(["vitest", "typecheck", "lint", "feed-consistency", "pipeline-health", "go-live"]);
    expect(plan.at(-1).args).toEqual(["scripts/check-go-live.js", "--project", "foo", "--alignment", "strict"]);
  });

  it("--skip-tests drops vitest, typecheck and lint only", () => {
    expect(gatePlan({ slug: "foo", skipTests: true }).map((g) => g.id)).toEqual(["feed-consistency", "pipeline-health", "go-live"]);
  });
});

describe("summarize", () => {
  it("exits 0 when every gate passed", () => {
    const { exitCode, text } = summarize([{ id: "lint", status: 0, log: logPathFor("foo", "lint") }]);
    expect(exitCode).toBe(0);
    expect(text).toContain("PASS  lint");
  });

  it("exits 1, names the failed gates and their logs", () => {
    const { exitCode, text } = summarize([
      { id: "lint", status: 0, log: "a.log" },
      { id: "go-live", status: 1, log: "tasks/onboard-check-foo-go-live.log" },
    ]);
    expect(exitCode).toBe(1);
    expect(text).toContain("FAIL  go-live  tasks/onboard-check-foo-go-live.log");
    expect(text).toContain("1 of 2 gates failed: go-live");
  });
});
