import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadRegistry, loadProjectConfig } from "./projects.js";
import { projectHolderTiers } from "./holderTiers.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const slugs = loadRegistry(ROOT).map((p) => p.slug);

// The largest tier's floor may be at most this share of the supply target, so
// a project is never left with another token's (e.g. TEL's 100B) tier edges.
const MAX_TOP_TIER_SHARE = 0.05;

describe("registry-wide distribution tiers", () => {
  it("has projects to check", () => expect(slugs.length).toBeGreaterThan(0));

  for (const slug of slugs) {
    describe(slug, () => {
      const config = loadProjectConfig(slug, ROOT);
      const tiers = projectHolderTiers(config).distributionTiers;

      it("is contiguous and ordered largest -> smallest", () => {
        for (let i = 1; i < tiers.length; i += 1) {
          expect(tiers[i].max, `${tiers[i].label}.max`).toBe(tiers[i - 1].min);
          expect(tiers[i].min).toBeLessThan(tiers[i - 1].min);
        }
      });

      it("has an open top tier and a bottom tier starting at 1", () => {
        expect(tiers[0].max).toBe(Number.POSITIVE_INFINITY);
        expect(tiers[tiers.length - 1].min).toBe(1);
      });

      it("has unique labels", () => {
        expect(new Set(tiers.map((t) => t.label)).size).toBe(tiers.length);
      });

      it("sizes the top tier to the supply target", () => {
        const target = config.supply?.target;
        if (!target) return;
        expect(tiers[0].min).toBeLessThanOrEqual(target * MAX_TOP_TIER_SHARE);
      });
    });
  }
});
