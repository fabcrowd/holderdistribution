// The parent rule and chain acceptance of design 8.2 and 9.2 step 3, as pure functions.
//
// judgeChain(main entry, candidate chain) answers with a tagged value and never throws for
// an expected outcome:
//   accepted    { entries }            the entries to publish, oldest first
//   stale       { reason, expected, got }  the first entry's parent is not main's entry (a notice)
//   superseded  { reason }             main already holds the chain's last entry
//   refused     { reason }             the chain is empty or links to itself wrongly
// Each kind is judged against its own entry, so a ledger publish never makes a holders
// candidate stale (design 10(i)).
//
// A bundle is identified by its full key "<release>/<pack name>#<item id>@<sha256>" (bundle.js
// bundleKey), and `parent` carries that key. Up to 16 coins share a pack and the same pack
// name can exist in two releases after a crash and rerun, so neither a pack name nor
// "<pack name>#<slug>" names one bundle. Entries are equal when their keys are equal.
// judgeChain looks only at keys; it does not know whose bundle a key names. Use
// acceptChain.js, which also reads and verifies every bundle, before publishing anything.
//
// chainPackRows and checkChainPacks ask the blob store for each named pack by location
// (`stat`, 0 API requests on both backends). Cost by size: the chain is a few entries (at most
// the adoption window, see acceptChain.js) and one stat per distinct pack; nothing grows with
// H, C or D.
import { bundleKey, bundleLoc } from "./bundle.js";
import { entryKey } from "./manifest.js";
import { packNameOf } from "./itemRef.js";

export const MISSING_PACK = "missing pack";

export function judgeChain({ main, chain }) {
  if (!Array.isArray(chain) || chain.length === 0) return { status: "refused", reason: "empty chain" };
  const mainKey = main ? entryKey(main) : null;
  const droppedThrough = main ? chain.findIndex((e) => bundleKey(e.bundle) === mainKey) : -1;
  const rest = chain.slice(droppedThrough + 1);
  if (rest.length === 0) return { status: "superseded", reason: "main already holds the candidate's last entry" };
  if (rest[0].parent !== mainKey) return { status: "stale", reason: "parent mismatch", expected: mainKey, got: rest[0].parent };
  for (let i = 1; i < rest.length; i++) {
    const want = entryKey(rest[i - 1]);
    if (rest[i].parent !== want) {
      return { status: "refused", reason: `chain broken at entry ${droppedThrough + 1 + i}: its parent is ${rest[i].parent}, the entry before it is ${want}` };
    }
  }
  return { status: "accepted", entries: structuredClone(rest) };
}

// The packs the entries' bundles are stored in, once each, with the facts to check them.
export function chainPackRows(entries) {
  const rows = new Map();
  for (const e of entries) {
    const loc = bundleLoc(e.bundle);
    rows.set(loc, { name: packNameOf(e.bundle.ref), loc, size: e.bundle.packSize });
  }
  return [...rows.values()];
}

// Design 9.2 step 3: each named pack exists at its recorded location with its recorded size.
export async function checkChainPacks({ blobs, rows }) {
  for (const row of rows) {
    const found = await blobs.stat(row.loc);
    if (!found) return { status: "refused", reason: MISSING_PACK, loc: row.loc, detail: "not found at its recorded location" };
    if (found.size !== row.size) return { status: "refused", reason: MISSING_PACK, loc: row.loc, detail: `size ${found.size}, recorded ${row.size}` };
  }
  return { status: "ok" };
}
