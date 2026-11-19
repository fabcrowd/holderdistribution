// Chain acceptance that cannot skip verification (design 9.2 step 3): the one function the
// publish job calls for a coin and a kind. It runs, in order,
//   1. judgeChain          the parent rule, on keys only (pure)
//   2. the length bound    a chain to publish longer than the adoption window is refused
//   3. checkChainPacks     every named pack exists at its location with its size (stat)
//   4. readBundle          every entry it would publish is read and verified: the bytes hash
//                          to the entry's sha256, the bundle is this coin's and this kind's,
//                          and its own parent, day, run and usage equal the entry's
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
// Cost by size: range reads per accepted coin are at most 2 per entry (pack header, item),
// and entries are bounded by the chain length, which is bounded by the adoption window (16
// days; one publish a day). Stats: one per distinct pack. API requests: 0 on both backends.
// Nothing grows with H, C or D; the publish job's cost grows with N through the coins it
// accepts.
import { readBundle } from "./bundle.js";
import { chainPackRows, checkChainPacks, judgeChain } from "./chain.js";
import { RecordError } from "./errors.js";
import { validateEntry } from "./manifest.js";
import { kindField, slugField } from "./recordFields.js";
import { shapeOf } from "./shape.js";
import { ADOPTION_WINDOW_DAYS } from "./storeConstants.js";

function checkArguments({ slug, kind, main, chain }) {
  const s = shapeOf("acceptChain");
  slugField(s, slug, "slug");
  kindField(s, kind, "kind");
  if (main !== null) validateEntry(main, { slug, kind, published: true });
  s.array(chain, "chain").forEach((entry) => validateEntry(entry, { slug, kind, published: false }));
}

export async function acceptChain({ blobs, slug, kind, main, chain }) {
  checkArguments({ slug, kind, main, chain });
  const judged = judgeChain({ main, chain });
  if (judged.status !== "accepted") return judged;
  const { entries } = judged;
  if (entries.length > ADOPTION_WINDOW_DAYS) {
    return { status: "refused", reason: `chain of ${entries.length} entries is longer than the adoption window of ${ADOPTION_WINDOW_DAYS} days` };
  }
  const packs = await checkChainPacks({ blobs, rows: chainPackRows(entries) });
  if (packs.status !== "ok") return packs;
  for (const [index, entry] of entries.entries()) {
    try {
      await readBundle({ blobs, slug, kind, bundleRef: entry.bundle, expect: entry });
    } catch (err) {
      if (err instanceof RecordError) return { status: "refused", reason: "bundle not verified", index, detail: err.message };
      throw err;
    }
  }
  return judged;
}
