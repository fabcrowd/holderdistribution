import { describe, expect, it, vi } from "vitest";
import { revealActiveTab, scrollEdges, scrollStepPx } from "./tabScroll";

describe("scrollEdges", () => {
  it("shows no fade or scroll buttons when the strip fits", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 600 })).toEqual({
      overflowing: false,
      left: false,
      right: false,
    });
  });
  it("shows only the right fade when overflowing at the start", () => {
    expect(scrollEdges({ scrollLeft: 0, scrollWidth: 900, clientWidth: 600 })).toEqual({
      overflowing: true,
      left: false,
      right: true,
    });
  });
  it("shows both fades when scrolled into the middle", () => {
    expect(scrollEdges({ scrollLeft: 150, scrollWidth: 900, clientWidth: 600 })).toEqual({
      overflowing: true,
      left: true,
      right: true,
    });
  });
  it("shows only the left fade at the far end, ignoring subpixel rounding", () => {
    expect(scrollEdges({ scrollLeft: 300, scrollWidth: 900, clientWidth: 600 })).toEqual({
      overflowing: true,
      left: true,
      right: false,
    });
    expect(scrollEdges({ scrollLeft: 299.5, scrollWidth: 900, clientWidth: 600 }).right).toBe(false);
  });
});

describe("scrollStepPx", () => {
  it("scrolls the strip by about 60% of its visible width", () => {
    expect(scrollStepPx(600)).toBe(360);
  });
});

describe("revealActiveTab", () => {
  it("scrolls the active tab into view with nearest alignment", () => {
    const scrollIntoView = vi.fn();
    const strip = { querySelector: () => ({ scrollIntoView }) } as unknown as HTMLElement;
    revealActiveTab(strip, false);
    expect(scrollIntoView).toHaveBeenCalledWith({ inline: "nearest", block: "nearest", behavior: "smooth" });
  });
  it("uses instant scrolling when reduced motion is requested", () => {
    const scrollIntoView = vi.fn();
    const strip = { querySelector: () => ({ scrollIntoView }) } as unknown as HTMLElement;
    revealActiveTab(strip, true);
    expect(scrollIntoView).toHaveBeenCalledWith({ inline: "nearest", block: "nearest", behavior: "auto" });
  });
  it("does nothing when no tab is selected", () => {
    const strip = { querySelector: () => null } as unknown as HTMLElement;
    expect(() => revealActiveTab(strip, false)).not.toThrow();
  });
});
