import { describe, expect, it } from "vitest";
import { MARKER_TOOLTIP_MAX, datedNotes, groupMarkers, markerCollapseGap, markerNotesByRow, markerTooltip, type ChartNote } from "./chartMarkers";
import { reclassMarkers } from "./chartMarkers";

const DAY = 86_400_000;
const at = (day: number, text = `n${day}`) => ({ t: day * DAY, text, tone: "warning" as const });

describe("markerCollapseGap", () => {
  it("is a share of the visible span", () => {
    expect(markerCollapseGap([0, 100])).toBeCloseTo(12);
  });
  it("is zero when there is no span", () => {
    expect(markerCollapseGap([5])).toBe(0);
  });
});

describe("groupMarkers", () => {
  it("collapses neighbours closer than the gap into one group on its first item", () => {
    const groups = groupMarkers([at(10), at(11), at(40)], 3 * DAY);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1]);
    expect(groups[0].t).toBe(10 * DAY);
  });

  it("keeps items separate when the gap is zero", () => {
    expect(groupMarkers([at(1), at(2)], 0)).toHaveLength(2);
  });

  it("sorts before grouping", () => {
    expect(groupMarkers([at(9), at(1)], 0).map((g) => g.t)).toEqual([DAY, 9 * DAY]);
  });
});

describe("markerNotesByRow", () => {
  it("attaches every collapsed note to the first row at or after the group", () => {
    const rows = [0, 1, 2, 3, 4, 5].map((d) => d * DAY);
    const groups = groupMarkers([at(2, "a"), at(3, "b"), at(5, "c")], 2 * DAY);
    const notes = markerNotesByRow(rows, groups);
    expect(notes.get(2 * DAY)).toEqual(["a", "b"]);
    expect(notes.get(5 * DAY)).toEqual(["c"]);
  });

  it("drops a group that lies after the last row", () => {
    expect(markerNotesByRow([0, DAY], groupMarkers([at(9)], 0)).size).toBe(0);
  });
});

describe("reclassMarkers", () => {
  it("turns dated changelog events into muted notes and skips unparseable dates", () => {
    const notes = reclassMarkers([
      { date: "2026-10-03", summary: "wallets moved" },
      { date: "not-a-date", summary: "ignored" },
    ]);
    expect(notes).toEqual([{ t: Date.UTC(2026, 9, 3), text: "Reclassified: wallets moved", tone: "muted" }]);
  });
});

describe("datedNotes", () => {
  it("parses date suffixes into warning notes and skips unparseable or empty entries", () => {
    const notes = datedNotes([
      { suffix: "2026-10-01", text: "gap" },
      { suffix: "bad", text: "ignored" },
      { suffix: "2026-10-02", text: "" },
    ]);
    expect(notes).toEqual([{ t: Date.parse("2026-10-01"), text: "gap", tone: "warning" }]);
  });
});

describe("markerTooltip", () => {
  const group = (...items: ChartNote[]) => ({ t: items[0].t, items });
  it("prefers the item's tooltip over its tooltip-less text", () => {
    expect(markerTooltip(group({ ...at(1, "long text"), tooltip: "Method change · Oct 3, 2026" }))).toBe("Method change · Oct 3, 2026");
    expect(markerTooltip(group(at(1, "v3 migration")))).toBe("v3 migration");
  });
  it("counts the other notes folded into a collapsed marker", () => {
    expect(markerTooltip(group(at(1, "a"), at(2, "b"), at(3, "c")))).toBe("a (+2 more)");
  });
  it("keeps a long line short with an ellipsis", () => {
    const out = markerTooltip(group(at(1, "x".repeat(200))));
    expect(out.length).toBeLessThanOrEqual(MARKER_TOOLTIP_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
});
