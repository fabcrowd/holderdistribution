// The cross-check of a bundle read (design 2.1 section 9.3, "verify each bundle and its items"):
// every item the bundle names, and the bundle's own item, is labelled in its pack header with
// the bundle's coin. An item labelled with another coin is refused (BundleItemCoinError): a pack
// row alone cannot tell whose item it is, and a bundle that names another coin's item would
// restore that coin's data under this one.
//
// An item with no label (a pack written before items carried a coin) is refused too
// (BundleItemUnlabelledError), unless the caller passes `allowUnlabelled`; then it is counted in
// the report's `unlabelled`. The publish path (acceptChain.js) never passes it.
//
// By reference (the cost rule, review A3c): with `parent` ({ bundle, bundleRef }, a bundle already
// checked for this coin) an item the parent names is not read again when the parent's pack row for
// it is the same row (same location, size and header hash), because the same row opens the same
// header and the parent's check covered that item. The own item is always checked. Without a
// parent every item is checked.
//
// Cost: no API request. Range reads: the header of each pack that holds a checked item, once
// (the own pack's header was already read with the bundle item), through the item store the caller
// passes, whose header cache a whole publish may share (packHeaderCache.js); a header over 64 KiB
// costs one more read. So a call costs one header read for each pack that holds an item the parent
// does not name, which a normal night keeps at about one pack per coin and class.
import { PackError } from "./pack.js";
import { StoreError } from "./blobStore.js";
import { BundleItemCoinError, BundleItemUnlabelledError, BundleReadError, BundleVerifyError } from "./errors.js";
import { packNameOf, refsIn } from "./itemRef.js";
import { labelOf } from "./shape.js";

async function entryOf(items, ref, label) {
  try {
    return await items.entryOf(ref);
  } catch (err) {
    if (err?.name === "PackItemRangeError") throw new BundleVerifyError(`${label}: ${ref} is not an item of its pack: ${err.message}`, { cause: err });
    if (err instanceof PackError || err instanceof StoreError || err?.name === "PackRowMismatchError" || err?.name === "PackUnknownError") {
      throw new BundleReadError(`${label}: cannot read the header that labels ${ref}: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

const rowKey = (row) => `${row.loc}|${row.size}|${row.headerSha256}`;

// The refs of `bundle` that the parent names through the same pack row: they need no new read.
function carriedRefs({ bundle, bundleRef, parent, ownRowOf }) {
  if (!parent) return new Set();
  const mine = new Map(bundle.packs.map((r) => [r.name, rowKey(r)]));
  const theirs = new Map([...parent.bundle.packs, ownRowOf(parent.bundleRef)].map((r) => [r.name, rowKey(r)]));
  const named = refsIn([parent.bundle.blobs, parent.bundle.tables, parent.bundle.stateIndex]);
  const own = packNameOf(bundleRef.ref);
  return new Set([...named].filter((ref) => {
    const name = packNameOf(ref);
    return name !== own && mine.has(name) && mine.get(name) === theirs.get(name);
  }));
}

// `items` is a pack item store that resolves every pack the bundle names (bundleItems, or the
// store readBundle used for the bundle item plus addRows of the bundle's rows). `readsOf()` gives
// the range reads made so far (the store's own, or the shared cache's).
export async function checkBundleItems({ items, bundle, bundleRef, parent = null, ownRowOf, allowUnlabelled = false, readsOf = () => items.stats().rangeReads }) {
  const label = labelOf("bundle", bundle);
  const own = packNameOf(bundleRef.ref);
  const carried = carriedRefs({ bundle, bundleRef, parent, ownRowOf });
  const order = (ref) => `${packNameOf(ref) === own ? "0" : "1"}${ref}`;
  const named = [bundleRef.ref, ...refsIn([bundle.blobs, bundle.tables, bundle.stateIndex])];
  const refs = [...new Set(named)].filter((r) => !carried.has(r)).sort((a, b) => (order(a) < order(b) ? -1 : 1));
  const reads = readsOf();
  let unlabelled = 0;
  for (const ref of refs) {
    const { slug } = await entryOf(items, ref, label);
    if (slug === null || slug === undefined) {
      if (!allowUnlabelled) throw new BundleItemUnlabelledError(`${label}: item ${ref} has no coin label in its pack header (an unlabelled item is refused unless the reader allows it)`);
      unlabelled++;
    } else if (slug !== bundle.slug) {
      throw new BundleItemCoinError(`${label}: item ${ref} is labelled with coin ${slug} in its pack header, the bundle is coin ${bundle.slug}`);
    }
  }
  return { itemsChecked: refs.length, itemsCarried: carried.size, unlabelled, packs: new Set(refs.map(packNameOf)).size, rangeReads: readsOf() - reads };
}
