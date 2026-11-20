// Chain acceptance that cannot skip verification (design 9.2 step 3): the one function the
// publish job calls for a coin and a kind. It runs, in order,
//   1. judgeChain          the parent rule, on keys only (pure)
//   2. the length bound    a chain to publish longer than the adoption window is refused
//   3. checkChainPacks     every named pack exists at its location with its size (stat)
//   4. readBundle          every entry it would publish is read and verified: the bytes hash
//                          to the entry's sha256, the bundle is this coin's and this kind's,
//                          and its own parent, day, run and usage equal the entry's, and no
//                          item it names is labelled with another coin (bundleItemCheck.js;
//                          `onItemsChecked` gets each entry's report, including the count of
//                          unlabelled items)
// and returns the tagged outcomes of judgeChain: accepted { entries }, stale, superseded,
// refused { reason, ... }. A bundle that cannot be fetched or verified refuses the coin; any
// other error (a programming error) is thrown.
//
// Arguments are validated first: `slug` and `kind`, `main` (null, or a published entry) and
// every chain entry (a candidate entry). A bad argument is a caller bug and throws a named
// RecordShapeError, never a native TypeError and never a tagged outcome. An empty chain is an
// expected outcome (refused), not a bad argument.
//
// Contract for the publish job: for every chain entry it publishes it writes a state index
// row for that entry's own day (references.js keeps a past day's bundle only through such a
// row, or through the current manifest entry).
//
// The label check is by reference (bundleItemCheck.js): an entry's bundle is checked only for the
// item refs its parent bundle does not name (same pack row), because the parent was checked for
// this coin. The parent is the previous chain entry (already read, no extra read) or, for the first
// entry, the `main` entry when its `labelCheck` marker ({ version, bundle }, manifest.js) vouches for
// it: version at least LABEL_CHECK_VERSION and `bundle` equal to the entry's own bundle key (one more
// bundle read). No marker, a marker copied from another entry, or a parent that is not the entry's
// `parent`, means a full check of every item ref. acceptChain sets the marker on every entry it
// accepts and refuses a candidate that carries one. An unlabelled item is refused here (the
// option that counts it exists only in readBundle, and acceptChain does not pass it).
//
// Cost by size. Let n be the coins of a publish, k the new packs an entry names (items its parent
// does not name): about one per item class a lane writes, so about 4 to 5 (less when up to 16 coins
// share a pack), L the chain length (at most the adoption window, 16 days) and P the packs a bundle
// names other than its own (100 at most in a long-lived coin). Range reads for one coin; the worst
// case below counts none shared. A publish must create ONE header cache (createHeaderCache) and pass
// it as `headers` to every acceptChain call; without it each call has its own cache and a pack that
// several coins share is read once per call, not once per publish.
//   trusted main, one entry (a normal night):  2 (main bundle) + 2 (own header and item) + k   = 4 + k
//   trusted main, L entries:                   2 + L * (2 + k)
//   main without a marker (full first check):  entry one 2 + P, each later entry 2 + k
// so a publish costs n * (4 + k) range reads on a normal night, n * (2 + L * (2 + k)) on a full chain,
// and n * (2 + P) once, for the first publish after this check is introduced. Worked numbers at k = 4,
// P = 100, L = 16:
//                         100 coins    1,000 coins
//   normal night              800          8,000
//   16-entry chain          9,800         98,000
//   first full check       10,200        102,000   (entry one alone; later entries as above)
// Stats: one per distinct pack (checkChainPacks). API requests: 0 on both backends. Nothing grows
// with H, C or D; the cost grows with what the night writes (n and k), not with what a coin holds.
// Pinned in acceptChainCost.test.js (a small case and the shared cache).
import { readBundle } from "./bundle.js";
import { chainPackRows, checkChainPacks, judgeChain } from "./chain.js";
import { RecordError } from "./errors.js";
import { entryKey, labelMarker, labelVouches, validateEntry } from "./manifest.js";
import { createHeaderCache } from "./packHeaderCache.js";
import { kindField, slugField } from "./recordFields.js";
import { shapeOf } from "./shape.js";
import { ADOPTION_WINDOW_DAYS } from "./storeConstants.js";

function checkArguments({ slug, kind, main, chain }) {
  const s = shapeOf("acceptChain");
  slugField(s, slug, "slug");
  kindField(s, kind, "kind");
  if (main !== null) validateEntry(main, { slug, kind, published: true });
  s.array(chain, "chain").forEach((entry, i) => {
    validateEntry(entry, { slug, kind, published: false });
    if (Object.hasOwn(entry, "labelCheck")) throw s.bad(`chain[${i}]`, "carries labelCheck, which only acceptChain sets (a lane cannot vouch for its own bundle)");
  });
}

// The checked parent of `entry`: the previous chain entry, or the main entry when it carries the
// current marker for its own bundle; null means a full check.
async function trustedParent({ blobs, slug, kind, headers, entry, prev }) {
  if (!prev || entryKey(prev.entry) !== entry.parent) return null;
  if (prev.bundle) return { bundle: prev.bundle, bundleRef: prev.entry.bundle };
  if (!labelVouches(prev.entry)) return null;
  const bundle = await readBundle({ blobs, slug, kind, bundleRef: prev.entry.bundle, expect: prev.entry, crossCheck: false, headers });
  return { bundle, bundleRef: prev.entry.bundle };
}

export async function acceptChain({ blobs, slug, kind, main, chain, onItemsChecked = null, headers = createHeaderCache() }) {
  checkArguments({ slug, kind, main, chain });
  const judged = judgeChain({ main, chain });
  if (judged.status !== "accepted") return judged;
  const { entries } = judged;
  if (entries.length > ADOPTION_WINDOW_DAYS) {
    return { status: "refused", reason: `chain of ${entries.length} entries is longer than the adoption window of ${ADOPTION_WINDOW_DAYS} days` };
  }
  const packs = await checkChainPacks({ blobs, rows: chainPackRows(entries) });
  if (packs.status !== "ok") return packs;
  let prev = main ? { entry: main, bundle: null } : null;
  for (const [index, entry] of entries.entries()) {
    try {
      const parent = await trustedParent({ blobs, slug, kind, headers, entry, prev });
      const bundle = await readBundle({ blobs, slug, kind, bundleRef: entry.bundle, expect: entry, onItemsChecked, headers, parent });
      prev = { entry, bundle };
    } catch (err) {
      if (err instanceof RecordError) return { status: "refused", reason: "bundle not verified", index, detail: err.message };
      throw err;
    }
  }
  return { ...judged, entries: entries.map((e) => ({ ...e, labelCheck: labelMarker(e) })) };
}
