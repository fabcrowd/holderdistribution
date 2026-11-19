// The sweep's plan (design 2.1 section 4.3): pure logic, no I/O. From the listings of the
// `live`, `hist`, `events` and site series, what each pack lists as its coins, the per-coin
// answers of coinReferences, the removed coins, per coin the oldest change day its state
// still needs, the current site root and release of each series, today and historyDays, it
// returns every listed object exactly once in `delete` or `keep`, with the rule or reason
// in plain words, and the releases that go with them.
//
// Identity is the location "<release tag>/<name>" (blobStore.js): a copy of a pack name in
// another release that no reference set names is a separate object and leaves by the
// ordinary rule. An object whose name is not a store name, or belongs to another series, is
// kept and reported. A coin a pack lists that nobody classified (not readable, unreadable
// nor removed) pins the pack. Anything that cannot be decided throws SweepPlanError and no
// plan exists, so nothing is deleted.
//
// Reading of the design where it is silent (decided): an unreadable coin pins `events`
// packs too (10(j)); a location named by a readable coin is kept in every class, not only
// `live`; a dead upload (any series) goes after DEAD_UPLOAD_WAIT_DAYS without a header read,
// because a partial pack lists no coins that could use it; the hold of a removed coin ends
// on the REMOVED_COIN_HOLD_DAYS-th day after the night it was first missing; a coin that is
// marked removed but has a reference result is not removed (the mark is ignored and reported); the 16 site
// roots before the current one are the 16 next older root names (copies of a name in two
// releases share a number); a release whose every asset is in `delete` is planned for
// deletion too (the executor re-checks it empty).
import { isDay } from "./shape.js";
import { parseStoreName, parseSiteRootName } from "./packNames.js";
import { MIN_HISTORY_DAYS, SITE_ROOTS_KEPT, DEAD_UPLOAD_WAIT_DAYS } from "./storeConstants.js";
import { SweepPlanError } from "./sweepErrors.js";
import { decide, dayBefore, DAY_MS } from "./sweepRules.js";

export const SERIES_SWEPT = ["live", "hist", "events", "site"];
const REPORTED = new Set(["not-a-store-name", "wrong-series", "header-unreadable", "no-coin-list", "unknown-coin", "created-unknown"]);

const rankOf = (name) => {
  const p = parseSiteRootName(name);
  return [p.day, p.run, p.attempt, p.try];
};
// Newest first.
const newestFirst = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? 1 : -1;
  return 0;
};

// loc -> number: 0 for the current root, 1..SITE_ROOTS_KEPT for the ones before it.
function protectSiteRoots(site, currentLoc) {
  const roots = site.filter((o) => parseStoreName(o.name)?.type === "site");
  if (currentLoc === null) {
    if (roots.length) throw new SweepPlanError("the site series lists roots but no current site root was given; the 16 before it cannot be found");
    return new Map();
  }
  const current = roots.find((o) => o.loc === currentLoc);
  if (!current) throw new SweepPlanError(`the current site root ${currentLoc} is not in the site listing; refusing to delete site roots`);
  const names = [...new Set(roots.map((o) => o.name))].sort((a, b) => newestFirst(rankOf(a), rankOf(b)));
  const at = names.indexOf(current.name);
  const out = new Map([[currentLoc, 0]]);
  for (const o of roots) {
    const n = names.indexOf(o.name) - at;
    if (n >= 1 && n <= SITE_ROOTS_KEPT) out.set(o.loc, n);
  }
  return out;
}

function referenceIndex(references) {
  const namedBy = new Map();
  const readable = new Set();
  const unreadable = new Set();
  for (const [slug, r] of references) {
    if (r?.status === "ok") {
      readable.add(slug);
      for (const loc of r.locations) namedBy.set(loc, [...(namedBy.get(loc) ?? []), slug].sort());
    } else if (r?.status === "unreadable") unreadable.add(slug);
    else throw new SweepPlanError(`references of ${slug}: status ${JSON.stringify(r?.status)} is neither "ok" nor "unreadable"`);
  }
  return { namedBy, readable, unreadable };
}

function instantMs(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : Number.NaN;
  if (Number.isNaN(ms)) throw new SweepPlanError(`now must be an instant (an ISO time), got ${JSON.stringify(now)}`);
  return ms;
}

function checkInput({ today, historyDays, references, removed, listings, currentReleases }) {
  if (!isDay(today)) throw new SweepPlanError(`today must be a calendar day, got ${JSON.stringify(today)}`);
  if (!Number.isInteger(historyDays) || historyDays < MIN_HISTORY_DAYS) throw new SweepPlanError(`historyDays ${historyDays} is below the minimum ${MIN_HISTORY_DAYS}`);
  for (const s of SERIES_SWEPT) {
    if (!Array.isArray(listings?.[s])) throw new SweepPlanError(`no listing of the ${s} series`);
    if (typeof currentReleases?.[s] !== "string") throw new SweepPlanError(`no current release given for the ${s} series`);
  }
  for (const [slug, day] of removed) {
    if (!isDay(day)) throw new SweepPlanError(`removed coin ${slug}: first-missing night ${JSON.stringify(day)} is not a day`);
  }
}

function context(input) {
  checkInput(input);
  const { today, now, historyDays, references, removed, oldestNeededDay, listings, currentSiteRoot = null } = input;
  // A coin with a reference result (ok or unreadable) is in the registry again: its removed
  // mark is ignored, and the summary names it so a person can clear the mark.
  if (new Date(instantMs(now)).toISOString().slice(0, 10) !== today) throw new SweepPlanError(`today ${today} is not the UTC day of now ${now}`);
  const returned = [...removed.keys()].filter((slug) => references.has(slug)).sort();
  return {
    today, nowMs: instantMs(now), returned, removed: new Map([...removed].filter(([slug]) => !references.has(slug))), oldestNeeded: oldestNeededDay,
    horizonFirst: dayBefore(today, historyDays - 1),
    ...referenceIndex(references),
    siteProtected: protectSiteRoots(listings.site, currentSiteRoot),
  };
}

const objectsOf = (input) => SERIES_SWEPT.flatMap((series) => input.listings[series].map((e) => ({ ...e, series, class: series === "site" ? "live" : series })));

// Objects that pass every rule that needs no header: the only ones whose pack header the
// caller has to read.
export function headerCandidates(input) {
  const ctx = context(input);
  return objectsOf(input).filter((o) => decide(o, ctx, undefined).outcome === "needsHeader").map((o) => o.loc).sort();
}

const tagOf = (loc) => loc.slice(0, loc.indexOf("/"));

// Why an emptied release stays, or null when it may go. The uploader only ever uses the newest
// release of a series or a newer one (blobStoreRelease.js target), so a release is safe to
// delete when it is not the newest, and its next higher existing release was made so long ago
// that every process that could have picked it as the newest learned that before the wait
// DEAD_UPLOAD_WAIT_DAYS began, and re-learns every NEWEST_RELEASE_MAX_AGE_MS (the uploader enforces
// it). The instant is the creator's record, never GitHub's created_at (releaseRecord.js).
function releaseHold(r, sorted, input, series, nowMs) {
  if (r.seq === sorted.at(-1).seq) return { code: "newest-release", reason: `${r.tag} is the newest release of the ${series} series in the listing` };
  if (r.tag === input.currentReleases[series]) return { code: "current-release", reason: `${r.tag} is the current release` };
  const next = sorted.find((x) => x.seq > r.seq);
  const made = typeof next.createdAt === "string" ? Date.parse(next.createdAt) : Number.NaN;
  if (Number.isNaN(made)) return { code: "successor-created-unknown", reason: `the creation time of ${next.tag}, the release after ${r.tag}, is unknown; kept and reported` };
  if (nowMs - made < DEAD_UPLOAD_WAIT_DAYS * DAY_MS) return { code: "successor-too-young", reason: `${next.tag}, the release after ${r.tag}, is younger than ${DEAD_UPLOAD_WAIT_DAYS * 24} h` };
  return null;
}

function releasePlan(input, deletingLocs, nowMs) {
  const gone = new Map();
  for (const loc of deletingLocs) gone.set(tagOf(loc), (gone.get(tagOf(loc)) ?? 0) + 1);
  const out = [];
  const held = [];
  for (const series of SERIES_SWEPT) {
    const listed = new Map();
    for (const e of input.listings[series]) listed.set(e.release, (listed.get(e.release) ?? 0) + 1);
    const sorted = [...(input.releases?.[series] ?? [])].sort((a, b) => a.seq - b.seq);
    for (const r of sorted) {
      if ((listed.get(r.tag) ?? 0) !== r.assets) throw new SweepPlanError(`release ${r.tag}: the listing shows ${listed.get(r.tag) ?? 0} asset(s), the release list says ${r.assets}`);
      if (r.assets - (gone.get(r.tag) ?? 0) > 0) continue;
      const hold = releaseHold(r, sorted, input, series, nowMs);
      if (hold) held.push({ tag: r.tag, series, ...hold });
      else out.push({ tag: r.tag, series, rule: r.assets === 0 ? "no assets, not the newest or the current release, its successor older than the wait" : "every asset of it is deleted tonight; not the newest or the current release, its successor older than the wait" });
    }
  }
  return { out, held };
}

function summarize(entries, releases, releasesKept, returnedCoins) {
  const byClass = Object.fromEntries(SERIES_SWEPT.map((s) => [s, { listed: 0, kept: {}, deleted: 0, bytesDeleted: 0, bytesWaiting: 0 }]));
  for (const e of entries) {
    const b = byClass[e.series];
    b.listed++;
    if (e.rule) {
      b.deleted++;
      b.bytesDeleted += e.size;
    } else {
      b.kept[e.code] = (b.kept[e.code] ?? 0) + 1;
      if (e.waiting) b.bytesWaiting += e.size;
    }
  }
  const reported = [
    ...entries.filter((e) => !e.rule && REPORTED.has(e.code)).map((e) => ({ loc: e.loc, code: e.code, reason: e.reason })),
    ...releasesKept.filter((r) => r.code === "successor-created-unknown").map((r) => ({ loc: r.tag, code: r.code, reason: r.reason })),
  ];
  return { byClass, releasesToDelete: releases.length, releasesKept, reported, returnedCoins };
}

function judge(o, ctx, coinsByLoc) {
  const d = decide(o, ctx, coinsByLoc.has(o.loc) ? coinsByLoc.get(o.loc) : undefined);
  const base = { loc: o.loc, class: o.class, series: o.series, size: o.size };
  if (d.outcome === "delete") return { ...base, rule: d.rule };
  if (d.outcome === "needsHeader") return { ...base, code: "header-unread", reason: "the header of this pack was not read tonight; kept", waiting: true };
  return { ...base, code: d.code, reason: d.reason, waiting: d.waiting };
}

export function planSweep(input) {
  const ctx = context(input);
  const coinsByLoc = input.coinsByLoc ?? new Map();
  const entries = objectsOf(input).map((o) => judge(o, ctx, coinsByLoc));
  const deleting = entries.filter((e) => e.rule).sort((a, b) => (a.loc < b.loc ? -1 : 1));
  const { out: releasesToDelete, held: releasesKept } = releasePlan(input, deleting.map((e) => e.loc), ctx.nowMs);
  return {
    delete: deleting.map(({ loc, class: c, series, size, rule }) => ({ loc, class: c, series, size, rule })),
    keep: entries.filter((e) => !e.rule).map(({ loc, class: c, series, size, code, reason }) => ({ loc, class: c, series, size, code, reason })),
    releasesToDelete,
    summary: summarize(entries, releasesToDelete, releasesKept, ctx.returned),
  };
}
