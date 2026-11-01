import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, p), "utf8");

describe("token header (no switcher)", () => {
  it("the switcher component is gone", () => {
    expect(fs.existsSync(path.resolve(__dirname, "TokenSwitcher.tsx"))).toBe(false);
  });
  it("no navigation or terminal file references TokenSwitcher", () => {
    for (const f of ["Navigation.tsx", "terminal/TerminalDashboard.tsx"]) {
      expect(src(f), f).not.toContain("TokenSwitcher");
    }
  });
  it("the heading is the brand, not the token name", () => {
    expect(src("terminal/TerminalDashboard.tsx")).toMatch(/<h1[\s\S]*?Holder Distribution[\s\S]*?<\/h1>/);
  });
  it("the open token's mark sits in the controls, icon only", () => {
    expect(src("terminal/TerminalDashboard.tsx")).toMatch(/<TokenIdentity\s+iconOnly\b/);
  });
});
