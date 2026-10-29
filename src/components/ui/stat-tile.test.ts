import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CLOSED_TOOLTIP_STATE, reduceTooltipState, type TooltipEvent } from "@/components/ui/stat-tile-state";
import { StatTile } from "@/components/ui/stat-tile";

const run = (events: TooltipEvent[]) => events.reduce(reduceTooltipState, CLOSED_TOOLTIP_STATE);

describe("StatTile tooltip state", () => {
  it("starts closed", () => {
    expect(CLOSED_TOOLTIP_STATE).toEqual({ open: false, pinned: false });
  });

  it("a tap opens and pins the explainer", () => {
    expect(run([{ type: "tap" }])).toEqual({ open: true, pinned: true });
  });

  it("a second tap on a pinned explainer closes it", () => {
    expect(run([{ type: "tap" }, { type: "tap" }])).toEqual(CLOSED_TOOLTIP_STATE);
  });

  it("focus followed by tap (touch order) ends pinned open, not toggled shut", () => {
    expect(run([{ type: "focus" }, { type: "tap" }])).toEqual({ open: true, pinned: true });
  });

  it("mouse hover opens without pinning and closes when the pointer leaves", () => {
    expect(run([{ type: "hoverIn" }])).toEqual({ open: true, pinned: false });
    expect(run([{ type: "hoverIn" }, { type: "hoverOut" }])).toEqual(CLOSED_TOOLTIP_STATE);
  });

  it("a click while hover-open pins it, so leaving the tile keeps it open", () => {
    expect(run([{ type: "hoverIn" }, { type: "tap" }, { type: "hoverOut" }])).toEqual({ open: true, pinned: true });
  });

  it("keyboard focus opens and blur closes an unpinned explainer", () => {
    expect(run([{ type: "focus" }])).toEqual({ open: true, pinned: false });
    expect(run([{ type: "focus" }, { type: "blur" }])).toEqual(CLOSED_TOOLTIP_STATE);
  });

  it("blur does not close a pinned explainer", () => {
    expect(run([{ type: "tap" }, { type: "blur" }])).toEqual({ open: true, pinned: true });
  });

  it("outside tap or Escape (dismiss) closes and unpins regardless of pin", () => {
    expect(run([{ type: "tap" }, { type: "dismiss" }])).toEqual(CLOSED_TOOLTIP_STATE);
    expect(run([{ type: "hoverIn" }, { type: "dismiss" }])).toEqual(CLOSED_TOOLTIP_STATE);
  });
});

describe("StatTile markup", () => {
  const html = renderToStaticMarkup(
    createElement(StatTile, { label: "Growth", value: "-0.18%", sub: "over 301 days", info: "Percent change over the range." }),
  );

  it("renders the whole tile as a focusable button", () => {
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
  });

  it("links the explainer to the button for assistive tech", () => {
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain("Percent change over the range.");
  });

  it("shows label, value and sub", () => {
    expect(html).toContain("Growth");
    expect(html).toContain("-0.18%");
    expect(html).toContain("over 301 days");
  });
});
