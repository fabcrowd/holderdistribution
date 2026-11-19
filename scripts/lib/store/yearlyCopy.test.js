// Sequence (g): the yearly copy over several nights while buckets split and days are rebuilt.
import { describe, it, expect } from "vitest";
import { Harness } from "./storeTestKit.js";
import { fmt } from "./storeTestKit.js";
import { startYearlyCopy, runYearlyCopyNight, readCopySlice, copyStatus } from "./yearlyCopy.js";
import { bucketCount } from "./buckets.js";

const T = 30000;

function grow(day, n) {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${day}_${i}`, day + i]));
}

async function copyNight(h, night) {
  const r = await runYearlyCopyNight({ store: h.store, index: h.index, night });
  h.index = r.index;
  return r.written;
}

async function copyState(h) {
  const out = {};
  const B = bucketCount(h.index.copy);
  for (let s = 0; s < B; s++) {
    for (const [k, v] of await readCopySlice(h.store, h.index, s)) out[k] = fmt(v);
  }
  return out;
}

describe("the yearly copy", () => {
  it("(g) is sliced by the copy day's layout, survives splits, a failed night and rebuilds", async () => {
    const h = new Harness({ rowsPerBucket: 4, copySpreadNights: 4 });
    for (let d = 1; d <= 3; d++) await h.night(d, grow(d, 8)); // copy day is 3
    h.index = startYearlyCopy(h.index, 3);
    const copyLayout = { L: h.index.copy.L, p: h.index.copy.p };
    const B = bucketCount(copyLayout);
    expect(B).toBeGreaterThanOrEqual(3);
    let night = 4;
    await h.night(night, grow(night, 6));
    expect(await copyNight(h, night)).toEqual([...Array(B).keys()].filter((s) => s % 4 === 0));
    night = 5;
    await h.night(night, grow(night, 6));
    // night 5 fails for the copy: no run.
    night = 6;
    await h.night(night, grow(night, 6));
    const written6 = await copyNight(h, night);
    expect(written6).toEqual([...Array(B).keys()].filter((s) => s % 4 === 1 || s % 4 === 2));
    expect(h.index.buckets.length).toBeGreaterThan(B); // buckets split since the copy day
    // a rebuild of the day before the copy day: the copy stays valid
    night = 7;
    await h.night(night, grow(night, 2));
    await h.past([[2, { a2_0: 99 }]]);
    expect(h.index.copy.version).toBe(1);
    expect(Object.keys(h.index.copy.slices).length).toBe([...Array(B).keys()].filter((s) => s % 4 !== 3).length);
    await copyNight(h, night);
    expect(copyStatus(h.index).complete).toBe(true);
    expect(await copyState(h)).toEqual(h.expected(3));
    // a rebuild of the copy's own day: stale, rewritten from the next night
    night = 8;
    await h.night(night, grow(night, 2));
    await h.past([[3, { a3_0: 77, a1_1: 0 }]]);
    expect(h.index.copy.version).toBe(2);
    expect(copyStatus(h.index).complete).toBe(false);
    for (night = 9; night <= 13; night++) {
      await h.night(night, grow(night, 1));
      await copyNight(h, night);
    }
    expect(copyStatus(h.index).complete).toBe(true);
    expect(await copyState(h)).toEqual(h.expected(3));
    expect((await copyState(h)).a3_0).toBe("77/0");
  }, T);
});
