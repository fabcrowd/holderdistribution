import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

describe("zebec-network flow feeds", () => {
  it("publishes tier-outflows with every window", () => {
    const doc = read("public/data/zebec-network/tier-outflows.json");
    expect(doc.schema).toBe(9);
    expect(typeof doc.complete).toBe("boolean");
    expect(doc.latestDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(doc.ranges).sort()).toEqual(["1", "30", "365", "7", "90", "ytd"]);
    for (const range of Object.values(doc.ranges)) {
      expect(typeof range.tiers).toBe("object");
      expect(range.from <= range.to).toBe(true);
    }
  });

  it("publishes a well-formed exchange-flow history (empty until the Solana scan has measured days)", () => {
    const doc = read("public/data/zebec-network/exchange-flow-history.json");
    expect(doc.schema).toBe(3);
    expect(Array.isArray(doc.entries)).toBe(true);
    const dates = doc.entries.map((e) => e.date);
    expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect([...dates].sort()).toEqual(dates);
    for (const e of doc.entries) expect(Object.keys(e.chains)).toEqual(["solana"]);
  });

  it("does not replace TEL's measured feeds", () => {
    const tiers = read("public/data/tier-outflows.json");
    const flows = read("public/data/exchange-flow-history.json");
    expect(tiers.complete).toBe(true);
    expect(Object.keys(tiers.ranges.ytd.tiers).length).toBeGreaterThan(0);
    expect(flows.entries.length).toBeGreaterThan(0);
  });
});
