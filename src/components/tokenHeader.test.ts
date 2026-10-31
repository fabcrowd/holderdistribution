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
  it("the heading shows TokenIdentity", () => {
    expect(src("terminal/TerminalDashboard.tsx")).toMatch(/<TokenIdentity\b[^>]*\/>\s*<span>Holder Distribution<\/span>/);
  });
});
