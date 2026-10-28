import { describe, expect, it } from "vitest";
import { buildSitemap } from "./sitemap.js";

describe("buildSitemap", () => {
  const xml = buildSitemap({ baseUrl: "https://holderdistribution.com", slugs: ["tel", "zebec-network"], today: "2026-10-26" });
  it("lists the landing page and every token route", () => {
    expect(xml).toContain("<loc>https://holderdistribution.com/</loc>");
    expect(xml).toContain("<loc>https://holderdistribution.com/tel</loc>");
    expect(xml).toContain("<loc>https://holderdistribution.com/zebec-network</loc>");
    expect(xml.match(/<url>/g)).toHaveLength(3);
    expect(xml).toContain("<lastmod>2026-10-26</lastmod>");
  });
  it("does not list legacy URLs", () => {
    expect(xml).not.toContain("/holders");
    expect(xml).not.toContain("?token=");
  });
});
