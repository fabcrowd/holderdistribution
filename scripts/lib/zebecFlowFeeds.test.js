import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

describe("zebec-network flow feeds", () => {
  it("publishes tier-outflows with every window and no measured tiers", () => {
    const doc = read("public/data/zebec-network/tier-outflows.json");
    expect(doc.schema).toBe(9);
    expect(doc.complete).toBe(false);
    expect(doc.latestDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(doc.ranges).sort()).toEqual(["1", "30", "365", "7", "90", "ytd"]);
    for (const range of Object.values(doc.ranges)) {
      expect(range.tiers).toEqual({});
      expect(range.from <= range.to).toBe(true);
    }
  });

  it("publishes an empty exchange-flow history", () => {
    const doc = read("public/data/zebec-network/exchange-flow-history.json");
    expect(doc.schema).toBe(3);
    expect(doc.entries).toEqual([]);
  });

  it("does not replace TEL's measured feeds", () => {
    const tiers = read("public/data/tier-outflows.json");
    const flows = read("public/data/exchange-flow-history.json");
    expect(tiers.complete).toBe(true);
    expect(Object.keys(tiers.ranges.ytd.tiers).length).toBeGreaterThan(0);
    expect(flows.entries.length).toBeGreaterThan(0);
  });
});
