import { afterAll, describe, expect, it } from "vitest";
import { RecordSchemaError, RecordShapeError } from "./errors.js";
import { addRows, parseIndexFile, serializeIndexFile } from "./publishIndex.js";
import { folderEnv, runOf, writeCoins } from "./recordKit.js";

const env = folderEnv();
afterAll(() => env.cleanup());
const S = "example-01";

async function entries(days) {
  const out = [];
  for (const [i, day] of days.entries()) out.push((await writeCoins({ env, specs: [{ slug: S, day, run: runOf(5000 + i) }] }))[0].entry);
  return out;
}

describe("publishIndex", () => {
  it("numbers rows per day, adds a bundle once, and drops rows older than the adoption window", async () => {
    const [a, b, c] = await entries(["2026-10-01", "2026-11-17", "2026-11-17"]);
    const first = addRows({ slug: S, rows: [], entries: [a], today: "2026-10-02" });
    expect(first.map((r) => [r.day, r.part])).toEqual([["2026-10-01", 1]]);
    const next = addRows({ slug: S, rows: first, entries: [a, b, c], today: "2026-11-18" });
    expect(next.map((r) => [r.day, r.part])).toEqual([["2026-11-17", 1], ["2026-11-17", 2]]); // 2026-10-01 is outside the 16 days
    expect(addRows({ slug: S, rows: next, entries: [b, c], today: "2026-11-18" })).toEqual(next);
    expect(next).toEqual(structuredClone(next));
  });

  it("round-trips a file and refuses another slug, another schema and a bad row", async () => {
    const [a] = await entries(["2026-11-17"]);
    const rows = addRows({ slug: S, rows: [], entries: [a], today: "2026-11-18" });
    expect(parseIndexFile(serializeIndexFile(S, rows), S)).toEqual(rows);
    expect(serializeIndexFile(S, rows).endsWith("}\n")).toBe(true);
    expect(() => parseIndexFile(serializeIndexFile(S, rows), "example-02")).toThrow(RecordShapeError);
    expect(() => parseIndexFile(JSON.stringify({ schema: 2, slug: S, rows: [] }), S)).toThrow(RecordSchemaError);
    expect(() => parseIndexFile(JSON.stringify({ schema: 1, slug: S, rows: [{ day: "2026-11-17", part: 0, bundle: a.bundle }] }), S)).toThrow(RecordShapeError);
  });
});
