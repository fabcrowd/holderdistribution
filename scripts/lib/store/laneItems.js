// The item store the table code writes through during one coin's end step (design 2.1 section 9.1,
// end step 3), with the routing the design's classes need:
//   a change file (magic HDP1) goes to the lane's `hist` store, a base to its `live` item store;
//   a read of a reference into a pack this coin wrote tonight goes to the store of that class (a
//   pending or uploaded pack of this lane), every other read goes to the start bundle's reader
//   (laneState.openStart), which resolves the packs of the start by their rows.
// The table code's interface (itemStore.js): put(bytes) -> ref, get, getRange, has, delete, list.
// `views` is { items, hist }: lane.forCoin(slug) of laneStores in lanePack.js. A coin of tonight
// whose pack failed to upload throws PackLostError from the view, which fails the coin.
import { packInfo, packNameOf } from "./itemRef.js";

const PART_MAGIC = "HDP1";

export function createTableStore({ views, startItems, table }) {
  const own = new Set();
  const route = (ref) => {
    const name = packNameOf(ref);
    if (own.has(name)) return packInfo(name).cls === "hist" ? views.hist : views.items;
    if (!startItems) throw new Error(`lane items: ${ref} is in no pack this coin wrote tonight and the coin has no start`);
    return startItems;
  };
  return {
    async put(bytes) {
      const part = bytes.subarray(0, 4).toString("latin1") === PART_MAGIC;
      const ref = await (part ? views.hist : views.items).put(bytes, { type: part ? "part" : "base", table });
      own.add(packNameOf(ref));
      return ref;
    },
    get: (ref) => route(ref).get(ref),
    getRange: (ref, offset, length) => route(ref).getRange(ref, offset, length),
    has: (ref) => route(ref).has(ref),
    delete: async () => {},
    list: async () => [],
  };
}
