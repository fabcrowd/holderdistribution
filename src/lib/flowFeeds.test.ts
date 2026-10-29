import { describe, expect, it } from "vitest";
import { getProject } from "@/lib/projects";
import {
  EXCHANGE_FLOW_FEED,
  TIER_OUTFLOWS_FEED,
  flowUnavailableText,
  isFlowPlaceholder,
  isPartialOutflowWindow,
  settledEntries,
} from "@/lib/flowFeeds";

describe("settledEntries", () => {
  it("drops only rows flagged partial and keeps feeds without the field intact", () => {
    const rows = [{ date: "a", in: 1 }, { date: "b", in: 2, partial: true }];
    expect(settledEntries(rows).map((r) => r.date)).toEqual(["a"]);
    const legacy: Array<{ date: string; partial?: boolean }> = [{ date: "a" }, { date: "b" }];
    expect(settledEntries(legacy)).toEqual(legacy);
  });
});

describe("isPartialOutflowWindow", () => {
  const doc = { latestDate: "2026-10-28", partialDate: "2026-10-28" };
  it("is true only for the 1-day window while the latest day is in progress", () => {
    expect(isPartialOutflowWindow(doc, "1")).toBe(true);
    expect(isPartialOutflowWindow(doc, "7")).toBe(false);
    expect(isPartialOutflowWindow({ latestDate: "2026-10-28", partialDate: null }, "1")).toBe(false);
    expect(isPartialOutflowWindow({ latestDate: "2026-10-28" }, "1")).toBe(false);
    expect(isPartialOutflowWindow(null, "1")).toBe(false);
  });
});

describe("flow placeholder state", () => {
  it("is driven by config health.feeds, so ZBCN is a placeholder and TEL is not", () => {
    const zbcn = getProject("zebec-network");
    const tel = getProject("tel");
    expect(isFlowPlaceholder(zbcn, EXCHANGE_FLOW_FEED)).toBe(true);
    expect(isFlowPlaceholder(zbcn, TIER_OUTFLOWS_FEED)).toBe(true);
    expect(isFlowPlaceholder(tel, EXCHANGE_FLOW_FEED)).toBe(false);
    expect(isFlowPlaceholder(tel, TIER_OUTFLOWS_FEED)).toBe(false);
  });

  it("names the ticker, and a project copy.text override wins", () => {
    const zbcn = getProject("zebec-network");
    expect(flowUnavailableText(zbcn)).toContain("ZBCN");
    expect(flowUnavailableText(zbcn)).toMatch(/isn't available/);
    const custom = { ...zbcn, copy: { text: { "flows.unavailable": "{name} flows: soon." } } };
    expect(flowUnavailableText(custom)).toBe("Zebec Network flows: soon.");
  });
});
