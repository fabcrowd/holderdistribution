import { describe, expect, it } from "vitest";
import { SITE_TITLE, tokenPageDescription, tokenPageTitle } from "./seo";

describe("seo copy", () => {
  it("token title is '{Name} ({ticker}) holder distribution'", () => {
    expect(tokenPageTitle({ name: "Telcoin", ticker: "TEL" })).toBe("Telcoin (TEL) holder distribution");
    expect(tokenPageTitle({ name: "Zebec Network", ticker: "ZBCN" })).toBe("Zebec Network (ZBCN) holder distribution");
  });
  it("landing title is the site name (same as index.html)", () => {
    expect(SITE_TITLE).toBe("Holder Distribution | Token Holder Distribution & Supply Data");
  });
  it("token description names the ticker", () => {
    expect(tokenPageDescription({ ticker: "ZBCN" })).toContain("ZBCN");
  });
});
