// A lane's stores: one pack item store per entry of `stores` ({ name, cls, targetBytes? }), all
// with the same coin limit (and the lane's byte target unless a store names its own) and all refusing an item with no coin (design 2.1 section 9.1, end step 5).
// Two stores may share a class: the bundle store, whose references need the rows of the item packs,
// so its pack is uploaded after theirs, is a second store of class `live`.
//
// Pack names: the lane owns one flush counter per class, shared by every store of that class, and
// asks `nameFor({ cls, flush })` when a store opens a pack. Two stores of one class in one lane can
// therefore never get the same name, and the caller needs one lane number only. Flush numbers are
// unique per class, not necessarily dense.
//
// A coin lost in any store (its pack's upload failed) is lost in every store of the lane: the stores
// share one `failedCoins` map, so its views throw PackLostError and lostCoins() names it.
//
// Memory: one open pack per store (each under `targetBytes`), whatever the number of coins, and
// nothing per finished coin (packItemStore.js). Cost: each store uploads once per `coinLimit` coins
// or `targetBytes`, and once more at its close; a lane of c coins with small items uploads
// ceil(c / coinLimit) packs per store.
import { createPackItemStore } from "./packItemStore.js";
import { PACK_COIN_LIMIT, PACK_TARGET_BYTES } from "./pack.js";

export class LaneError extends Error {
  constructor(message) {
    super(`lane: ${message}`);
    this.name = "LaneError";
  }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function checkStores(specs) {
  const ok = Array.isArray(specs) && specs.length > 0
    && specs.every((s) => s && typeof s.name === "string" && typeof s.cls === "string")
    && new Set(specs.map((s) => s.name)).size === specs.length;
  if (!ok) throw new LaneError("stores must be a non-empty list of { name, cls } with distinct names");
}

export function createLane({ blobs, nameFor, stores: specs, coinLimit = PACK_COIN_LIMIT, targetBytes = PACK_TARGET_BYTES, spoolDir = null }) {
  checkStores(specs);
  const flushes = new Map(); // class -> next flush number
  const failedCoins = new Map();
  const nameIn = (cls) => () => {
    const flush = flushes.get(cls) ?? 0;
    flushes.set(cls, flush + 1);
    return nameFor({ cls, flush });
  };
  const names = specs.map((s) => s.name);
  const stores = new Map(specs.map((s) => [s.name, createPackItemStore({
    blobs, nameFor: nameIn(s.cls), targetBytes: s.targetBytes ?? targetBytes, coinLimit, requireCoin: true, failedCoins, spoolDir,
  })]));
  const store = (name) => {
    const s = stores.get(name);
    if (!s) throw new LaneError(`no store ${JSON.stringify(name)} (the stores are ${names.join(", ")})`);
    return s;
  };
  const rowsOf = (list) => list.flatMap((n) => store(n).rows()).sort(byName);
  return {
    store,
    // { <store name>: the item-store interface that writes this coin }
    forCoin: (slug) => Object.fromEntries(names.map((n) => [n, store(n).forCoin(slug)])),
    // The coin is finished in the named stores (all by default); `flushed` lists those that uploaded.
    async endCoin(slug, list = names) {
      const flushed = [];
      for (const n of list) if ((await store(n).endCoin(slug)).flushed) flushed.push(n);
      return { flushed };
    },
    // The coins with an item in a pack that failed to upload, in any store of the lane.
    lostCoins: () => [...failedCoins.keys()].sort(),
    // The rows of every pack uploaded so far, in every store.
    rows: () => rowsOf(names),
    async closeStores(list) {
      for (const n of list) await store(n).close();
      return { packs: rowsOf(list) };
    },
    async close() {
      for (const n of names) await store(n).close();
      return { packs: rowsOf(names) };
    },
  };
}
