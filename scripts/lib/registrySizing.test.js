import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistry, loadProjectConfig } from "./projects.js";
import { projectHolderTiers } from "./holderTiers.js";
import { projectSizing } from "./projectSizing.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const entries = loadRegistry(ROOT);
const slugs = entries.map((p) => p.slug);

describe("registry-wide sizing and tier consistency", () => {
  it("has projects to check", () => expect(slugs.length).toBeGreaterThan(0));

  for (const slug of slugs) {
    describe(slug, () => {
      const config = loadProjectConfig(slug, ROOT);
      const holders = config.holders ?? {};
      const tiers = projectHolderTiers(config);
      const target = config.supply?.target;
      const onboarding = entries.find((p) => p.slug === slug)?.onboarding === true;

      it("has a positive supply.target (projectSizing throws without one, and generate-wallet-flows calls it at module load)", () => {
        expect(Number.isFinite(target) && target > 0, `${slug}: supply.target = ${target}`).toBe(true);
        expect(() => projectSizing(config)).not.toThrow();
      });

      it("keeps the mega-holder cut within the supply and above the retail threshold", () => {
        expect(target).toBeGreaterThan(0);
        expect(tiers.megaHolderThreshold).toBeGreaterThan(0);
        expect(tiers.megaHolderThreshold).toBeLessThanOrEqual(target);
        expect(tiers.retailThreshold).toBeLessThan(tiers.megaHolderThreshold);
      });

      it("has balance ranges that are contiguous, ordered, share the tiers' floor and end in an open range within the mega cut", () => {
        const ranges = tiers.balanceRanges;
        for (let i = 1; i < ranges.length; i += 1) expect(ranges[i].min, `${ranges[i].label}.min`).toBe(ranges[i - 1].max);
        expect(ranges[0].min).toBe(tiers.distributionTiers[tiers.distributionTiers.length - 1].min);
        const top = ranges[ranges.length - 1];
        expect(top.max).toBe(Number.POSITIVE_INFINITY);
        expect(top.min).toBeLessThanOrEqual(tiers.megaHolderThreshold);
      });

      it("resolves finite positive sizing thresholds", () => {
        const sizing = projectSizing(config);
        for (const [name, value] of Object.entries(sizing)) {
          expect(Number.isFinite(value) && value > 0, `${name} = ${value}`).toBe(true);
        }
      });

      it("takes the shared default tiers only as a recorded owner decision (legacy-root projects aside)", () => {
        const ownTiers = Array.isArray(holders.distributionTiers);
        const recorded = String(holders.defaultTiers ?? "").trim() !== "";
        if (config.data?.legacyRoot === true) return;
        // Mid-onboarding the runner's tiers step has not run yet (its done-predicate is the presence of own distributionTiers),
        // but the first snapshot must already run on this token's own mega cut, never TEL's 20B (the scaffold writes supply.target / 5).
        if (onboarding && !ownTiers && !recorded) {
          expect(Number.isFinite(holders.megaHolderThreshold), `${slug}: onboarding project without holders.megaHolderThreshold`).toBe(true);
          return;
        }
        expect(ownTiers || recorded, `${slug}: holders.distributionTiers missing and no holders.defaultTiers decision`).toBe(true);
      });
    });
  }
});
