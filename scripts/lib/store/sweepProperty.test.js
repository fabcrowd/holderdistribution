// Seeded property test of the sweep's safety (design 2.1 section 4.3, 10(h), 10(j)): over
// generated nights, after every sweep
//   - every location in every readable coin's reference set still exists and its pack reads;
//   - no pack that lists an unreadable coin was deleted, and none that lists a removed coin
//     before its hold ended (a removed mark on a coin that has references is ignored);
//   - no `keep` object and no name that is not a store name was touched, and exactly the
//     planned objects are gone;
//   - the current site root and the 16 before it all remain;
//   - no release was deleted that is the newest of its series, or whose next higher release was
//     made (by its recorded instant, or published_at when later) less than 24 h ago or at an
//     unknown time, and none that still held an object the sweep did not delete; created_at of a
//     release is set to a random time, so reading it would fail the test;
//   - no deleted site root, or copy of one in a second release, was younger than the live wait,
//     and none with an unknown creation time; the protected ones (the current root's location and
//     the 16 older names, copies included) all remain;
//   - a pack with no creation time is never deleted when its rule counts elapsed time; a hist pack
//     of a readable coin with no oldest-needed day stays; a reference may name a dead upload or a
//     garbage-header pack, which then stays; historyDays is one of three values;
//   - nothing is kept that should have gone (uncapped): no unreferenced live pack older than the
//     wait whose coins are all readable, and no unreferenced dead upload older than a day;
//   - a second sweep with nothing changed deletes nothing more than the plan already said
//     (nothing at all when the first one was not capped).
// A night has up to 20 coins (readable, unreadable, removed), packs listing up to 16 of them
// in the live, hist and events series, a pack name in two releases after a rerun, dead
// uploads, packs that list a coin nobody classified, empty releases, and site roots.
// The number of seeds is SWEEP_SEEDS (default 60).
import { describe, it, expect } from "vitest";
import { runSweep } from "./sweep.js";
import { createFakeReleaseServer } from "./fakeReleaseServer.js";
import { openPack } from "./pack.js";
import { rng } from "./storeTestKit.js";
import { packName, siteRootName } from "./packNames.js";
import { ok, unreadable, packBytes, putObject, backendOn, exists, sweepArgs } from "./sweepKit.js";

const SEEDS = Number(process.env.SWEEP_SEEDS ?? 60);
// The time rules are written again here with raw Date arithmetic and no import from the code
// under test, so a shared mistake in the day or hour arithmetic cannot pass both.
const MS_DAY = 86_400_000;
const WAIT_DAYS = 18; // live wait, hours: 18 x 24
const HOLD_DAYS = 30; // removed-coin hold, days
const KEPT_ROOTS = 16;
const midnight = (day) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (later, earlier) => Math.round((midnight(later) - midnight(earlier)) / MS_DAY);
// Times of day near midnight and near noon, so ages cross a calendar day by a few minutes.
const TIMES = ["00:00:00", "00:00:30", "00:01:00", "11:59:59", "12:00:00", "23:58:00", "23:59:00", "23:59:59"];
// Distances from a boundary: a second, two minutes, an hour, on each side, and exact.
const NEAR = [-1000, 0, 1000, -120_000, 120_000, -3_600_000, 3_600_000];
const SERIES = ["live", "hist", "events"];
const HISTORY_CHOICES = [371, 400, 450];

const pick = (r, list) => list[Math.floor(r() * list.length)];
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const sample = (r, list, n) => [...list].sort(() => r() - 0.5).slice(0, n);

function genClock(r) {
  const time = r() < 0.7 ? pick(r, TIMES) : `${String(between(r, 0, 23)).padStart(2, "0")}:${String(between(r, 0, 59)).padStart(2, "0")}:00`;
  const nowMs = Date.parse(`2026-11-19T${time}Z`);
  const today = dayOf(nowMs);
  return { nowMs, now: new Date(nowMs).toISOString(), today, historyDays: pick(r, HISTORY_CHOICES), daysAgo: (n) => dayOf(midnight(today) - n * MS_DAY) };
}

// How long ago an asset was created, for an upload that is dead or live: half the time within
// a second to an hour of the boundary that decides it.
function genElapsed(r, dead) {
  if (r() < 0.5) return (dead ? MS_DAY : WAIT_DAYS * MS_DAY) + pick(r, NEAR);
  return between(r, 0, (dead ? 3 : 45) * MS_DAY) + between(r, 0, MS_DAY - 1);
}

function genCoins(r, clock) {
  const n = between(r, 3, 20);
  const coins = { readable: [], unreadable: [], removed: new Map(), returned: new Set() };
  for (let i = 0; i < n; i++) {
    const slug = `c${i}`;
    const x = r();
    if (x < 0.55 || i === 0) coins.readable.push(slug);
    else if (x < 0.78) coins.unreadable.push(slug);
    else coins.removed.set(slug, clock.daysAgo(between(r, 0, 60)));
  }
  // A coin marked removed that is back in the registry (readable or unreadable): the mark must not hold or stop anything.
  for (const slug of [...coins.readable, ...coins.unreadable]) {
    if (r() < 0.15) {
      coins.removed.set(slug, clock.daysAgo(between(r, 0, 60)));
      coins.returned.add(slug);
    }
  }
  return coins;
}

async function genPacks(r, server, coins, clock) {
  const all = [...new Set([...coins.readable, ...coins.unreadable, ...coins.removed.keys()])];
  const packs = [];
  const count = between(r, 25, 60);
  for (let i = 0; i < count; i++) {
    const series = pick(r, SERIES);
    const nameDay = clock.daysAgo(series === "live" ? between(r, 0, 60) : series === "hist" ? between(r, 0, 450) : between(r, 0, 12));
    const name = packName({ cls: series, kind: "holders", day: nameDay, run: i + 1, attempt: 1, lane: between(r, 0, 3), flush: 0 });
    const dead = r() < 0.08;
    const garbage = !dead && r() < 0.05; // stored whole but its header cannot be read
    const listed = dead || garbage ? [] : sample(r, all, between(r, 0, Math.min(16, all.length)));
    if (!dead && r() < 0.06) listed.push("stranger");
    const bytes = dead ? Buffer.from("HDB1 half") : garbage ? Buffer.from("garbage, not a pack") : await packBytes({ cls: series, day: nameDay, slugs: listed.length ? listed : ["c0"] });
    if (!dead && !garbage && !listed.length) listed.push("c0");
    const elapsedMs = genElapsed(r, dead);
    const noCreated = r() < 0.07; // an asset the server gives no creation time for
    const copies = r() < 0.15 ? [1, 2] : [between(r, 1, 3)];
    for (const seq of copies) {
      const loc = putObject(server, `data-${series}-${seq}`, name, bytes, { createdAt: noCreated ? null : new Date(clock.nowMs - elapsedMs).toISOString(), state: dead ? "starter" : "uploaded" });
      packs.push({ loc, series, name, nameDay, listed: [...listed], dead, garbage, elapsedMs, noCreated });
    }
  }
  return packs;
}

function genSite(r, server, clock) {
  const m = between(r, 0, 24);
  const roots = [];
  const copies = [];
  for (let i = 0; i < m; i++) {
    const day = clock.daysAgo(60 - i);
    const name = siteRootName({ day, run: i + 1, attempt: 1, try: 1 });
    const put = (tag) => {
      const elapsedMs = r() < 0.06 ? null : r() < 0.4 ? WAIT_DAYS * MS_DAY + pick(r, NEAR) : between(r, 0, 40 * MS_DAY);
      return { loc: putObject(server, tag, name, Buffer.from(`{"root":${i}}`), { createdAt: elapsedMs === null ? null : new Date(clock.nowMs - elapsedMs).toISOString() }), name, index: i, elapsedMs };
    };
    roots.push(put("data-site-1"));
    if (r() < 0.2) copies.push(put("data-site-2")); // a copy of the name in a second release (a rerun)
  }
  const at = m ? m - 1 - between(r, 0, Math.min(3, m - 1)) : null;
  return { roots, copies, current: at === null ? null : roots[at].loc, currentIndex: at };
}

function genJunk(r, server, clock) {
  const junk = [];
  for (let i = 0; i < between(r, 0, 3); i++) {
    const tag = `data-${pick(r, [...SERIES, "site"])}-1`;
    junk.push(putObject(server, tag, pick(r, [`notes${i}.txt`, `p.live.holders.2026-02-31.r${i + 1}a1.l0f0.hdb`, `README${i}`]), Buffer.from("x"), { createdAt: new Date(clock.nowMs - 90 * MS_DAY).toISOString() }));
  }
  return junk;
}

function genReferences(r, coins, packs, clock) {
  const pool = packs.filter((p) => !p.dead && !p.garbage).map((p) => p.loc);
  const odd = packs.filter((p) => p.dead || p.garbage).map((p) => p.loc); // a reference may name a dead upload or a garbage-header pack
  const refs = {};
  const needed = {};
  for (const slug of coins.readable) {
    refs[slug] = ok(slug, [...sample(r, pool, between(r, 0, 6)), ...(r() < 0.3 ? sample(r, odd, between(r, 1, 2)) : [])]);
    if (r() >= 0.12) needed[slug] = clock.daysAgo(between(r, 0, 450)); // else: a readable coin with no oldest-needed day
  }
  for (const slug of coins.unreadable) refs[slug] = unreadable(slug);
  return { refs, needed };
}

const seqOf = (tag) => Number(tag.split("-").at(-1));
const tagsOf = (server, s) => server.releases.filter((x) => x.tag_name.startsWith(`data-${s}-`)).map((x) => x.tag_name);

// The newest release of each series, or (a quarter of the time) a stale one a caller might still hold.
function currentReleases(r, server) {
  const out = {};
  for (const s of [...SERIES, "site"]) {
    const tags = tagsOf(server, s);
    const newest = `data-${s}-${Math.max(1, ...tags.map(seqOf))}`;
    out[s] = tags.length && r() < 0.25 ? pick(r, tags) : newest;
  }
  return out;
}

// Each release is recorded as made a day before now, give or take a second to an hour, or long ago; one in
// ten has no record; a fifth has a published_at, earlier or later than the record. created_at is random.
// Returns tag -> the instant the release is as young as the evidence says (ms), or null when unknown.
function stampReleases(r, server, clock) {
  const made = new Map();
  for (const rel of server.releases) {
    rel.created_at = new Date(clock.nowMs - between(r, 0, 3 * MS_DAY)).toISOString();
    rel.published_at = null;
    if (r() < 0.1) {
      rel.body = "written by hand";
      made.set(rel.tag_name, null);
      continue;
    }
    const recorded = clock.nowMs - (r() < 0.5 ? MS_DAY + pick(r, NEAR) : between(r, 0, 60 * MS_DAY));
    rel.body = JSON.stringify({ schema: 1, createdAt: new Date(recorded).toISOString() });
    let youngest = recorded;
    if (r() < 0.2) {
      const published = recorded + pick(r, [-2 * MS_DAY, -1000, 1000, 3_600_000, 5 * MS_DAY]);
      rel.published_at = new Date(Math.min(published, clock.nowMs)).toISOString();
      youngest = Math.max(recorded, Math.min(published, clock.nowMs));
    }
    made.set(rel.tag_name, youngest);
  }
  return made;
}

async function generate(seed) {
  const r = rng(seed);
  const server = createFakeReleaseServer();
  const clock = genClock(r);
  const coins = genCoins(r, clock);
  const packs = await genPacks(r, server, coins, clock);
  const site = genSite(r, server, clock);
  const junk = genJunk(r, server, clock);
  for (const s of SERIES) for (let q = 1; q <= 6; q++) if (r() < 0.3) server.seed(`data-${s}-${q}`, 0, () => "unused"); // empty releases, gaps in the numbering
  const made = stampReleases(r, server, clock);
  return { server, clock, made, coins, packs, site, junk, ...genReferences(r, coins, packs, clock), current: currentReleases(r, server), capped: seed % 5 === 0 };
}

// Every release with its series, number, creation time and the locations it holds.
const releaseState = (server, made) => new Map(server.releases.map((rel) => [rel.tag_name, {
  series: rel.tag_name.split("-")[1], seq: seqOf(rel.tag_name), madeMs: made.get(rel.tag_name), locs: rel.assets.map((a) => `${rel.tag_name}/${a.name}`),
}]));

const allLocs = (server) => new Set(server.releases.flatMap((rel) => rel.assets.map((a) => `${rel.tag_name}/${a.name}`)));

function runArgs(w, blobs) {
  const removed = w.coins.removed;
  return sweepArgs(blobs, {
    clock: () => w.clock.nowMs,
    coins: [...w.coins.readable, ...w.coins.unreadable], referencesFor: async (s) => w.refs[s],
    removedCoins: removed, oldestNeededDay: new Map(Object.entries(w.needed)), currentSiteRoot: w.site.current, currentReleases: w.current,
    packsWritten: w.capped ? 3 : 10_000, historyDays: w.clock.historyDays,
  });
}

// The age rule of each class, written again as a plain comparison, apart from the code under test.
// Elapsed time for the two waits counted from creation, calendar days for the rules that go by a day in the name.
function oldEnough(p, today, historyDays) {
  if (p.dead) return p.elapsedMs >= MS_DAY;
  if (p.series === "live") return p.elapsedMs >= WAIT_DAYS * MS_DAY;
  if (p.series === "events") return daysBetween(today, p.nameDay) > 4;
  return daysBetween(today, p.nameDay) > historyDays - 1; // hist: outside the historyDays days ending today
}

// A release that is gone was not the newest of its series, its next higher release was made at least 24 h
// before now, and every object it held was deleted by this sweep.
function checkReleases(w, beforeReleases, run, label) {
  const deleted = new Set(run.executed.deleted);
  for (const [tag, info] of beforeReleases) {
    if (w.server.release(tag)) continue;
    const same = [...beforeReleases.values()].filter((x) => x.series === info.series).map((x) => x.seq);
    expect(info.seq, `${label}: ${tag} is the newest of its series`).toBeLessThan(Math.max(...same));
    const next = Math.min(...same.filter((q) => q > info.seq));
    const successor = beforeReleases.get(`data-${info.series}-${next}`);
    expect(successor.madeMs, `${label}: ${tag} went while the creation time of ${next} was unknown`).not.toBe(null);
    expect(w.clock.nowMs - successor.madeMs, `${label}: ${tag} went while its successor was ${w.clock.nowMs - successor.madeMs} ms old`).toBeGreaterThanOrEqual(MS_DAY);
    for (const loc of info.locs) expect(deleted.has(loc), `${label}: ${tag} went with ${loc} still in it`).toBe(true);
  }
}

// The other direction: after an uncapped sweep, what the rules say must go is gone.
function checkNothingKeptTooLong(w, after, label) {
  const named = new Set(w.coins.readable.flatMap((c) => [...w.refs[c].locations]));
  for (const p of w.packs) {
    if (named.has(p.loc) || p.garbage || p.noCreated) continue;
    const allReadable = p.listed.length > 0 && p.listed.every((c) => w.coins.readable.includes(c));
    const due = p.dead ? p.elapsedMs >= MS_DAY : p.series === "live" && p.elapsedMs >= WAIT_DAYS * MS_DAY && allReadable;
    expect(!due || !after.has(p.loc), `${label}: ${p.loc} (${p.series}${p.dead ? ", dead" : ""}, ${p.elapsedMs} ms old) should have gone`).toBe(true);
  }
}

async function checkSafety(w, blobs, before, run, label) {
  const after = allLocs(w.server);
  const gone = [...before].filter((l) => !after.has(l));
  expect(new Set(gone), `${label}: exactly the executed deletes are gone`).toEqual(new Set(run.executed.deleted));
  expect(run.executed.stopped, label).toBe(null);
  for (const slug of w.coins.readable) {
    for (const loc of w.refs[slug].locations) {
      expect(after.has(loc), `${label}: ${slug} still needs ${loc}`).toBe(true);
      if (w.packs.some((p) => p.loc === loc && (p.dead || p.garbage))) continue; // named, so kept; it is not a readable pack
      const size = (await blobs.stat(loc)).size;
      await openPack({ name: loc, size, readRange: (o, l) => blobs.readRange(loc, o, l) });
    }
  }
  for (const loc of [...w.junk, ...run.plan.keep.map((k) => k.loc)]) expect(after.has(loc), `${label}: kept ${loc}`).toBe(true);
  for (const p of w.packs.filter((x) => gone.includes(x.loc))) {
    const bad = p.listed.find((c) => w.coins.unreadable.includes(c) || (w.coins.removed.has(c) && !w.coins.returned.has(c) && daysBetween(w.clock.today, w.coins.removed.get(c)) < HOLD_DAYS) || c === "stranger");
    expect(bad, `${label}: ${p.loc} lists ${bad}`).toBeUndefined();
    expect(p.noCreated && (p.dead || p.series === "live"), `${label}: ${p.loc} has no creation time and its wait counts elapsed time`).toBe(false);
    expect(oldEnough(p, w.clock.today, w.clock.historyDays), `${label}: ${p.loc} (${p.series}${p.dead ? ", dead" : ""}, ${p.elapsedMs} ms old at ${w.clock.now}, day ${p.nameDay}) left too early`).toBe(true);
    if (p.series === "hist") {
      const needing = p.listed.find((c) => w.coins.readable.includes(c) && (w.needed[c] === undefined || w.needed[c] <= p.nameDay));
      expect(needing, `${label}: ${p.loc} is still needed by ${needing}`).toBeUndefined();
    }
  }
  for (const p of w.packs.filter((x) => x.garbage)) expect(after.has(p.loc), `${label}: ${p.loc} has an unreadable header and must stay`).toBe(true);
}

// Roots were generated oldest first, so the index is the rank of the name. Protected: the current root's
// location, and every location (a copy of the name in a second release too) of the 16 names before it.
function checkSiteRoots(w, label) {
  if (w.site.current === null) return;
  const at = w.site.currentIndex;
  for (const x of [...w.site.roots, ...w.site.copies]) {
    const protectedRoot = x.loc === w.site.current || (x.index < at && at - x.index <= KEPT_ROOTS);
    const present = exists(w.server, x.loc);
    if (protectedRoot) expect(present, `${label}: site root ${x.loc}`).toBe(true);
    if (!present) {
      expect(x.elapsedMs, `${label}: site root ${x.loc} went with no creation time`).not.toBe(null);
      expect(x.elapsedMs, `${label}: site root ${x.loc} went at ${x.elapsedMs} ms`).toBeGreaterThanOrEqual(WAIT_DAYS * MS_DAY);
    }
  }
}

describe("sweep safety over generated nights", () => {
  it(`${SEEDS} seeds: references, unreadable and removed coins, keep and foreign names, site roots, and a second sweep`, async () => {
    let deletedTotal = 0;
    let releasesTotal = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = await generate(seed);
      const blobs = backendOn(w.server);
      const before = allLocs(w.server);
      const beforeReleases = releaseState(w.server, w.made);
      const first = await runSweep(runArgs(w, blobs));
      await checkSafety(w, blobs, before, first, `seed ${seed}`);
      checkReleases(w, beforeReleases, first, `seed ${seed}`);
      if (!w.capped) checkNothingKeptTooLong(w, allLocs(w.server), `seed ${seed}`);
      checkSiteRoots(w, `seed ${seed}`);
      deletedTotal += first.executed.deleted.length;
      releasesTotal += first.executed.releasesDeleted.length;

      const again = backendOn(w.server);
      const mid = allLocs(w.server);
      const midReleases = releaseState(w.server, w.made);
      const second = await runSweep(runArgs({ ...w, capped: false }, again));
      const said = new Set(first.plan.delete.map((d) => d.loc));
      for (const loc of second.executed.deleted) expect(said.has(loc), `seed ${seed}: second sweep deleted ${loc}, which the first plan did not say`).toBe(true);
      // A release the first night kept because its successor was unknown or young can go now that the numbering
      // above it changed; the oracle judges those deletes by the same rule, from the state before the second night.
      checkReleases(w, midReleases, second, `seed ${seed} second`);
      if (!w.capped) {
        expect(second.executed.deleted, `seed ${seed}: nothing is left to delete`).toEqual([]);
        expect(allLocs(w.server), `seed ${seed}`).toEqual(mid);
      }
      await checkSafety(w, again, mid, second, `seed ${seed} second`);
    }
    expect(deletedTotal, "the generator must make the sweep delete something").toBeGreaterThan(0);
    expect(releasesTotal, "the generator must make the sweep delete some releases").toBeGreaterThan(SEEDS / 10);
  }, 120_000);
});
