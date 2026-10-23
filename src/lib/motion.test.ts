import { afterEach, describe, expect, it } from "vitest";
import { countUpAt, introActive, prefersReducedMotion, resetIntro, INTRO_WINDOW_MS } from "./motion";

afterEach(() => resetIntro());

describe("motion policy", () => {
  it("reads prefers-reduced-motion from matchMedia", () => {
    expect(prefersReducedMotion((q) => ({ matches: q === "(prefers-reduced-motion: reduce)" }))).toBe(true);
    expect(prefersReducedMotion(() => ({ matches: false }))).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
  });

  it("reduced motion: no intro at all, even at t=0", () => {
    expect(introActive(INTRO_WINDOW_MS, 1000, true)).toBe(false);
    expect(introActive(INTRO_WINDOW_MS, 1000, true)).toBe(false);
  });

  it("intro plays only inside the window opened by the first caller", () => {
    expect(introActive(INTRO_WINDOW_MS, 1000, false)).toBe(true);
    expect(introActive(INTRO_WINDOW_MS, 1000 + INTRO_WINDOW_MS - 1, false)).toBe(true);
    expect(introActive(INTRO_WINDOW_MS, 1000 + INTRO_WINDOW_MS, false)).toBe(false);
  });

  it("count-up eases out and lands exactly on the target", () => {
    expect(countUpAt(1000, 0, 500)).toBe(0);
    const mid = countUpAt(1000, 250, 500);
    expect(mid).toBeGreaterThan(500);
    expect(mid).toBeLessThan(1000);
    expect(countUpAt(1000, 500, 500)).toBe(1000);
    expect(countUpAt(1000, 9999, 500)).toBe(1000);
  });

  it("count-up with no duration (reduced-motion path) shows the target immediately", () => {
    expect(countUpAt(95932, 0, 0)).toBe(95932);
    expect(countUpAt(Number.NaN, 0, 500)).toBeNaN();
  });
});
