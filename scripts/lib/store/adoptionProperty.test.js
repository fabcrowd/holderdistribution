import { describe, expect, it } from "vitest";
import { acceptChain } from "./acceptChain.js";
import { ADOPTION_WINDOW_DAYS, UNREADABLE_PACK_DAYS } from "./storeConstants.js";
import { readBundle } from "./bundle.js";
import { entryKey } from "./manifest.js";
import { NOW, createWorld, dayPlus, publishedOf } from "./adoptionKit.js";
import { StoreNotFoundError, StoreRangeError } from "./blobStore.js";
import { adoptLane } from "./adoptionLane.js";

// Seeded histories of one kind: several runs a day, reruns with a higher attempt, packs
// shared by up to 16 coins, failed publishes (bundles nobody extends), the same pack name in
// two releases after a crash and rerun, dead uploads, releases the listing does not reach (the
// current release is 3 or 5 and the lane lists at most 2, 3 or 8), a bundle under another coin's
// label, packs and items damaged after the upload, and packs of another kind. Each seed is
// checked against an oracle that is written from the history the test itself generated and
// shares no code with adoption: a bundle is good when its pack is listed (by the listing rule,
// restated below), uploaded, intact and dated after the coin's main entry's day, its own items are
// intact, it is the coin's own bundle, and its parent is good (or is the main entry).
//
// Unreadable packs. Some uploaded, listed packs are made unreadable (not found or a failed range
// read, while the file is there), young (inside the bound) or old (past it). The oracle: a coin
// that can rule every unreadable pack out (a readable pack of the same run attempt holds a bundle
// of it, no run attempt has two such packs, and none of its readable bundles names a parent in the
// pack) gets a chain as long as the world without the fault; a coin that cannot fails while the
// packs are young, and past the bound gets the chain of the world without the bundles of those
// packs. A one-off failed read anywhere never gives a shorter chain than that world: the coin
// either fails or gets a chain as long. Packs with a same-name copy in another release are in the
// faults too, which is what the "parent in the unreadable pack" evidence rule is for.
//
// SEEDS: 30 by default (about 30 s), overridden by ADOPTION_PROPERTY_SEEDS for long runs. The
// default must reach every kind in FAULT_KINDS, which the test asserts.
const SEEDS = Number(process.env.ADOPTION_PROPERTY_SEEDS ?? 30);
const KIND = "holders";
const MAIN_DAY = "2026-11-01";
const DAY_MS = 86400000;
const NOW_MS = Date.parse(NOW);
// T of every lane here: all main days are MAIN_DAY, before the window's floor, so the floor it is.
const FLOOR_MS = NOW_MS - ADOPTION_WINDOW_DAYS * DAY_MS;
const BOUND_MS = UNREADABLE_PACK_DAYS * DAY_MS;
const tagOf = (n) => `data-live-${n}`;

// Every kind of fault or shape the generator can produce, counted over the seeds run, so that a
// small default cannot silently stop covering one (asserted at the end of the test).
const FAULT_KINDS = ["calm", "top:3", "top:5", "max:2", "max:3", "max:8", "backwards-day", "state:starter", "pack:truncate", "pack:magic", "item:bundle", "item:base", "item:blob", "swap", "ledger", "copy",
  "unreadable:young:notfound", "unreadable:young:range", "unreadable:old:notfound", "unreadable:old:range", "unreadable:failed-coin", "unreadable:copied-pack", "read-failure:injected"];
const FAULTS = new Map();
const hit = (kind) => FAULTS.set(kind, (FAULTS.get(kind) ?? 0) + 1);

const rng = (seed) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

async function generate(seed, w) {
  const r = rng(seed);
  const chance = (p) => r() < p;
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const one = (list) => list[Math.floor(r() * list.length)];
  const slugs = Array.from({ length: one([1, 2, 3, 5, 16]) }, (_, i) => `coin-${i}`);
  const top = one([3, 3, 5]); // the current release
  const maxReleases = one([2, 3, 8]); // how many releases the lane may list
  hit(`top:${top}`);
  hit(`max:${maxReleases}`);
  const mains = {};
  for (const [i, slug] of slugs.entries()) mains[slug] = chance(0.8) ? await w.one({ slug, day: MAIN_DAY, run: 1, lane: i, release: "data-live-1" }) : null;
  const nodes = new Map(); // key -> oracle facts
  const lastOf = Object.fromEntries(slugs.map((s) => [s, mains[s]]));
  const laneSize = one([1, 3, 16]);
  let runId = 10;
  // A calm history has no faults and 17 to 21 days, so chains reach and pass the cap.
  const calm = chance(0.25);
  if (calm) hit("calm");
  const days = calm ? int(17, 21) : int(1, 19);
  for (let d = 0; d <= days; d++) {
    for (let k = calm ? 1 : int(1, 2); k > 0; k--) {
      runId++;
      const attempts = !calm && chance(0.25) ? 2 : 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const active = slugs.filter(() => calm || chance(0.75));
        for (let at = 0; at < active.length; at += laneSize) {
          // A late rerun of an older run uploads a pack with an earlier day: days go backwards.
          const shift = !calm && chance(0.1) ? Math.max(0, d - int(1, 3)) : d;
          if (shift < d) hit("backwards-day");
          const day = dayPlus(MAIN_DAY, shift);
          await writeLane({ group: active.slice(at, at + laneSize), laneNo: at / laneSize, day, runId, attempt, createdAt: `${dayPlus(MAIN_DAY, d)}T04:00:00Z` });
        }
      }
    }
  }

  function parentFor(slug) {
    const mine = [...nodes.values()].filter((n) => n.slug === slug);
    if (calm) return lastOf[slug] ?? mains[slug];
    if (mine.length === 0 || chance(0.15)) return mains[slug];
    return chance(0.7) ? lastOf[slug] ?? mains[slug] : one(mine).rec;
  }

  // `createdAt` follows the order of writing, not the (possibly earlier) data day of a late rerun.
  async function writeLane({ group, laneNo, day, runId: run, attempt, createdAt }) {
    const state = !calm && chance(0.07) ? "starter" : "uploaded";
    const release = calm ? tagOf(top) : one([tagOf(top), tagOf(top), tagOf(top), ...Array.from({ length: top - 1 }, (_, i) => tagOf(i + 1))]);
    const specs = group.map((slug) => ({ slug, parent: parentFor(slug) ?? undefined, as: !calm && chance(0.03) && slugs.length > 1 ? one(slugs.filter((s) => s !== slug)) : undefined }));
    if (state === "starter") hit("state:starter");
    if (specs.some((x) => x.as)) hit("swap");
    const pack = await w.writePack({ day, run, attempt, lane: laneNo, release, state, coins: specs, salt: String(runId), createdAt });
    const packBroken = !calm && chance(0.06) ? one(["truncate", "magic"]) : null;
    if (packBroken) {
      w.damage(pack, packBroken);
      hit(`pack:${packBroken}`);
    }
    if (!calm && chance(0.1)) {
      hit("ledger");
      await w.one({ slug: one(slugs), kind: "ledger", day, run: run + 1000, attempt, lane: 90 + laneNo, release: tagOf(top) });
    }
    for (const s of specs) {
      const rec = pack.coins[s.slug];
      const itemBroken = !calm && !packBroken && chance(0.05) ? one(["bundle", "base", "blob"]) : null;
      if (itemBroken) {
        w.damage(rec, itemBroken);
        hit(`item:${itemBroken}`);
      }
      nodes.set(rec.key, { slug: s.slug, rec, parentKey: s.parent ? s.parent.key : null, day, run, attempt, release: pack.release, loc: pack.loc, headerOk: !packBroken, copied: false, uploaded: state === "uploaded", intact: !packBroken && !itemBroken, bundleOk: itemBroken !== "bundle", own: !s.as });
      lastOf[s.slug] = rec;
    }
    if (!calm && chance(0.1)) {
      const copy = await w.writePack({ day, run, attempt, lane: laneNo, release: one(Array.from({ length: top }, (_, i) => tagOf(i + 1)).filter((x) => x !== release)), coins: specs, salt: `dup${runId}`, createdAt });
      hit("copy");
      for (const s of specs) {
        const rec = copy.coins[s.slug];
        nodes.get(pack.coins[s.slug].key).copied = true;
        nodes.set(rec.key, { slug: s.slug, rec, parentKey: s.parent ? s.parent.key : null, day, run, attempt, release: copy.release, loc: copy.loc, headerOk: true, copied: true, uploaded: true, intact: true, bundleOk: true, own: !s.as });
      }
    }
  }
  return { slugs, mains, nodes, top, maxReleases };
}

// The listing rule, restated from the history: the two newest releases, then the releases that
// exist, one at a time, until the lowest listed is release 1 or holds an asset created before T,
// or `maxReleases` are listed. Assets are the packs of every kind and state in the folder.
function listedTags(packs, { top, maxReleases }) {
  const here = (n) => packs.filter((p) => p.release === tagOf(n));
  const listed = [];
  for (let n = top; n >= 1 && listed.length < Math.min(2, maxReleases); n--) listed.push(n);
  for (;;) {
    const low = listed.at(-1);
    if (low === 1 || here(low).some((p) => Date.parse(p.createdAt) < FLOOR_MS)) break;
    let below = low - 1;
    while (below >= 1 && here(below).length === 0) below--;
    if (below < 1 || listed.length >= maxReleases) break;
    listed.push(below);
  }
  return listed.map(tagOf);
}

// The oracle: for each coin, the depth of every good bundle and the longest good chain.
function oracle({ slugs, mains, nodes }, { cap, listed, exclude = new Set() }) {
  const memo = new Map();
  const good = (node, slug) => {
    if (memo.has(node.rec.key)) return memo.get(node.rec.key);
    const mainDay = mains[slug]?.entry.day ?? null;
    let ok = listed.has(node.release) && !exclude.has(node.loc) && node.uploaded && node.intact && node.own && (mainDay === null || node.day > mainDay);
    if (ok && node.parentKey !== (mains[slug]?.key ?? null)) {
      const parent = nodes.get(node.parentKey);
      // Days never go backwards: a child is on or after its parent's day.
      ok = Boolean(parent) && parent.slug === slug && parent.day <= node.day && good(parent, slug);
    }
    memo.set(node.rec.key, ok);
    return ok;
  };
  const depth = (node) => (node.parentKey === null || !nodes.has(node.parentKey) ? 1 : 1 + depth(nodes.get(node.parentKey)));
  // Deepest first; then the newest day, the higher run id, the higher attempt, the later key.
  const newer = (n, a) => {
    const x = [depth(n), n.day, n.run, n.attempt, n.rec.key];
    const y = [depth(a), a.day, a.run, a.attempt, a.rec.key];
    const i = x.findIndex((v, k) => v !== y[k]);
    return i >= 0 && x[i] > y[i];
  };
  const out = {};
  for (const slug of slugs) {
    const mine = [...nodes.values()].filter((n) => n.slug === slug && good(n, slug) && depth(n) <= cap);
    const best = mine.reduce((a, n) => (a === null || newer(n, a) ? n : a), null);
    const path = [];
    for (let n = best; n; n = nodes.get(n.parentKey)) path.unshift(n);
    out[slug] = { length: best ? depth(best) : 0, ok: new Set(mine.map((n) => n.rec.key)), longest: path.map((n) => n.rec.entry) };
  }
  return out;
}

const mainOf = (mains, slug) => (mains[slug] ? publishedOf(mains[slug]) : null);
const coinsOf = ({ slugs, mains }) => slugs.map((slug) => ({ slug, main: mainOf(mains, slug) }));
const laneArgs = (w, history, over = {}) => ({ blobs: w.blobs, ...w.listing, liveTag: tagOf(history.top), maxReleases: history.maxReleases, kind: KIND, coins: coinsOf(history), ...over });
const alertCount = (r, code) => r.alerts.find((a) => a.code === code)?.count ?? 0;

async function check({ seed, w, history, reserve }) {
  const { slugs, mains, nodes } = history;
  const tags = listedTags(w.packs, history);
  const want = oracle(history, { cap: ADOPTION_WINDOW_DAYS - reserve, listed: new Set(tags) });
  const out = await adoptLane(laneArgs(w, history, { reserve }));
  const why = (slug) => `seed ${seed} reserve ${reserve} ${slug}`;
  expect(out.listing.tags, `seed ${seed} listing`).toEqual(tags);
  expect(out.listing.requests, `seed ${seed} listing`).toBeLessThanOrEqual(9 * tags.length + 1);
  for (const slug of slugs) {
    const r = out.coins[slug];
    const main = mainOf(mains, slug);
    expect(r.failed, why(slug)).toBe(false);
    expect(r.chain.length, `${why(slug)}: longest good chain`).toBe(want[slug].length);
    expect(r.chain, `${why(slug)}: the oracle's chain`).toEqual(want[slug].longest);
    for (const e of r.chain) {
      expect(want[slug].ok.has(entryKey(e)), `${why(slug)}: ${e.bundle.ref} is not good`).toBe(true);
      const bundle = await readBundle({ blobs: w.blobs, slug, kind: KIND, bundleRef: e.bundle });
      expect([bundle.slug, bundle.kind], why(slug)).toEqual([slug, KIND]);
    }
    if (r.chain.length > 0) {
      const judged = await acceptChain({ blobs: w.blobs, slug, kind: KIND, main, chain: r.chain });
      expect(judged.status, `${why(slug)}: acceptChain ${JSON.stringify(judged)}`).toBe("accepted");
      expect(judged.entries).toEqual(r.chain);
      expect(r.start, why(slug)).toMatchObject({ source: "adopted", entry: r.chain.at(-1) });
      if (reserve === 1) await ownEntryFits({ w, slug, main, r, nodes, why: why(slug) });
    } else if (main) {
      expect(r.start, why(slug)).toEqual({ source: "main", entry: main, bundle: null });
      await readBundle({ blobs: w.blobs, slug, kind: KIND, bundleRef: r.start.entry.bundle });
    } else {
      expect(r.start, why(slug)).toBeNull();
    }
  }
}

// The run's own entry on top of the adopted chain must still pass the publish side.
async function ownEntryFits({ w, slug, main, r, nodes, why }) {
  const last = nodes.get(entryKey(r.chain.at(-1))).rec;
  // In release 9, above the current one, so it is never listed and never becomes a candidate.
  const own = await w.one({ slug, day: dayPlus(MAIN_DAY, 40), run: 9999, lane: Number(slug.slice(5)) + 1, parent: last, release: tagOf(9) });
  const judged = await acceptChain({ blobs: w.blobs, slug, kind: KIND, main, chain: [...r.chain, own.entry] });
  expect(judged.status, `${why}: adopted chain plus own entry ${JSON.stringify(judged)}`).toBe("accepted");
}

// The faults of the unreadable phases: the picked packs fail every read (the file is still there,
// so stat finds it), and every pack created since the floor is given `ageMs` of age in the
// listing (the rule of the listing is not touched: only assets created before the floor count
// there, and those keep their age).
function faulty(w, { locs = new Set(), ageMs, fail }) {
  const blobs = { ...w.blobs, readRange: async (loc, off, len) => { if (locs.has(loc)) throw fail(); return w.blobs.readRange(loc, off, len); } };
  const listRelease = async (tag) => {
    const got = await w.listRelease(tag);
    const aged = (e) => (Date.parse(e.createdAt) >= FLOOR_MS ? { ...e, createdAt: new Date(NOW_MS - ageMs).toISOString() } : e);
    return { ...got, entries: got.entries.map(aged) };
  };
  return { blobs, listing: { ...w.listing, listRelease } };
}

// Packs of the history by location, with their coins and the facts the oracle needs.
function packsOf(history, w) {
  const byLoc = new Map();
  for (const n of history.nodes.values()) {
    const p = byLoc.get(n.loc) ?? { loc: n.loc, day: n.day, run: n.run, attempt: n.attempt, release: n.release, headerOk: n.headerOk, uploaded: n.uploaded, copied: n.copied, coins: new Set() };
    p.coins.add(n.slug);
    byLoc.set(n.loc, p);
  }
  return [...byLoc.values()].map((p) => ({ ...p, createdAt: w.packs.find((x) => x.loc === p.loc).createdAt }));
}

// The unreadable packs this coin cannot rule out: the oracle of the unreadable phase. A pack is
// ruled out when a readable pack of its run attempt holds a bundle of the coin and no run attempt
// has two; never when a readable bundle of the coin names a parent in that pack.
function blockersOf({ slug, history, packs, picked, listed }) {
  const mainDay = history.mains[slug]?.entry.day ?? null;
  const after = (p) => mainDay === null || p.day > mainDay;
  const key = (p) => `${p.run}.${p.attempt}`;
  const readableHere = (p) => p.uploaded && listed.has(p.release) && after(p) && p.headerOk && !picked.has(p.loc);
  const readable = packs.filter((p) => readableHere(p) && p.coins.has(slug));
  const per = new Map();
  for (const p of readable) per.set(key(p), (per.get(key(p)) ?? 0) + 1);
  const twice = [...per.values()].some((n) => n > 1);
  const readableLocs = new Set(packs.filter(readableHere).map((p) => p.loc));
  const evidence = new Set();
  for (const n of history.nodes.values()) {
    const parent = n.parentKey ? history.nodes.get(n.parentKey) : null;
    if (n.slug === slug && n.own && n.bundleOk && readableLocs.has(n.loc) && parent && picked.has(parent.loc)) evidence.add(parent.loc);
  }
  return packs.filter((p) => picked.has(p.loc) && after(p)).filter((p) => twice || evidence.has(p.loc) || per.get(key(p)) !== 1);
}

// Unreadable packs, young or old, not found or a failed range read; the four combinations cycle
// with the seed, so every one is reached.
async function unreadablePacks({ seed, w, history, baseline }) {
  const tags = new Set(listedTags(w.packs, history));
  const packs = packsOf(history, w);
  const pool = packs.filter((p) => p.uploaded && tags.has(p.release) && Date.parse(p.createdAt) >= FLOOR_MS);
  if (pool.length === 0) return 0;
  const pick = rng(seed * 104729);
  const chosen = pool.filter(() => pick() < 0.3);
  // A pack with a same-name copy is picked on purpose when there is one: the evidence rule is for it.
  const withCopy = pool.filter((p) => p.copied);
  if (withCopy.length > 0 && pick() < 0.7) chosen.push(withCopy[Math.floor(pick() * withCopy.length)]);
  const picked = new Set((chosen.length > 0 ? chosen : [pool[Math.floor(pick() * pool.length)]]).map((p) => p.loc));
  const young = seed % 2 === 0;
  const notFound = seed % 4 < 2;
  hit(`unreadable:${young ? "young" : "old"}:${notFound ? "notfound" : "range"}`);
  if (packs.some((p) => picked.has(p.loc) && p.copied)) hit("unreadable:copied-pack");
  const fail = notFound ? () => new StoreNotFoundError("not found: 404") : () => new StoreRangeError("short body after 3 attempts");
  const fault = faulty(w, { locs: picked, ageMs: young ? DAY_MS : BOUND_MS + DAY_MS, fail });
  const out = await adoptLane(laneArgs(w, history, { blobs: fault.blobs, ...fault.listing }));
  const readableWorld = oracle(history, { cap: ADOPTION_WINDOW_DAYS - 1, listed: tags, exclude: picked });
  let failedCoins = 0;
  for (const slug of history.slugs) {
    const r = out.coins[slug];
    const blockers = blockersOf({ slug, history, packs, picked, listed: tags });
    const label = `seed ${seed} ${slug} (${young ? "young" : "old"}, ${blockers.length} blockers)`;
    if (young && blockers.length > 0) {
      expect([r.failed, r.chain], label).toEqual([true, null]);
      expect(alertCount(r, "unreadable"), label).toBe(blockers.length);
      failedCoins++;
      hit("unreadable:failed-coin");
    } else {
      expect(r.failed, label).toBe(false);
      expect(r.chain, label).toEqual(readableWorld[slug].longest);
      if (blockers.length === 0) expect(r.chain.length, `${label}: ruled out, so a chain as long as the world without the fault`).toBe(baseline.coins[slug].chain.length);
      expect(alertCount(r, "unreadable-dropped"), label).toBe(young ? 0 : blockers.length);
    }
  }
  return failedCoins;
}

// One failed read, anywhere in the run, inside the bound: the coin fails, or has a chain as long as
// the run without the failure; never a shorter one. Reads of packs created before the floor are
// skipped: those are past the bound.
async function transientFailure({ seed, w, history, baseline }) {
  let reads = 0;
  const aged = faulty(w, { ageMs: DAY_MS, fail: () => new Error("unused") });
  const counting = { ...w.blobs, readRange: async (loc, off, len) => { reads++; return w.blobs.readRange(loc, off, len); } };
  await adoptLane(laneArgs(w, history, { blobs: counting, ...aged.listing }));
  if (reads === 0) return;
  const pick = rng(seed * 7919);
  for (let attempt = 0; attempt < 3; attempt++) {
    const k = 1 + Math.floor(pick() * reads);
    const error = k % 2 === 0 ? new StoreRangeError("short body after 3 attempts") : new StoreNotFoundError("not found: 404");
    let calls = 0;
    let failedLoc = null;
    const flaky = { ...w.blobs, readRange: async (loc, off, len) => { if (++calls === k) { failedLoc = loc; throw error; } return w.blobs.readRange(loc, off, len); } };
    const result = await adoptLane(laneArgs(w, history, { blobs: flaky, ...aged.listing }));
    const created = w.packs.find((p) => p.loc === failedLoc)?.createdAt;
    if (!created || Date.parse(created) < FLOOR_MS) continue;
    hit("read-failure:injected");
    for (const slug of history.slugs) {
      const r = result.coins[slug];
      if (!r.failed) expect(r.chain.length, `seed ${seed} read ${k} ${slug}: a failed read must not shorten a chain`).toBe(baseline.coins[slug].chain.length);
    }
  }
}

describe(`adoption over generated histories (${SEEDS} seeds, ADOPTION_PROPERTY_SEEDS to change)`, () => {
  it("the adopted chain passes acceptChain, is the longest good chain, holds no bundle of another coin or kind, and its start reads", async () => {
    let adoptedSomething = 0;
    let droppedSomething = 0;
    let failedForPacks = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = createWorld();
      try {
        const history = await generate(seed, w);
        for (const reserve of [1, 0]) {
          await check({ seed, w, history, reserve });
        }
        const out = await adoptLane(laneArgs(w, history));
        adoptedSomething += Object.values(out.coins).filter((c) => c.chain.length > 0).length;
        droppedSomething += Object.values(out.coins).filter((c) => c.why.some((l) => /bad hash|cannot be read|broken link|outside the listing|does not reach back|goes backwards/.test(l))).length;
        await transientFailure({ seed, w, history, baseline: out });
        failedForPacks += await unreadablePacks({ seed, w, history, baseline: out });
        const solo = history.slugs[seed % history.slugs.length];
        const alone = await adoptLane(laneArgs(w, history, { coins: [{ slug: solo, main: mainOf(history.mains, solo) }] }));
        expect(alone.coins[solo], `seed ${seed}: a lane of one coin gives the same answer as a lane of many`).toEqual(out.coins[solo]);
      } finally {
        w.cleanup();
      }
    }
    // The generator must reach the interesting cases, or the proof proves nothing.
    expect(adoptedSomething).toBeGreaterThan(SEEDS / 2);
    expect(droppedSomething).toBeGreaterThan(SEEDS / 10);
    expect(failedForPacks).toBeGreaterThan(SEEDS / 20);
    for (const kind of FAULT_KINDS) expect(FAULTS.get(kind) ?? 0, `fault kind ${kind} never occurred in ${SEEDS} seeds`).toBeGreaterThan(0);
  }, 600_000);
});
