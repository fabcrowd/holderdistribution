import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, p), "utf8");

describe("token header (token switcher)", () => {
  it("the switcher component exists", () => {
    expect(fs.existsSync(path.resolve(__dirname, "TokenSwitcher.tsx"))).toBe(true);
  });
  it("the desktop and the compact header both mount the switcher", () => {
    for (const f of ["Navigation.tsx", "terminal/TerminalDashboard.tsx"]) {
      expect(src(f), f).toContain("<TokenSwitcher");
    }
  });
  it("the heading is the brand, not the token name", () => {
    expect(src("terminal/TerminalDashboard.tsx")).toMatch(/<h1[\s\S]*?Holder Distribution[\s\S]*?<\/h1>/);
  });
  it("the icon-only token mark is gone from the desktop controls", () => {
    expect(src("terminal/TerminalDashboard.tsx")).not.toMatch(/<TokenIdentity\b/);
  });
});
