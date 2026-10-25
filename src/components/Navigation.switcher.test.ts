import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// One token switcher per breakpoint: header pill on phones, page-title switcher md+.
describe("Navigation token switcher", () => {
  const src = readFileSync(resolve(__dirname, "Navigation.tsx"), "utf8");
  it("hides the header pill from md up", () => {
    expect(src).toMatch(/<TokenSwitcher variant="pill" className="[^"]*\bmd:hidden\b[^"]*"/);
  });
});
