import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import registry from "../../config/projects.json";
import tel from "../../config/projects/tel.json";
import {
  DEFAULT_PROJECT_SLUG,
  PROJECTS,
  SLUG_RE,
  getProject,
  isProjectSlug,
  supplyTargetLabel,
} from "./projects";
import { TEL_LEGACY_ADDRESS, TEL_UPGRADE_CONTRACTS, TEL_V3_ADDRESS } from "./telContracts";

describe("project registry", () => {
  it("has unique valid slugs, each with a config file, and exactly one default", () => {
    const slugs = registry.projects.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(SLUG_RE.test(s), s).toBe(true);
    expect(PROJECTS.map((p) => p.slug)).toEqual(slugs);
    expect(registry.projects.filter((p) => (p as { default?: boolean }).default)).toHaveLength(1);
  });

  it("TEL is the first project and the default", () => {
    expect(DEFAULT_PROJECT_SLUG).toBe("tel");
    expect(getProject("tel")).toMatchObject({ slug: "tel", ticker: "TEL", name: "Telcoin" });
    expect(isProjectSlug("tel")).toBe(true);
    expect(isProjectSlug("nope")).toBe(false);
    expect(isProjectSlug(undefined)).toBe(false);
  });

  it("unknown slugs fall back to the default project", () => {
    expect(getProject("does-not-exist").slug).toBe("tel");
  });

  it("tel.json carries the same contracts as telContracts.ts (no invented addresses)", () => {
    expect(tel.slug).toBe("tel");
    for (const chain of tel.chains) {
      const legacy = chain.tokens.find((t) => t.generation === "legacy")!;
      const v3 = chain.tokens.find((t) => t.generation === "v3")!;
      expect(legacy.address).toBe(TEL_LEGACY_ADDRESS[chain.key as keyof typeof TEL_LEGACY_ADDRESS]);
      expect(legacy.decimals).toBe(2);
      expect(v3.address).toBe(TEL_V3_ADDRESS);
      expect(v3.decimals).toBe(18);
      for (const [k, c] of Object.entries(chain.contracts)) {
        expect(c.address).toBe(TEL_UPGRADE_CONTRACTS[k as keyof typeof TEL_UPGRADE_CONTRACTS]);
      }
    }
    expect(tel.chains.map((c) => c.key)).toEqual(["ethereum", "polygon", "base"]);
  });

  it("supply label comes from config", () => {
    expect(supplyTargetLabel(getProject("tel"))).toBe("100B");
    expect(supplyTargetLabel({ supply: { target: 21_000_000 } })).toBe("21M");
    expect(supplyTargetLabel({ supply: { target: 1_500_000_000 } })).toBe("1.5B");
    expect(supplyTargetLabel({})).toBeNull();
  });
});

describe("token images", () => {
  it("every mapped project has a cached image under public/tokens/<slug>.(png|jpg)", () => {
    for (const p of PROJECTS) {
      const img = getProject(p.slug).image;
      expect(img, p.slug).toMatch(new RegExp(`^/tokens/${p.slug}\\.(png|jpg)$`));
      expect(fs.existsSync(path.resolve(__dirname, "../../public", img!.slice(1))), img).toBe(true);
    }
  });
});
