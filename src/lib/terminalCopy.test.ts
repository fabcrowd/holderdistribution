import { describe, expect, it } from "vitest";
import { HOLDER_PANEL_IDS } from "./viewRoute";
import * as terminalCopy from "./terminalCopy";
import { EXPLORE_HINT, HOLDER_EXPLORE_PANELS, TIER_FLOWS_EXPLAINER } from "./terminalCopy";
import { TIERS } from "@/components/tierflow/geometry";
import { defaultTierLabel } from "./distributionSelection";

describe("terminal nav copy", () => {
  it("has no layout toggle copy; Explore is reached from a panel's expand icon", () => {
    expect(terminalCopy).not.toHaveProperty("LAYOUT_MODES");
    expect(EXPLORE_HINT).toMatch(/one chart at a time/i);
    expect(EXPLORE_HINT).toMatch(/Momentum is only here/);
  });

  it("Explore sections keep their ids and drop the labels that duplicated Dashboard", () => {
    expect(HOLDER_EXPLORE_PANELS.map((p) => p.id)).toEqual([...HOLDER_PANEL_IDS]);
    const labels = HOLDER_EXPLORE_PANELS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    // "Overview" / "Trends" / bare "Flows" read as a second dashboard.
    expect(labels).not.toContain("Overview");
    expect(labels).not.toContain("Trends");
    expect(labels).not.toContain("Flows");
    expect(HOLDER_EXPLORE_PANELS.find((p) => p.id === "trends")?.label).toBe("Holder history");
    expect(HOLDER_EXPLORE_PANELS.find((p) => p.id === "flows")?.label).toBe("Exchange flows");
    expect(HOLDER_EXPLORE_PANELS.find((p) => p.id === "overview")?.label).toBe("Key numbers");
  });

  it("tabs that repeat a Dashboard chart say so; Momentum says it does not", () => {
    for (const id of ["concentration", "balances", "staking", "trends", "flows", "exchanges"]) {
      expect(HOLDER_EXPLORE_PANELS.find((p) => p.id === id)?.hint).toMatch(/Dashboard/);
    }
    expect(HOLDER_EXPLORE_PANELS.find((p) => p.id === "growth")?.hint).toMatch(/Not on the Dashboard/);
  });
});

describe("tier flows copy and default tier", () => {
  it("explains bands without naming a token", () => {
    expect(TIER_FLOWS_EXPLAINER).toMatch(/balance bands/i);
    expect(TIER_FLOWS_EXPLAINER).toContain("{ticker}");
    expect(TIER_FLOWS_EXPLAINER).toMatch(/not a buy or a sell/i);
    expect(TIER_FLOWS_EXPLAINER).not.toMatch(/\bTEL\b/);
  });

  it("picks the busiest tier that sits in the top of the diagram", () => {
    const rows = TIERS.map((label) => ({
      label,
      count: label === "1-250K" ? 80_000 : label === "5M-10M" ? 1_000 : label === "1M-5M" ? 5_000 : 10,
    }));
    // 1M-5M is busier but below the first-screen slice; 5M-10M is the
    // busiest band still in that slice. The dust tier is not the default.
    expect(defaultTierLabel(rows, TIERS)).toBe("5M-10M");
    expect(defaultTierLabel(rows)).toBe("1-250K");
  });

  it("falls back to the busiest tier when the top of the diagram is empty", () => {
    const rows = [
      { label: "500M+", count: 0 },
      { label: "1-250K", count: 12 },
    ];
    expect(defaultTierLabel(rows, ["500M+", "1-250K"])).toBe("1-250K");
    expect(defaultTierLabel([])).toBeNull();
  });
});
