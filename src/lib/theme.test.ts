import { describe, expect, it } from "vitest";
import { nextThemePreference, readThemePreference, resolveTheme } from "./theme";

describe("theme preference", () => {
  it("falls back to system for unknown values", () => {
    expect(readThemePreference(null)).toBe("system");
    expect(readThemePreference("blue")).toBe("system");
    expect(readThemePreference("dark")).toBe("dark");
  });
  it("resolves system against the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
  it("cycles light, dark, system", () => {
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
    expect(nextThemePreference("system")).toBe("light");
  });
});
