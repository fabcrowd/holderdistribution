// Test helpers for the sweep (plan, executor, property test). Not a test file itself.
// Neutral slugs only.
import { randomBytes } from "node:crypto";
import { releaseBackend } from "./blobStoreRelease.js";
import { createPackWriter, packToBuffer } from "./pack.js";
import { packName, siteRootName, releaseTag } from "./packNames.js";
import { dayBefore } from "./sweepRules.js";

export const TODAY = "2026-11-19";
// The instant the unit tests run at: noon, so an asset made "N days ago" is exactly N x 24 h old.
export const NOW = `${TODAY}T12:00:00Z`;
export const HISTORY_DAYS = 400;
// A release made long before every test's now: old enough for any wait.
export const LONG_AGO = "2020-01-01T00:00:00.000Z";

export const ok = (slug, locs) => ({ status: "ok", slug, locations: new Set(locs), why: new Map() });
export const unreadable = (slug) => ({ status: "unreadable", slug, stage: "manifest", reason: "x", errorName: "RecordError" });

export const livePack = (n, day = "2026-11-01") => packName({ cls: "live", kind: "holders", day, run: n, attempt: 1, lane: 0, flush: 0 });
export const histPack = (n, day) => packName({ cls: "hist", kind: "holders", day, run: n, attempt: 1, lane: 0, flush: 0 });
export const eventsPack = (n, day) => packName({ cls: "events", kind: "holders", day, run: n, attempt: 1, lane: 0, flush: 0 });
export const siteRoot = (n, day = "2026-11-01") => siteRootName({ day, run: n, attempt: 1, try: 1 });

// A listing entry as blobStore.list returns it, created `ageDays` before TODAY.
export function entry(series, name, { ageDays = 0, state = "uploaded", size = 100, seq = 1, today = TODAY } = {}) {
  const tag = releaseTag(series, seq);
  return { name, size, createdAt: `${dayBefore(today, ageDays)}T12:00:00Z`, release: tag, state, loc: `${tag}/${name}` };
}

// Plan input from the entries given per series; unnamed parts take neutral defaults.
export function world(over = {}) {
  const listings = { live: [], hist: [], events: [], site: [], ...(over.listings ?? {}) };
  const count = (s) => {
    const m = new Map();
    for (const e of listings[s]) m.set(e.release, (m.get(e.release) ?? 0) + 1);
    return m;
  };
  const releases = {};
  const currentReleases = {};
  for (const s of Object.keys(listings)) {
    const tags = new Map([...count(s)].sort());
    for (const t of over.emptyReleases?.[s] ?? []) tags.set(t, 0);
    releases[s] = [...tags].map(([tag, assets]) => ({ tag, seq: Number(tag.split("-").at(-1)), assets, createdAt: over.releaseCreatedAt && tag in over.releaseCreatedAt ? over.releaseCreatedAt[tag] : LONG_AGO }));
    currentReleases[s] = over.currentReleases?.[s] ?? releaseTag(s, Math.max(1, ...releases[s].map((r) => r.seq)));
  }
  return {
    today: TODAY, now: NOW, historyDays: HISTORY_DAYS, listings, releases, currentReleases,
    coinsByLoc: new Map(), references: new Map(), removed: new Map(), oldestNeededDay: new Map(),
    currentSiteRoot: null, ...over, listings, releases, currentReleases,
  };
}

// A pack whose items are labelled with `slugs`, so its header lists exactly those coins (the writer
// computes the list; with slugs null its one item names no coin and there is none). The first item
// is `pad` incompressible bytes, so `pad` is the pack's size; the others are empty.
export async function packBytes({ cls = "live", day = "2026-11-01", slugs = ["example"], pad = 50 } = {}) {
  const w = createPackWriter({ meta: { class: cls, kind: "holders", day } });
  for (const [i, slug] of (slugs ?? [null]).entries()) await w.add(i === 0 ? randomBytes(pad) : Buffer.alloc(0), { slug });
  return packToBuffer(await w.finish());
}

// --- a fake release server with objects of chosen age and state ---
let nextAsset = 5_000_000;

// Puts an asset straight into the fake server (any age, any state, the same name in two
// releases), the way a crash, a rerun or a dead upload leaves it. Returns its location.
export function putObject(server, tag, name, bytes, { ageDays = 0, state = "uploaded", createdAt = `${dayBefore(TODAY, ageDays)}T12:00:00Z` } = {}) {
  if (!server.release(tag)) server.seed(tag, 0, () => "unused");
  server.release(tag).assets.push({ id: nextAsset++, name, bytes, state, createdAt });
  return `${tag}/${name}`;
}

export function backendOn(server, { http = server.http, ...opts } = {}) {
  return releaseBackend({ owner: "o", repo: "r", token: "secret-token", http, now: () => server.clock.t, sleep: async () => {}, assetLimit: 900, ...opts });
}

export const exists = (server, loc) => {
  const [tag, name] = [loc.slice(0, loc.indexOf("/")), loc.slice(loc.indexOf("/") + 1)];
  return Boolean(server.release(tag)?.assets.some((a) => a.name === name));
};

// Arguments of runSweep with neutral defaults; `over` replaces any of them.
export function sweepArgs(blobs, over = {}) {
  const refs = over.refs ?? {};
  const slugs = over.coins ?? Object.keys(refs);
  return {
    blobs, clock: () => Date.parse(NOW), historyDays: HISTORY_DAYS, coins: slugs,
    referencesFor: async (slug) => refs[slug] ?? ok(slug, []),
    currentReleases: { live: "data-live-1", hist: "data-hist-1", events: "data-events-1", site: "data-site-1" },
    removedCoins: new Map(), oldestNeededDay: new Map(), packsWritten: 100, sleep: async () => {}, dryRun: false, ...over, refs: undefined,
  };
}
