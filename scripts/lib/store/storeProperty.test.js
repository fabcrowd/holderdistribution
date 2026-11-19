// Seeded property test: random nights, splits, base rewrites, past-day rewrites,
// burst days and a yearly copy (started mid-run, reset by parts on its day and by
// rewrites, sometimes outlived by the horizon), compared with an independent model of
// one Map snapshot per day. STORE_SEEDS raises the seed count for a local run.
import { describe, it, expect } from "vitest";
import { Harness, rng, val, fmt } from "./storeTestKit.js";
import { changesOn } from "./tableRead.js";
import { startYearlyCopy, runYearlyCopyNight, readCopySlice, copyStatus } from "./yearlyCopy.js";
import { bucketOf, bucketCount } from "./buckets.js";

const ACCOUNTS = 300;
const DAYS = 45;
const SEEDS = Number(process.env.STORE_SEEDS ?? 20);

function randomChanges(next, max) {
  const out = new Map();
  const n = Math.floor(next() * max);
  for (let i = 0; i < n; i++) {
    const key = `acct${Math.floor(next() * ACCOUNTS)}`;
    const r = next();
    out.set(key, r < 0.15 ? val(0) : val(1 + Math.floor(next() * 1000), r < 0.3 ? Math.floor(next() * 50) : 0));
  }
  return out;
}

function burst(day, rows) {
  return new Map(Array.from({ length: rows * 2 }, (_, i) => [`burst${day}_${i}`, val(i + 1)]));
}

// Every slice written tonight must equal the model's end of the copy day in that slice.
async function copyNight(h, night, stats) {
  const r = await runYearlyCopyNight({ store: h.store, index: h.index, night });
  h.index = r.index;
  if (r.status === "unreachable") {
    expect(r.written).toEqual([]);
    stats.unreachable++;
    return;
  }
  const c = h.index.copy;
  const want = h.modelOn(h.model, c.asOf);
  for (const s of r.written) {
    const got = Object.fromEntries([...(await readCopySlice(h.store, h.index, s))].map(([k, v]) => [k, fmt(v)]));
    const exp = Object.fromEntries([...want].filter(([k]) => bucketOf(k, c) === s));
    expect(got).toEqual(exp);
  }
  if (copyStatus(h.index).complete) stats.complete++;
}

async function pastRewrite(h, next, day, stats) {
  const c = h.index.copy;
  if (c && h.index.horizonStart === c.asOf && c.asOf < day && next() < 0.7) {
    await h.past([[c.asOf, randomChanges(next, 10)]]); // reset just before the horizon passes it
    stats.resets++;
    return;
  }
  const indexed = h.index.days.map((x) => x.day).filter((d) => d >= h.index.horizonStart + 1 && d < day);
  if (indexed.length < 2) return;
  const d1 = indexed[Math.floor(next() * (indexed.length - 1))];
  const len = 1 + Math.floor(next() * 2);
  const list = [];
  for (let d = d1; d < d1 + len && d < day; d++) list.push([d, randomChanges(next, 30)]);
  if (c && list.some(([d]) => d === c.asOf)) stats.resets++;
  await h.past(list);
}

async function runSeed(seed, stats) {
  const next = rng(seed);
  const h = new Harness({ rowsPerBucket: 12, historyDays: 30, ageMarginDays: 4, ageSpreadDays: 3, copySpreadNights: 4 });
  // After each write the newest version is read from the written day on; every day of
  // every version is read only at the end, on the newest and a fixed sample (every tenth) of older ones.
  h.verifyEachWrite = true;
  const rewriteNights = new Set([12, 25, 37].map((d) => d + Math.floor(next() * 3)));
  const copyDay = 5 + Math.floor(next() * 6);
  const burstDay = 3 + Math.floor(next() * 30);
  for (let day = 1; day <= DAYS; day++) {
    const r = next();
    if (day > 1 && r < 0.1 && day !== copyDay) continue; // a day with no part
    const rows = h.index.buckets.reduce((s, b) => s + b.count, 0);
    await h.night(day, day === burstDay ? burst(day, rows) : randomChanges(next, 40));
    if (day === copyDay) {
      h.index = startYearlyCopy(h.index, day);
      await copyNight(h, day, stats);
      if (next() < 0.5) {
        await h.night(day, randomChanges(next, 15)); // a part on the copy day: reset
        stats.resets++;
      }
    } else if (r > 0.8) {
      await h.night(day, randomChanges(next, 15));
    }
    const c = h.index.copy;
    const atEdge = c && seed % 3 === 0 && h.index.horizonStart === c.asOf;
    if (atEdge || rewriteNights.has(day)) await pastRewrite(h, next, day, stats);
    if (h.index.copy && day > copyDay) await copyNight(h, day, stats);
  }
  const sample = h.versions.filter((_, i) => i % 10 === 0 || i === h.versions.length - 1);
  const paths = await h.verifyAll({ versions: sample });
  for (let d = h.index.horizonStart + 1; d <= DAYS; d++) {
    const got = await changesOn(h.store, h.index, d);
    const a = h.modelOn(h.model, d - 1);
    const b = h.modelOn(h.model, d);
    const want = new Map();
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(k) !== b.get(k)) want.set(k, `${a.get(k) ?? "0/0"}>${b.get(k) ?? "0/0"}`);
    }
    const gotFlat = new Map([...got].map(([k, x]) => [k, `${fmt(x.old)}>${fmt(x.new)}`]));
    expect(Object.fromEntries(gotFlat)).toEqual(Object.fromEntries(want));
  }
  const status = copyStatus(h.index);
  if (status.complete) {
    const all = {};
    for (let s = 0; s < bucketCount(h.index.copy); s++) for (const [k, v] of await readCopySlice(h.store, h.index, s)) all[k] = fmt(v);
    expect(all).toEqual(Object.fromEntries(h.modelOn(h.model, h.index.copy.asOf)));
  }
  await h.deleteDropped();
  await h.verifyAll({ versions: [h.versions.at(-1)] });
  return { paths, buckets: h.index.buckets.length };
}

describe("store property test", () => {
  it(`matches the model on every day for ${SEEDS} seeds`, async () => {
    const stats = { forward: 0, undo: 0, resets: 0, unreachable: 0, complete: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      try {
        const r = await runSeed(seed, stats);
        stats.forward += r.paths.forward;
        stats.undo += r.paths.undo;
        expect(r.buckets).toBeGreaterThan(4);
      } catch (err) {
        console.error(`property test failed for seed ${seed}`);
        throw err;
      }
    }
    console.log(`property: ${SEEDS} seeds ${JSON.stringify(stats)}`);
    expect(stats.forward).toBeGreaterThan(0);
    expect(stats.undo).toBeGreaterThan(0);
    expect(stats.resets).toBeGreaterThan(0);
    expect(stats.unreachable).toBeGreaterThan(0);
    expect(stats.complete).toBeGreaterThan(0);
  }, SEEDS * 30000);
});
