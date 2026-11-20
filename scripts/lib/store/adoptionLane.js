// The lane side of adoption (design 2.1 section 9.3): one listing per lane job, shared by every
// coin the lane starts.
//
// What the blob store lacks, injected (the store files stay closed):
//   listRelease(tag) -> { entries, requests }: one release listing. `entries` are listing rows
//     { name, size, release, state, loc, createdAt }; `requests` the core requests it cost. A
//     release that does not exist answers { entries: [], requests } (the lane never names one it
//     was not told exists, except the release before the newest, which may have been swept).
//   existingReleases(series) -> { tags, requests }: the release tags that exist in a series.
//   now() -> milliseconds: the lane's clock, read at the start of the lane, and again to tell whether
//     a wait for a second look ended moments ago.
//   sleep(ms) -> promise (optional, default a real timer): the wait before a second look at a pack
//     past the bound (adoptionUnreadable.js). Each second look waits, except one that follows a
//     wait for the same pack that ended less than SECOND_LOOK_SHARE_MS ago; the usual night waits
//     for nothing.
// A release holds at most 900 assets, 9 pages of 100, so each release listed costs up to 9 core
// requests (REQUESTS_PER_RELEASE).
//
// How far the listing reaches. Adoption sees only the packs in the releases it lists, so the
// listing is a rule, not a count. It covers everything uploaded since T when the lowest listed
// release is release 1 or the lowest release that exists, or holds an asset created before T minus the
// uploader's learning lag (NEWEST_RELEASE_MAX_AGE_MS: an upload can land in a release up to that long
// after a newer one exists, so the release below the one that holds such an asset may still hold a
// pack of T or later).
// T is the 00:00 UTC start of the earliest `main` entry day among the lane's coins, with no floor: a
// coin stuck for longer than the window still finds every bundle it has not published, and the
// maximum of releases bounds the cost. A coin with no `main` entry (a new coin) has no bound either:
// T is the epoch, so the listing goes down to the lowest release that exists or the maximum, and the
// nightly lane that holds a new coin pays up to the maximum (73 requests) instead of 18. listLane lists the newest release and the one before it (FIRST_RELEASES),
// then goes down the releases that exist, one at a time, until the rule holds or a maximum of releases (maxReleases, default
// DEFAULT_MAX_RELEASES = 8) is listed. Only when the maximum is hit without the rule holding is
// the listing `shallow`, and every coin of the lane is alerted (adoption.js); when the rule holds,
// a bundle whose parent is unreachable is a broken link or damage and is named so.
//
// Cost by size. Each release listed is up to 9 core requests. The releases listed are about
//   (packs uploaded to the series since T) / 900, plus one,
// at least the two the design names: the usual night lists 2 (18 requests); the release tags are
// asked for (1 request) only when the lowest listed release is not release 1 and holds nothing
// created before T. A coin that was out for the whole window with 300 packs a night lists
// 300 · 16 / 900 + 1 = 7 releases, 64 requests, and the maximum of 8 releases is 73 requests a
// lane job. This grows with L (one listing per lane job), not with N, H, C or D.
//
// createLane keeps the listing and one header read per pack for all of the lane's coins;
// adoptLane is the whole start of a lane: list once, adopt each coin in turn, and return each
// coin's result (adoption.js: a coin that cannot finish tonight comes back failed, the others
// are not touched) with the listing and read counts. `listing` is { tags, requests, assets,
// budget, overBudget, shallow, since, oldestPackDay, newestPackDay } and `reads` is
// { headerReads, bundleReads, itemReads, stats, confirmations, bytes, secondLooks, recovered }.
import { ADOPTION_WINDOW_DAYS, NEWEST_RELEASE_MAX_AGE_MS } from "./storeConstants.js";
import { AdoptionListingError, RecordShapeError } from "./errors.js";
import { NameError, parseReleaseTag, releaseTag } from "./packNames.js";
import { packDaySpan } from "./adoptionPacks.js";
import { adoptCoin, checkCoinArguments } from "./adoption.js";
import { createHeaderReader, createPause, newCounts, realSleep } from "./adoptionReads.js";
import { kindField } from "./recordFields.js";
import { shapeOf } from "./shape.js";

export const REQUESTS_PER_RELEASE = 9;
export const FIRST_RELEASES = 2;
export const DEFAULT_MAX_RELEASES = 8;
export const LANE_LISTING_REQUESTS = REQUESTS_PER_RELEASE * FIRST_RELEASES;
const ENTRY_TEXT = ["name", "loc", "release", "state"];
const DAY_MS = 86400000;

const bad = (what) => new AdoptionListingError(`lane listing: ${what}`);

function liveSeq(liveTag) {
  let tag;
  try {
    tag = parseReleaseTag(liveTag);
  } catch (err) {
    if (err instanceof NameError) throw bad(`${JSON.stringify(liveTag)} is not a release tag (${err.message})`);
    throw err;
  }
  if (tag.series !== "live") throw bad(`${liveTag} is a ${tag.series} release; adoption lists live releases`);
  return tag.seq;
}

function checkArguments({ listRelease, existingReleases, liveTag, since, maxReleases }) {
  if (typeof listRelease !== "function") throw bad("listRelease must be a function (tag) => { entries, requests }");
  if (typeof existingReleases !== "function") throw bad("existingReleases must be a function (series) => { tags, requests }");
  if (!Number.isInteger(maxReleases) || maxReleases < 1) throw bad(`maxReleases must be a whole number from 1, got ${JSON.stringify(maxReleases)}`);
  if (!Number.isFinite(since)) throw bad(`since must be a time in milliseconds, got ${JSON.stringify(since)}`);
  return liveSeq(liveTag);
}

function checkRequests(tag, got) {
  if (!Number.isSafeInteger(got.requests) || got.requests < 0) throw bad(`${tag}: requests must be a whole number from 0, got ${JSON.stringify(got.requests)}`);
}

function checkListing(tag, got) {
  if (got === null || typeof got !== "object" || !Array.isArray(got.entries)) throw bad(`${tag}: listRelease must answer { entries: [...], requests }`);
  checkRequests(tag, got);
  got.entries.forEach((e, i) => {
    const ok = e !== null && typeof e === "object" && ENTRY_TEXT.every((k) => typeof e[k] === "string") && Number.isSafeInteger(e.size) && e.size >= 0;
    if (!ok) throw bad(`${tag}: entries[${i}] must hold name, loc, release and state as text and size as a whole number`);
  });
}

function checkExisting(got) {
  if (got === null || typeof got !== "object" || !Array.isArray(got.tags) || !got.tags.every((t) => typeof t === "string")) throw bad("existingReleases must answer { tags: [...], requests }");
  checkRequests("existingReleases", got);
}

const createdBefore = (rows, since) => rows.some((e) => Date.parse(e.createdAt) < since - NEWEST_RELEASE_MAX_AGE_MS);

// The next release below `seq` that exists, or null when there is none (the rule holds).
const nextBelow = (existing, seq) => Math.max(0, ...existing.map((t) => parseReleaseTag(t).seq).filter((n) => n < seq)) || null;

// since: the time (ms) T of the rule above.
export async function listLane({ listRelease, existingReleases, liveTag, since, maxReleases = DEFAULT_MAX_RELEASES }) {
  const seq = checkArguments({ listRelease, existingReleases, liveTag, since, maxReleases });
  const tags = [];
  const entries = [];
  let requests = 0;
  let existing = null;
  let lowestRows = [];
  const list = async (n) => {
    const tag = releaseTag("live", n);
    const got = await listRelease(tag);
    checkListing(tag, got);
    requests += got.requests;
    lowestRows = got.entries;
    tags.push(tag);
    entries.push(...got.entries.map((e) => ({ ...e })));
  };
  for (let n = seq; n >= 1 && n > seq - Math.min(FIRST_RELEASES, maxReleases); n--) await list(n);
  let shallow = false;
  for (;;) {
    const lowest = parseReleaseTag(tags.at(-1)).seq;
    if (lowest === 1 || createdBefore(lowestRows, since)) break;
    if (existing === null) {
      const got = await existingReleases("live");
      checkExisting(got);
      requests += got.requests;
      existing = got.tags.filter((t) => parseReleaseTag(t).series === "live");
    }
    const below = nextBelow(existing, lowest);
    if (below === null) break;
    if (tags.length >= maxReleases) {
      shallow = true;
      break;
    }
    await list(below);
  }
  const budget = REQUESTS_PER_RELEASE * tags.length + (existing === null ? 0 : 1);
  return { tags, entries, requests, assets: entries.length, budget, overBudget: requests > budget, shallow, since: new Date(since).toISOString() };
}

export function createLane({ blobs, listing, nowMs, sleep = realSleep, now = () => nowMs }) {
  if (typeof sleep !== "function") throw bad("sleep must be a function (ms) => promise");
  const counts = newCounts();
  const pause = createPause(sleep, now);
  const { first: readHeader, again: rereadHeader } = createHeaderReader({ blobs, counts, pause });
  const listed = new Set(listing.entries.filter((e) => e.state === "uploaded").map((e) => e.loc));
  const createdAt = new Map(listing.entries.map((e) => [e.loc, e.createdAt]));
  return {
    adopt: (args) => adoptCoin({ blobs, entries: listing.entries, listed, createdAt, readHeader, rereadHeader, pause, counts, nowMs, shallow: listing.shallow }, args),
    counts: () => ({ ...counts }),
  };
}

// T: the earliest main day of the lane's coins. A coin with no main entry has nothing to bound its
// backlog, so it is 0: the listing goes down to the lowest release that exists or the maximum. A lane
// with no coins adopts nothing and uses now minus the window.
export function listingSince(coins, nowMs) {
  if (coins.length === 0) return nowMs - ADOPTION_WINDOW_DAYS * DAY_MS;
  return Math.min(...coins.map(({ main }) => (main ? Date.parse(`${main.day}T00:00:00Z`) : 0)));
}

// coins: [{ slug, main }]; `main` is the coin's published entry of this kind, or null.
export async function adoptLane({ blobs, listRelease, existingReleases, now, liveTag, kind, coins, reserve, maxReleases, sleep }) {
  const s = shapeOf("adoption lane");
  kindField(s, kind, "kind");
  const nowMs = typeof now === "function" ? now() : Number.NaN;
  if (!Number.isFinite(nowMs)) throw bad("now must be a function returning the time in milliseconds");
  const seen = new Set();
  for (const { slug, main } of s.array(coins, "coins")) {
    checkCoinArguments({ slug, kind, main, reserve });
    if (seen.has(slug)) throw new RecordShapeError(`adoption lane: coin ${slug} is listed twice`);
    seen.add(slug);
  }
  const listing = await listLane({ listRelease, existingReleases, liveTag, since: listingSince(coins, nowMs), maxReleases });
  const lane = createLane({ blobs, listing, nowMs, sleep, now });
  const results = new Map();
  for (const { slug, main } of coins) results.set(slug, await lane.adopt({ slug, kind, main, reserve }));
  const { tags, requests, assets, budget, overBudget, shallow, since } = listing;
  return { coins: Object.fromEntries(results), listing: { tags, requests, assets, budget, overBudget, shallow, since, ...packDaySpan(listing.entries, kind) }, reads: lane.counts() };
}
