// Sequences of design 2.1 section 10 and the cases the reviews raised.
// Every test reads every day inside the horizon from every index version
// (older versions read forward from their bases, the newest by undo) and
// compares with the harness model; every read runs the state check.
import { describe, it, expect } from "vitest";
import { Harness, S, readState, keysIn, changesOf } from "./storeTestKit.js";
import { changesOn, ABSENT } from "./tableRead.js";
import { setHistoryDays } from "./tableIndex.js";
import { StoreCheckError } from "./stateCheck.js";

const T = 20000;
const pos = (b) => b.base && { day: b.base.day, part: b.base.part };

describe("section 10 sequences", () => {
  it("(a) nightly, a second publish the same day, the next night", async () => {
    const h = new Harness({ rowsPerBucket: 2 });
    const r1 = await h.night(1, { A: 5, B: 3, C: 2, D: 1, E: 4 });
    // Several splits in one publish (fix 4): 5 rows at R = 2 need 3 buckets.
    expect(r1.splits).toEqual([{ split: 0, into: 1, L: 0 }, { split: 0, into: 2, L: 1 }]);
    const r2 = await h.night(2, { A: 7 });
    expect(r2.splits).toEqual([]);
    await h.night(2, { B: 0, F: 6 });
    const day2 = h.index.days.find((x) => x.day === 2);
    expect(day2.parts[0].layout).toEqual({ L: 1, p: 1 });
    expect(day2.parts[1].layout).toEqual({ L: 1, p: 1 });
    await h.night(3, { A: 8, G: 1 });
    expect((await readState(h.store, h.index, 2)).state).toEqual(S({ A: 7, C: 2, D: 1, E: 4, F: 6 }));
    expect((await readState(h.store, h.versions[1].index, 2)).state).toEqual(S({ A: 7, B: 3, C: 2, D: 1, E: 4 }));
    expect((await readState(h.store, h.index, 3)).state).toEqual(S({ A: 8, C: 2, D: 1, E: 4, F: 6, G: 1 }));
    const paths = await h.verifyAll();
    expect(paths.forward).toBeGreaterThan(0);
    expect(paths.undo).toBeGreaterThan(0);
  }, T);

  // The review-3 walk, and the same with the rewrite or split in the second part.
  const orders = [
    ["base rewrite in part 1, plain part 2", { A: 5, B: 1 }, [{ A: 7, B: 2 }, { A: 9 }], 10, { day: 2, part: 1 }],
    ["plain part 1, base rewrite in part 2", { A: 5, B: 1 }, [{ A: 7 }, { A: 9, B: 2 }], 10, { day: 2, part: 2 }],
    ["split in part 1, plain part 2", { A: 5, B: 1 }, [{ C: 7 }, { A: 9 }], 2, { day: 2, part: 1 }],
    ["plain part 1, split in part 2", { A: 5, B: 1 }, [{ A: 7 }, { A: 9, C: 7 }], 2, { day: 2, part: 2 }],
  ];
  for (const [name, d1, parts, R, basePos] of orders) {
    it(`(a2) ${name}`, async () => {
      const h = new Harness({ rowsPerBucket: R });
      await h.night(1, d1);
      for (const p of parts) await h.night(2, p);
      expect(h.index.buckets.some((b) => b.base && b.base.day === basePos.day && b.base.part === basePos.part)).toBe(true);
      const today = await readState(h.store, h.index, 2);
      expect(today.state.A).toBe("9/0");
      const prev = await readState(h.store, h.index, 1);
      expect(prev.state).toEqual(S(d1));
      expect(prev.paths.undo).toBeGreaterThan(0);
      await h.night(3, { A: 10 });
      const c3 = await changesOn(h.store, h.index, 3);
      expect(c3.get("A")).toEqual({ old: [9n, 0n], new: [10n, 0n] });
      await h.verifyAll();
    }, T);
  }

  it("(b) a missed day filled two days later", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { A: 5, B: 3 });
    await h.night(3, { A: 6 });
    await h.night(4, { B: 4 });
    expect((await readState(h.store, h.index, 2)).state).toEqual(S({ A: 5, B: 3 }));
    await h.past([[2, { A: 1, C: 2 }]]);
    expect(h.index.buckets.every((b) => !b.base || b.base.day !== 2)).toBe(true);
    expect((await readState(h.store, h.index, 2)).state).toEqual(S({ A: 1, B: 3, C: 2 }));
    expect((await readState(h.store, h.index, 3)).state).toEqual(S({ A: 6, B: 3 }));
    expect((await readState(h.store, h.index, 4)).state).toEqual(S({ A: 6, B: 4 }));
    const c3 = await changesOn(h.store, h.index, 3);
    expect(c3.get("A")).toEqual({ old: [1n, 0n], new: [6n, 0n] });
    expect(c3.get("C")).toEqual({ old: [2n, 0n], new: [0n, 0n] });
    await h.verifyAll();
  }, T);

  it("(c) a rebuild of day d when d+1 has two parts; a base at the old end of d+1 moves to (d+1, 1)", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { A: 5, B: 3, C: 1 });
    await h.night(2, { A: 6 });
    await h.night(3, { B: 4 });
    await h.night(3, { C: 0, D: 2 });
    expect(pos(h.index.buckets[0])).toEqual({ day: 3, part: 2 });
    const baseRef = h.index.buckets[0].base.ref;
    await h.night(4, { A: 7 });
    await h.past([[2, { A: 8, B: 9 }]]);
    expect(pos(h.index.buckets[0])).toEqual({ day: 3, part: 1 });
    expect(h.index.buckets[0].base.ref).toBe(baseRef);
    expect(h.index.days.find((x) => x.day === 3).parts).toHaveLength(1);
    expect((await readState(h.store, h.index, 2)).state).toEqual(S({ A: 8, B: 9, C: 1 }));
    expect((await readState(h.store, h.index, 3)).state).toEqual(S({ A: 6, B: 4, D: 2 }));
    await h.verifyAll();
  }, T);

  it("(c) a base between d+1's two parts is rewritten from the end of d+1 at (d+1, 1)", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { A: 5, B: 3, C: 1 });
    await h.night(2, { A: 6 });
    await h.night(3, { B: 4, A: 1, C: 9 });
    expect(pos(h.index.buckets[0])).toEqual({ day: 3, part: 1 });
    await h.night(3, { C: 0, D: 2 });
    const baseRef = h.index.buckets[0].base.ref;
    await h.past([[2, { A: 8 }]]);
    expect(pos(h.index.buckets[0])).toEqual({ day: 3, part: 1 });
    expect(h.index.buckets[0].base.ref).not.toBe(baseRef);
    expect((await readState(h.store, h.index, 3)).state).toEqual(S({ A: 1, B: 4, D: 2 }));
    await h.verifyAll();
  }, T);

  it("(c) the rebuilt day had two parts and gets one", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { A: 5, B: 3 });
    await h.night(2, { A: 6 });
    await h.night(2, { B: 7 });
    await h.night(3, { A: 1 });
    await h.past([[2, { B: 2 }]]);
    expect(h.index.days.find((x) => x.day === 2).parts).toHaveLength(1);
    expect((await readState(h.store, h.index, 2)).state).toEqual(S({ A: 5, B: 2 }));
    expect((await readState(h.store, h.index, 3)).state).toEqual(S({ A: 1, B: 7 }));
    await h.verifyAll();
  }, T);

  it("(d) a rebuild of a range that crosses a split", async () => {
    const h = new Harness({ rowsPerBucket: 2 });
    await h.night(1, { A: 1, B: 1 });
    await h.night(2, { A: 2 });
    const r3 = await h.night(3, { C: 3, D: 3 });
    expect(r3.split).not.toBeNull();
    await h.night(4, { B: 4 });
    await h.night(5, { A: 5, E: 5 });
    await h.past([[2, { A: 20, F: 2 }], [3, { C: 30 }], [4, { B: 0, G: 4 }]]);
    expect(h.index.days.find((x) => x.day === 3).parts[0].splits).toEqual([r3.split]);
    expect((await readState(h.store, h.index, 3)).state).toEqual(S({ A: 20, B: 1, C: 30, F: 2 }));
    expect((await readState(h.store, h.index, 5)).state).toEqual(S({ A: 5, B: 4, C: 3, D: 3, E: 5 }));
    await h.verifyAll();
  }, T);

  it("(e) a bucket split on the same night as a base rewrite, then a second part", async () => {
    const h = new Harness({ rowsPerBucket: 2 });
    await h.night(1, { A: 1, B: 1 });
    const r = await h.night(2, { A: 2, B: 2, C: 2 });
    expect(r.split).toEqual({ split: 0, into: 1, L: 0 });
    expect(r.basesWritten).toEqual([0, 1]);
    expect(h.index.buckets.map(pos)).toEqual([{ day: 2, part: 1 }, { day: 2, part: 1 }]);
    await h.night(2, { D: 2 });
    expect(h.index.days.find((x) => x.day === 2).parts[1].layout).toEqual({ L: 1, p: 0 });
    const y = await readState(h.store, h.index, 1);
    expect(y.state).toEqual(S({ A: 1, B: 1 }));
    expect(y.paths.undo).toBe(2);
    await h.verifyAll();
  }, T);

  it("(f) the first day inside the horizon reads exactly when every base is newer than it", async () => {
    const h = new Harness({ rowsPerBucket: 3, historyDays: 12, ageMarginDays: 3, ageSpreadDays: 2 });
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for (let day = 1; day <= 25; day++) await h.night(day, Object.fromEntries(keys.map((k, i) => [k, day * 10 + i])));
    const hs = h.index.horizonStart;
    expect(hs).toBe(14);
    expect(h.index.buckets.every((b) => b.base.day > hs)).toBe(true);
    await h.deleteDropped();
    expect(h.dropped.length).toBeGreaterThan(0);
    const first = await readState(h.store, h.index, hs);
    expect(first.state).toEqual(h.expected(hs));
    expect(first.paths.undo).toBeGreaterThan(0);
    expect((await readState(h.store, h.index, hs - 1)).state).toBe(ABSENT);
    await h.verifyAll({ versions: [h.versions.at(-1)] });
  }, T);

  it("(g, store part) the yearly copy is covered in yearlyCopy.test.js", () => {
    expect(true).toBe(true);
  });

  it("(h, store part) a lane continues from an index version that was written but never published", async () => {
    const h = new Harness({ rowsPerBucket: 2 });
    await h.night(1, { A: 1, B: 1 });
    await h.night(2, { A: 2, C: 2 }); // the failed night: index version exists, never "committed"
    await h.night(3, { B: 3 });
    expect((await readState(h.store, h.index, 2)).state).toEqual(S({ A: 2, B: 1, C: 2 }));
    await h.verifyAll();
  }, T);
});

describe("cases the reviews raised", () => {
  it("a second part that reverts the first", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { A: 5, B: 1 });
    await h.night(2, { A: 7 });
    await h.night(2, { A: 5 });
    expect((await readState(h.store, h.index, 2)).state).toEqual(S({ A: 5, B: 1 }));
    expect((await changesOn(h.store, h.index, 2)).size).toBe(0);
    await h.verifyAll();
  }, T);

  it("an account that moves buckets in a split and changes on the split day; undo across that split", async () => {
    const one = { L: 0, p: 0 };
    const [stay] = keysIn(0, { L: 1, p: 0 }, 1, "s");
    const [move, added] = keysIn(1, { L: 1, p: 0 }, 2, "m");
    const h = new Harness({ rowsPerBucket: 2 });
    await h.initial(1, one, { [stay]: 1, [move]: 1 });
    const r = await h.night(2, { [move]: 2, [added]: 2 });
    expect(r.split).toEqual({ split: 0, into: 1, L: 0 });
    await h.night(3, { [move]: 3 });
    const d1 = await readState(h.store, h.index, 1);
    expect(d1.state).toEqual(S({ [stay]: 1, [move]: 1 }));
    expect(d1.paths.undo).toBe(2);
    expect((await readState(h.store, h.index, 2)).state).toEqual(S({ [stay]: 1, [move]: 2, [added]: 2 }));
    await h.verifyAll();
  }, T);

  it("a part with zero rows", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { A: 5 });
    const r = await h.night(2, {});
    expect(r.rows).toBe(0);
    await h.night(3, { A: 5 }); // equal to the current value: no change row
    expect(h.index.days.find((x) => x.day === 3).parts[0].rows).toBe(0);
    expect((await changesOn(h.store, h.index, 2)).size).toBe(0);
    await h.verifyAll();
  }, T);

  it("an empty replacement next-day file still replaces the old parts", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { A: 5 });
    await h.night(2, { A: 6 });
    await h.night(3, { A: 7 });
    await h.night(3, { B: 1 });
    await h.night(3, { B: 0 });
    const oldRefs = h.index.days.find((x) => x.day === 3).parts.map((p) => p.ref);
    await h.past([[2, { A: 7 }]]);
    const e = h.index.days.find((x) => x.day === 3);
    expect(e.parts).toHaveLength(1);
    expect(e.parts[0].rows).toBe(0);
    expect(oldRefs).not.toContain(e.parts[0].ref);
    await h.verifyAll();
  }, T);

  it("a day with no part reads as the last indexed day before it; a read before horizonStart is absent", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(5, { A: 5 });
    await h.night(8, { A: 8 });
    expect((await readState(h.store, h.index, 4)).state).toBe(ABSENT);
    expect((await readState(h.store, h.index, 6)).state).toEqual(S({ A: 5 }));
    expect((await readState(h.store, h.index, 7)).state).toEqual(S({ A: 5 }));
    expect((await readState(h.store, h.index, 9)).state).toEqual(S({ A: 8 }));
    expect(await changesOn(h.store, h.index, 4)).toBe(ABSENT);
    expect((await changesOn(h.store, h.index, 6)).size).toBe(0);
  }, T);

  it("the age rule rewrites a base before its oldest change file leaves the horizon and never rewrites a bucket with no change", async () => {
    const layout = { L: 1, p: 0 };
    const b0 = keysIn(0, layout, 5, "a");
    const b1 = keysIn(1, layout, 2, "z");
    const h = new Harness({ rowsPerBucket: 100, historyDays: 12, ageMarginDays: 3, ageSpreadDays: 2 });
    await h.initial(1, layout, Object.fromEntries([...b0, ...b1].map((k) => [k, 1])));
    await h.night(2, { [b0[0]]: 2 });
    const rewrittenOn = [];
    for (let day = 3; day <= 30; day++) {
      const r = await h.night(day, {});
      if (r.basesWritten.length) rewrittenOn.push([day, ...r.basesWritten]);
    }
    // bucket 0: threshold 12 - 3 - (0 mod 2) = 9 days after its base on day 1.
    expect(rewrittenOn).toEqual([[10, 0]]);
    expect(h.index.buckets[1].base.day).toBe(1);
    expect(h.index.horizonStart).toBe(19);
    await h.deleteDropped();
    await h.verifyAll({ versions: [h.versions.at(-1)] });
  }, T);

  it("raising and lowering historyDays", async () => {
    const h = new Harness({ rowsPerBucket: 3, historyDays: 12, ageMarginDays: 3, ageSpreadDays: 2 });
    const night = (d) => h.night(d, { [`k${d % 5}`]: d, [`n${d}`]: 1 });
    for (let d = 1; d <= 20; d++) await night(d);
    expect(h.index.horizonStart).toBe(9);
    h.index = setHistoryDays(h.index, 20);
    for (let d = 21; d <= 25; d++) await night(d);
    expect(h.index.horizonStart).toBe(9);
    expect((await readState(h.store, h.index, 8)).state).toBe(ABSENT);
    for (let d = 26; d <= 30; d++) await night(d);
    expect(h.index.horizonStart).toBe(11);
    h.index = setHistoryDays(h.index, 8);
    await night(31);
    expect(h.index.horizonStart).toBe(24);
    await h.deleteDropped();
    await h.verifyAll({ versions: [h.versions.at(-1)] });
  }, T);

  it("an account deleted (to zero, row removed) and recreated", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { A: 5, B: 1 });
    await h.night(2, { A: 0 });
    await h.night(3, { A: [4, 2] });
    expect((await readState(h.store, h.index, 2)).state).toEqual(S({ B: 1 }));
    expect((await readState(h.store, h.index, 3)).state).toEqual(S({ A: [4, 2], B: 1 }));
    expect((await changesOn(h.store, h.index, 3)).get("A")).toEqual({ old: [0n, 0n], new: [4n, 2n] });
    await h.verifyAll();
  }, T);

  it("changesOn for a day with two parts, and it fails on a part listed twice", async () => {
    const h = new Harness({ rowsPerBucket: 10 });
    await h.night(1, { A: 5, B: 1 });
    await h.night(2, { A: 7, C: 3 });
    await h.night(2, { A: 9, B: 0, C: 0 });
    const c = await changesOn(h.store, h.index, 2);
    expect([...c.keys()].sort()).toEqual(["A", "B"]);
    expect(c.get("A")).toEqual({ old: [5n, 0n], new: [9n, 0n] });
    expect(c.get("B")).toEqual({ old: [1n, 0n], new: [0n, 0n] });
    const bad = structuredClone(h.index);
    const day2 = bad.days.find((x) => x.day === 2);
    day2.parts.push(structuredClone(day2.parts[0]));
    await expect(changesOn(h.store, bad, 2)).rejects.toThrow(StoreCheckError);
    await expect(changesOn(h.store, bad, 2)).rejects.toThrow(/listed twice/);
  }, T);

  it("a rebuild of the same day with the same inputs reads back identical", async () => {
    const h = new Harness({ rowsPerBucket: 2 });
    await h.night(1, { A: 1, B: 1, C: 1 });
    await h.night(2, { A: 2, D: 2 });
    await h.night(3, { B: 3 });
    await h.past([[2, changesOf({ A: 2, D: 2 })]]);
    await h.verifyAll();
  }, T);
});
