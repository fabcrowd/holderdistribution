// The sweep step of the holders publish job (design 2.1 section 9.2 step 9), run after the push has landed:
//   sweepStore({ blobs, coins, readManifest, readStoreFile, index, historyDays, ... }) -> result
// It wires runSweep (sweep.js) to the files of origin/main through the same seams publish.js uses, and returns what
// happened as data; no gh call, no thrown plan error (a plan error deletes nothing and is returned as an issue, which
// the caller must raise: sweep.js header, "What the caller must know").
//   coins           every slug the sweep keeps references for (the registry's coins and every coin with a manifest on main)
//   readManifest    (slug) -> text | null   as in publish.js; a coin whose manifest cannot be read or parsed is
//                   `unreadable` in references.js and its packs are all kept
//   index           { load(slug) -> rows }  the coin's index rows; only the adoption window is handed to the sweep
//   readStoreFile   () -> text              store.json on main: the current release of each series; a series it lacks
//                   takes the newest release of that series in the listing, and `data-<series>-1` when it has none
//   historyDays     required (a coin's horizon, section 1); no default, a missing one is a PublishInputError
//   removedCoins, oldestNeededDay (Maps), currentSiteRoot, packsWritten, dryRun (default true: nothing is deleted
//   unless the caller says so), deleteReleases, sleep, clock, currentReleases (overrides the store file), headers
// An empty `oldestNeededDay` keeps every `hist` pack ("needed-day-unknown", sweepRules.js) and an empty `removedCoins`
// keeps every pack of a coin the sweep does not know: both are the safe side.
//
// Issues: a SweepPlanError, a SweepDeleteError or any other failure of the sweep (not a programming error) is one
// error issue and nothing further was deleted; packs whose header could not be read are one notice.
//
// Cost by size: that of runSweep (sweep.js: one references call per coin, four series listings, at most two range reads
// per deletion candidate) plus, per coin, one manifest read and one index read; references read each bundle with no
// label check (`crossCheck: false`) through the shared header cache. Grows with N and B, never with D, H or C.
import { readBundle } from "./bundle.js";
import { emptyManifest } from "./manifest.js";
import { createHeaderCache } from "./packHeaderCache.js";
import { releaseTag } from "./packNames.js";
import { parseStoreFile } from "./pointerFiles.js";
import { PublishInputError, isProgrammingError, issue } from "./publish.js";
import { coinReferences } from "./references.js";
import { SweepDeleteError, SweepPlanError } from "./sweepErrors.js";
import { runSweep } from "./sweep.js";
import { SERIES_SWEPT } from "./sweepPlan.js";

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function currentReleasesOf(blobs, store) {
  const out = {};
  for (const series of SERIES_SWEPT) {
    const named = store.releases[series];
    if (named !== undefined) {
      out[series] = named;
      continue;
    }
    const seqs = (await blobs.releasesOf(series)).map((r) => r.seq);
    out[series] = releaseTag(series, Math.max(1, ...seqs));
  }
  return out;
}

function failureIssue(err) {
  if (err instanceof SweepPlanError) return issue("sweep-plan-error", "error", null, "the sweep could not build a plan; nothing was deleted", `${err.name}: ${err.message}`);
  if (err instanceof SweepDeleteError) return issue("sweep-delete-error", "error", null, "a sweep delete failed; the rest were not attempted", `${err.name}: ${err.message}`);
  return issue("sweep-failed", "error", null, "the sweep failed; nothing further was deleted", `${err.name}: ${err.message}`);
}

export async function sweepStore(args) {
  const need = (ok, what) => {
    if (!ok) throw new PublishInputError(`sweep: ${what}`);
  };
  const { blobs, coins, readManifest, readStoreFile, index, historyDays, removedCoins = new Map(), oldestNeededDay = new Map(), currentSiteRoot = null, packsWritten = 0, dryRun = true, deleteReleases, sleep = realSleep, clock = Date.now, headers = createHeaderCache() } = args;
  need(blobs && typeof blobs.list === "function" && typeof blobs.releasesOf === "function", "blobs must be a blob store");
  need(Array.isArray(coins), "coins must be a list of slugs");
  need(typeof readManifest === "function" && typeof readStoreFile === "function", "readManifest and readStoreFile must be functions");
  need(index && typeof index.load === "function", "index must have a load(slug) function");
  need(Number.isInteger(historyDays) && historyDays > 0, `historyDays must be given (a whole number of days), got ${JSON.stringify(historyDays)}`);
  const storeText = await readStoreFile();
  need(typeof storeText === "string", "store.json on main was not given");
  const store = parseStoreFile(storeText);
  const issues = [];
  const today = new Date(clock()).toISOString().slice(0, 10);
  const referencesFor = (slug) => coinReferences({
    slug, today,
    loadManifest: async () => {
      const text = await readManifest(slug);
      return text === null ? emptyManifest(slug) : JSON.parse(text);
    },
    loadIndexRows: async ({ from, to }) => (await index.load(slug)).filter((r) => r.day >= from && r.day <= to),
    readBundle: (a) => readBundle({ blobs, headers, crossCheck: false, ...a }),
  });
  try {
    const currentReleases = args.currentReleases ?? await currentReleasesOf(blobs, store);
    const r = await runSweep({
      blobs, historyDays, coins, referencesFor, removedCoins, oldestNeededDay, currentSiteRoot, currentReleases, packsWritten, sleep, dryRun,
      ...(deleteReleases === undefined ? {} : { deleteReleases }), clock,
    });
    if (r.headerErrors.length > 0) {
      issues.push(issue("sweep-header-unreadable", "notice", null, `${r.headerErrors.length} pack headers could not be read; those packs were kept`, r.headerErrors.slice(0, 10).map((h) => h.loc).join(", ")));
    }
    return { status: "done", dryRun, plan: r.plan, executed: r.executed, summary: r.summary, issues };
  } catch (err) {
    if (isProgrammingError(err)) throw err;
    issues.push(failureIssue(err));
    return { status: "failed", dryRun, plan: null, executed: null, summary: null, issues };
  }
}
