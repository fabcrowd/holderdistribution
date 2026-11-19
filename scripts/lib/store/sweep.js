// The nightly sweep (design 2.1 section 4.3, 9.5): deletes stored packs nothing needs any
// more, and never one something still needs. The decisions are sweepPlan.js (pure); this
// module gathers the inputs, runs the plan, and executes it through the blob store.
//
// Order: the per-coin references first (`referencesFor(slug)`, one call per coin; a throw
// from any of them, or a plan that cannot be built, rethrows with nothing deleted: the
// contract of references.js), then one listing of each of the live, hist, events and site
// series (never `keep`), then the header of each pack that is a deletion candidate, then
// the plan, then the deletes. `dryRun` (the default) stops after the plan.
//
// Clocks: the `live` wait (18 days) and the dead-upload wait (1 day) are elapsed time from the
// asset's `createdAt` to `now`, in 24-hour units; `hist`, `events` and the removed-coin hold go by
// calendar days (`today`, the UTC day of `now`) against the day in the pack's name or the night
// a coin was first missing (sweepRules.js).
//
// What the caller must know. (1) A thrown plan error deletes nothing, every night until the
// input is fixed, so the caller must raise it to an operator (open an issue), not only log it.
// (2) With `packsWritten` 0 the cap is 0 and nothing is deleted that night. (3) `removedCoins`
// and `oldestNeededDay` have no default: leaving one out is an error, because a forgotten
// `removedCoins` would pin the packs of every removed coin for ever. (4) Until a writer puts the
// coin list (`slugs`) into pack headers, every `live` or `hist` pack past its time rule is kept
// as "no coin list", reported, and its header is read again each night: header reads and
// stored bytes grow until then, and the steady-state claim below holds only once every pack
// carries the list. The run summary counts those packs and their bytes (`keptNoCoinList`)
// apart from packs whose header could not be read (`keptHeaderUnreadable`).
//
// Clock: `runSweep` takes `clock` (default the system clock), reads it once, and derives `today` (the UTC
// day) from that instant; a caller cannot pass `now` or `today` (a named error). Why: the release rule
// compares the store's recorded instants with this clock, and a caller-made instant (say, built from a
// settled day) could be a day off. Skew between this clock and the uploaders': the margin tolerates about
// 22 hours without `published_at` and any creator skew with it (blobStoreRelease.js header).
//
// Release rule: an emptied release is deleted only when it is not the newest release of its
// series in the listing, not the one currentReleases names, the next higher existing release
// was made at least DEAD_UPLOAD_WAIT_DAYS (24 h) ago, and a fresh count right before the delete
// is zero. "Made" is the instant its creator recorded in the release body (releaseRecord.js), or
// published_at when later; never created_at, which GitHub sets to the date of the release's
// commit. A release whose successor has no record or no readable instant is kept and reported.
// The wait is safe because every release backend learns the newest release at least hourly
// (blobStoreRelease.js header: margin 24 h - 1 h - one upload), which is enforced there and not
// assumed here.
//
// Switches. `dryRun` defaults to true: a real run passes `dryRun: false`. `deleteReleases`
// defaults to true; with false the objects are deleted and empty releases stay in place, named
// in the summary (`releasesLeftInPlace`) and in `reported`. A store whose behavior is not fully
// measured should first run with `deleteReleases: false`. Still unmeasured on real GitHub, and
// what each could cause: whether the asset count before a release delete sees an asset still
// uploading (a release mid-upload could be deleted and that upload fail, never reported stored);
// what an upload into a deleted release answers; the reply at 1,000 assets.
//
// Cost by size. Requests: one listing per series, so the 4 listings cost what the releases
// of those series cost (about assets / 900 releases each; blobStore.js BUDGET.listSeries),
// which grows with the number of packs held and not with D; deletes are one request each,
// at most 2 x `packsWritten` plus the empty releases; reads by location cost no API
// request. Header reads: at most HEADER_READS_PER_PACK (2) range reads per deletion
// candidate (a pack that passes every rule that needs no header), each at most 64 KiB + 8
// bytes unless the header is longer; a kept pack is never opened and no pack is read whole.
// Growth: with N through the references (one referencesFor call per coin) and the coins a
// header lists; with B through the packs pinned by bases that never change and the size of
// each bundle; with the candidates, which in steady state are the packs that expired since
// the last run. Nothing here grows with D, with H or with the bytes in a pack.
import { SWEEP_CAP_FACTOR } from "./storeConstants.js";
import { SweepPlanError, SweepClockArgError } from "./sweepErrors.js";
import { executeDeletes } from "./sweepExecute.js";
import { coinsFromHeader, headerCounter } from "./sweepHeaders.js";
import { planSweep, headerCandidates, SERIES_SWEPT } from "./sweepPlan.js";

function checkArgs({ coins, packsWritten, sleep, dryRun = true, removedCoins, oldestNeededDay, clock, now, today }) {
  if (now !== undefined || today !== undefined) throw new SweepClockArgError("runSweep takes no `now` or `today`: pass `clock`, a function returning the current instant (tests inject one); the day is derived from it");
  if (clock !== undefined && typeof clock !== "function") throw new SweepClockArgError("clock must be a function returning the current instant in ms");
  // No default for either: a forgotten removedCoins would pin every removed coin's packs for ever as "unknown coin".
  if (!(removedCoins instanceof Map)) throw new SweepPlanError("removedCoins must be given as a Map of slug to the night it was first missing (an empty Map when none)");
  if (!(oldestNeededDay instanceof Map)) throw new SweepPlanError("oldestNeededDay must be given as a Map of slug to its oldest needed change day (an empty Map when no coin has one)");
  if (!Array.isArray(coins) || new Set(coins).size !== coins.length) throw new SweepPlanError("coins must be a list of distinct slugs");
  if (!dryRun && (!Number.isInteger(packsWritten) || packsWritten < 0)) throw new SweepPlanError(`packsWritten must be a whole number, got ${JSON.stringify(packsWritten)}`);
  if (!dryRun && typeof sleep !== "function") throw new SweepPlanError("sleep must be a function (the pacing of the deletes)");
}

async function gatherReferences(coins, referencesFor) {
  const references = new Map();
  for (const slug of coins) references.set(slug, await referencesFor(slug));
  return references;
}

async function gatherListings(blobs) {
  const listings = {};
  const releases = {};
  for (const s of SERIES_SWEPT) {
    listings[s] = await blobs.list(s);
    releases[s] = await blobs.releasesOf(s);
  }
  return { listings, releases };
}

async function gatherCoins({ blobs, input, coinsOfPack, counter }) {
  const byLoc = new Map(Object.values(input.listings).flat().map((e) => [e.loc, e]));
  const coinsByLoc = new Map();
  const headerErrors = [];
  for (const loc of headerCandidates(input)) {
    const r = await coinsOfPack({ blobs, entry: byLoc.get(loc), counter });
    coinsByLoc.set(loc, r.coins ?? { failure: r.failure });
    if (r.coins === null) headerErrors.push({ loc, failure: r.failure, error: r.error });
  }
  return { coinsByLoc, headerErrors };
}

const diff = (a, b) => ({ core: b.core - a.core, byKind: Object.fromEntries(Object.entries(b.byKind).map(([k, n]) => [k, n - (a.byKind[k] ?? 0)]).filter(([, n]) => n > 0)) });

const keptFor = (plan, code) => plan.keep.filter((k) => k.code === code).reduce((n, k) => ({ packs: n.packs + 1, bytes: n.bytes + k.size }), { packs: 0, bytes: 0 });

function runSummary(plan, executed, requests, counter, releasesLeft) {
  const byClass = {};
  const gone = new Set(executed?.deleted ?? []);
  for (const [s, b] of Object.entries(plan.summary.byClass)) {
    const done = plan.delete.filter((d) => d.series === s && gone.has(d.loc));
    byClass[s] = { listed: b.listed, kept: b.kept, planned: b.deleted, deleted: done.length, bytesDeleted: done.reduce((n, d) => n + d.size, 0), bytesWaiting: b.bytesWaiting };
  }
  return {
    byClass, releasesPlanned: plan.summary.releasesToDelete, releasesLeftInPlace: releasesLeft.map((r) => r.tag),
    reported: [...plan.summary.reported, ...releasesLeft.map((r) => ({ loc: r.tag, code: "release-deletes-off", reason: "release deletes are switched off (deleteReleases: false); the empty release was left in place" }))], returnedCoins: plan.summary.returnedCoins, requests, headerReads: { ...counter },
    // Kept because the coins of the pack are unknown, told apart: its header could not be read, or it was read and has no coin list.
    keptHeaderUnreadable: keptFor(plan, "header-unreadable"), keptNoCoinList: keptFor(plan, "no-coin-list"),
  };
}

export async function runSweep(args) {
  checkArgs(args);
  const { blobs, historyDays, coins, referencesFor, removedCoins, oldestNeededDay, currentSiteRoot = null, currentReleases, packsWritten, sleep, dryRun = true, deleteReleases = true, clock = Date.now } = args;
  const nowMs = clock();
  if (!Number.isFinite(nowMs)) throw new SweepClockArgError(`clock() must return an instant in ms, got ${JSON.stringify(nowMs)}`);
  const now = new Date(nowMs).toISOString(); // read once: every rule of the night uses this instant
  const today = now.slice(0, 10);
  const coinsOfPack = args.coinsOfPack ?? coinsFromHeader;
  const before = blobs.stats();
  const references = await gatherReferences(coins, referencesFor);
  const input = { today, now, historyDays, references, removed: removedCoins, oldestNeededDay, currentSiteRoot, currentReleases, ...(await gatherListings(blobs)) };
  const counter = headerCounter();
  const { coinsByLoc, headerErrors } = await gatherCoins({ blobs, input, coinsOfPack, counter });
  const plan = planSweep({ ...input, coinsByLoc });
  // With deleteReleases false the objects go and the empty releases stay, listed in the summary.
  const toRun = deleteReleases ? plan : { ...plan, releasesToDelete: [] };
  const executed = dryRun ? null : await executeDeletes({ blobs, plan: toRun, sleep, cap: SWEEP_CAP_FACTOR * packsWritten });
  const left = deleteReleases ? [] : plan.releasesToDelete;
  const summary = runSummary(plan, executed, diff(before, blobs.stats()), counter, left);
  return { plan, executed, summary, headerErrors };
}
