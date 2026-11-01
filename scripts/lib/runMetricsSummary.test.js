import { describe, expect, it } from "vitest";
import { aggregateRuns, evaluateBudget, mergeUsage, monthToDate, parseNdjson, renderSummary } from "./runMetricsSummary.js";

const line = (o) => JSON.stringify({ script: "a.js", alchemyCu: 0, heliusCredits: 0, alchemyCalls: 0, heliusCalls: 0, publicCalls: 0, ...o });

describe("parseNdjson / aggregateRuns", () => {
  it("skips blank and truncated lines and sums the rest per script", () => {
    const text = [
      line({ script: "pull.js", alchemyCu: 100, alchemyCalls: 4 }),
      "",
      '{"script":"cut',
      line({ script: "pull.js", alchemyCu: 50, alchemyCalls: 2, publicCalls: 7 }),
      line({ script: "scan.js", heliusCredits: 30, heliusCalls: 30 }),
    ].join("\n");
    const agg = aggregateRuns(parseNdjson(text));
    expect(agg).toMatchObject({ runs: 3, alchemyCu: 150, heliusCredits: 30, alchemyCalls: 6, heliusCalls: 30, publicCalls: 7 });
    expect(agg.byScript["pull.js"]).toEqual({ processes: 2, alchemyCu: 150, heliusCredits: 0, publicCalls: 7 });
  });

  it("counts a process once per (script, pid) even when it flushed several lines", () => {
    const text = [line({ pid: 10, alchemyCu: 1 }), line({ pid: 10, alchemyCu: 2 }), line({ pid: 10, alchemyCu: 3 })].join("\n");
    const agg = aggregateRuns(parseNdjson(text));
    expect(agg).toMatchObject({ runs: 1, alchemyCu: 6 });
    expect(agg.byScript["a.js"]).toEqual({ processes: 1, alchemyCu: 6, heliusCredits: 0, publicCalls: 0 });
  });

  it("counts different pids of the same script as separate processes", () => {
    const text = [line({ pid: 10, alchemyCu: 1 }), line({ pid: 11, alchemyCu: 2 })].join("\n");
    const agg = aggregateRuns(parseNdjson(text));
    expect(agg.runs).toBe(2);
    expect(agg.byScript["a.js"].processes).toBe(2);
  });

  it("counts a pid shared by two scripts once per script", () => {
    const text = [line({ script: "a.js", pid: 10 }), line({ script: "b.js", pid: 10 })].join("\n");
    const agg = aggregateRuns(parseNdjson(text));
    expect(agg.runs).toBe(2);
    expect(agg.byScript["a.js"].processes).toBe(1);
    expect(agg.byScript["b.js"].processes).toBe(1);
  });

  it("counts lines without a pid one each", () => {
    const text = [line({ alchemyCu: 1 }), line({ alchemyCu: 2 }), line({ alchemyCu: 3 })].join("\n");
    const agg = aggregateRuns(parseNdjson(text));
    expect(agg).toMatchObject({ runs: 3, alchemyCu: 6 });
    expect(agg.byScript["a.js"].processes).toBe(3);
  });
});

describe("mergeUsage", () => {
  const agg = (cu) => aggregateRuns([JSON.parse(line({ alchemyCu: cu, alchemyCalls: 1 }))]);

  it("adds to an existing day and keeps a run counter", () => {
    const a = mergeUsage(null, "2026-11-01", agg(100));
    const b = mergeUsage(a, "2026-11-01", agg(50));
    expect(b.days["2026-11-01"]).toMatchObject({ runs: 2, alchemyCu: 150, alchemyCalls: 2 });
    expect(a.days["2026-11-01"].alchemyCu).toBe(100); // input not mutated
  });

  it("drops days older than the retention window", () => {
    const old = { schemaVersion: 1, days: { "2026-08-01": { runs: 1, alchemyCu: 1 }, "2026-10-20": { runs: 1, alchemyCu: 2 } } };
    const next = mergeUsage(old, "2026-11-01", agg(1), { keepDays: 62 });
    expect(Object.keys(next.days).sort()).toEqual(["2026-10-20", "2026-11-01"]);
  });
});

describe("monthToDate", () => {
  it("sums only the requested month across projects", () => {
    const a = { days: { "2026-10-31": { alchemyCu: 5 }, "2026-11-01": { alchemyCu: 10, heliusCredits: 3 } } };
    const b = { days: { "2026-11-01": { alchemyCu: 20 } } };
    expect(monthToDate([a, b], "2026-11")).toEqual({ alchemyCu: 30, heliusCredits: 3 });
  });
});

describe("evaluateBudget", () => {
  const budgets = { monthly: { alchemyCu: 1000, heliusCredits: 100 }, warnAt: 0.8, failAt: 1, perRunWarn: { alchemyCu: 500, heliusCredits: 50 } };

  it("is ok well under budget", () => {
    expect(evaluateBudget({ alchemyCu: 100, heliusCredits: 10 }, { alchemyCu: 10, heliusCredits: 1 }, budgets).level).toBe("ok");
  });

  it("warns at the warn threshold", () => {
    const e = evaluateBudget({ alchemyCu: 800, heliusCredits: 10 }, { alchemyCu: 10, heliusCredits: 1 }, budgets);
    expect(e.level).toBe("warn");
    expect(e.messages[0]).toMatchObject({ level: "warn" });
  });

  it("fails on the run that first crosses a monthly budget and says which provider", () => {
    const e = evaluateBudget({ alchemyCu: 10, heliusCredits: 120 }, { alchemyCu: 1, heliusCredits: 30 }, budgets);
    expect(e.level).toBe("fail");
    expect(e.messages.find((m) => m.level === "fail").text).toMatch(/Helius credits/);
  });

  it("fails when this run lands exactly on the fail threshold", () => {
    const e = evaluateBudget({ alchemyCu: 0, heliusCredits: 100 }, { alchemyCu: 0, heliusCredits: 10 }, budgets);
    expect(e.level).toBe("fail");
  });

  it("only warns, not fails, once the budget was already exceeded before this run", () => {
    const e = evaluateBudget({ alchemyCu: 10, heliusCredits: 130 }, { alchemyCu: 1, heliusCredits: 10 }, budgets);
    expect(e.level).toBe("warn");
    expect(e.messages.some((m) => m.level === "fail")).toBe(false);
    expect(e.messages.find((m) => m.text.includes("Helius credits")).text).toMatch(/still over budget/);
  });

  it("warns when a single run is unusually expensive even if the month is fine", () => {
    const e = evaluateBudget({ alchemyCu: 100, heliusCredits: 10 }, { alchemyCu: 600, heliusCredits: 1 }, budgets);
    expect(e.level).toBe("warn");
    expect(e.messages[0].text).toMatch(/this run used/);
  });

  it("ignores a provider with no budget", () => {
    expect(evaluateBudget({ alchemyCu: 1e9, heliusCredits: 0 }, { alchemyCu: 0, heliusCredits: 0 }, { monthly: {} }).level).toBe("ok");
  });
});

describe("renderSummary", () => {
  it("renders the table without any URL or key", () => {
    const agg = aggregateRuns([JSON.parse(line({ script: "pull.js", alchemyCu: 1234, alchemyCalls: 10, publicCalls: 3 }))]);
    const evaluation = evaluateBudget({ alchemyCu: 1234, heliusCredits: 0 }, agg, { monthly: { alchemyCu: 30000000, heliusCredits: 1000000 } });
    const md = renderSummary({ project: "tel", date: "2026-11-01", agg, evaluation });
    expect(md).toContain("RPC usage — tel — 2026-11-01");
    expect(md).toContain("| pull.js |");
    expect(md).toMatch(/1,234 CU/);
  });
});
