import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistry, loadProjectConfig } from "./projects.js";
import { resolveCirculatingSubtract } from "./circulatingSubtract.js";

// Owner decision 2026-11-12: team/holdings are subtracted from circulating supply on every coin but TEL.
// TEL (the legacy-root project) keeps ["treasury","council"]: Telcoin Holdings counts as circulating.
const ROOT = path.resolve(import.meta.dirname, "../..");
const projects = loadRegistry(ROOT);
const HELD_OUT = ["holdings", "team"];

describe("registry-wide circulating definition", () => {
  it("has projects to check", () => expect(projects.length).toBeGreaterThan(0));

  for (const { slug } of projects) {
    const config = loadProjectConfig(slug, ROOT);
    const legacyRoot = config.data?.legacyRoot === true;
    const file = `config/projects/${slug}.json`;
    const subtract = resolveCirculatingSubtract(config.supply);

    if (legacyRoot) {
      it(`${slug}: keeps Telcoin Holdings in circulating (subtract is exactly treasury + council)`, () => {
        expect(subtract, `${file} supply.circulating.subtract must stay ["treasury","council"] (owner decision: TEL holdings count as circulating)`).toEqual(["treasury", "council"]);
      });
      continue;
    }

    it(`${slug}: lists both team and holdings in supply.circulating.subtract`, () => {
      expect(subtract, `${file} supply.circulating.subtract must list "team" and "holdings" (owner decision 2026-11-12; a category with no wallets subtracts 0)`).toEqual(expect.arrayContaining(HELD_OUT));
    });

    it(`${slug}: subtracts every declared holdings/team category from circulating`, () => {
      const declared = (config.supply?.developerHoldings?.subcategories ?? []).map((s) => s.category).filter((c) => HELD_OUT.includes(c));
      const missing = declared.filter((c) => !subtract.includes(c));
      expect(missing, `${file} supply.circulating.subtract lacks ${missing.map((c) => `"${c}"`).join(", ")} (declared in supply.developerHoldings.subcategories); add it, owner decision 2026-11-12`).toEqual([]);
    });
  }
});
