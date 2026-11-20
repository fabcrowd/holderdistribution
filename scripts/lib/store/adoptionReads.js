// The reads adoption makes, counted and classified (design 2.1 section 9.3).
//
// countingBlobs wraps the blob store with the two calls a read needs, stat and readRange,
// and counts each by label: `headerReads` (the lane's pack header reads), `bundleReads` (the
// bundle reader's header and item reads), `itemReads` (the verification of the items a bundle
// names), `stats`, and `bytes`. Nothing else is exposed, so a read through it can only be a
// range read or a stat: no listing, no whole-object download.
//
// The rule: a bundle or pack is dropped only on evidence from bytes that were read (a hash
// mismatch, wrong magic, a parse or shape failure, a pack row that does not match the pack) or
// from sizes already known (a header or row that points outside the size the listing or the
// pack row gives). Every range adoption asks for lies inside a size already checked (openPack
// checks the header against the listing's size, the item store checks the stat size against the
// row, an item's range against the header's body size), so the store is never asked for an
// out-of-bounds range: a StoreRangeError from it can only be a failed read (a short body, a 200
// where a 206 was asked, an expired signed URL after the retries), and a body shorter than the
// range asked is made one here. Any failure to obtain bytes inside the known size is
// transient and is thrown: the coin fails tonight, the lane reports it, and adoption retries
// intact tomorrow. Dropping on it would shorten the chain and strand the newer day for good.
// A not-found on a pack is believed only when the store's own API confirms it, `blobs.stat(loc)`
// answering null (counted as `confirmations`): a pack the listing shows as `uploaded` that stat
// still finds, or a carried one, is unreadable, not gone.
//
// An unreadable pack is not an error of the lane. The header reader answers it as data
// ({ ok: false, bad: false, ... }) so that each coin decides whether it needs that pack
// (adoptionUnreadable.js), and no coin is handed a failure of a pack it can do without. Only
// programming errors throw out of the reader.
//
// dropOrThrow applies the rule: it returns the error of a bad stored object, and throws a
// programming error (TypeError, ReferenceError, RangeError) or a failure to obtain bytes
// (range failure, not-found, rate limit, HTTP error, a listing that changed), even when a bundle
// reader wrapped it as the cause of its own error.
import { StoreHttpError, StoreListingError, StoreNotFoundError, StoreRangeError, StoreRateLimitError } from "./blobStore.js";
import { RecordError } from "./errors.js";
import { PackError, openPack } from "./pack.js";
import { PackLostError, PackRowMismatchError, PackUnknownError } from "./packItemStore.js";
import { sha256Hex } from "./stable.js";
import { SECOND_LOOK_SHARE_MS, SECOND_LOOK_WAIT_MS } from "./storeConstants.js";

// secondLooks: reads tried a second time past the bound (adoptionUnreadable.js); recovered: those
// that then succeeded. Neither is an alert: a recovered read changes nothing for the coin.
export const newCounts = () => ({ headerReads: 0, bundleReads: 0, itemReads: 0, stats: 0, confirmations: 0, bytes: 0, secondLooks: 0, recovered: 0 });

export const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The wait before a second look at a pack location. A reader that finds a wait for the location
// running, or ended less than SECOND_LOOK_SHARE_MS ago (by `now`), shares it (another coin reading the
// same pack); any later second look gets a wait of its own, so a fault that comes back after the
// first recovery is given time too. A lane's worst case is one wait per second look.
export function createPause(sleep, now) {
  const waits = new Map();
  return async (loc) => {
    const last = waits.get(loc);
    if (last) {
      await last.done;
      if (now() - last.endedAt < SECOND_LOOK_SHARE_MS) return;
    }
    const wait = { endedAt: 0 };
    wait.done = sleep(SECOND_LOOK_WAIT_MS).then(() => { wait.endedAt = now(); });
    waits.set(loc, wait);
    await wait.done;
  };
}

// A pack that the store itself confirms is gone (not found by the read and by stat).
export class PackGoneError extends RecordError {}

export function countingBlobs(blobs, counts, label) {
  return {
    async stat(loc) {
      counts.stats++;
      return blobs.stat(loc);
    },
    async readRange(loc, off, len) {
      counts[label]++;
      const bytes = await blobs.readRange(loc, off, len);
      if (bytes.length !== len) throw new StoreRangeError(`short read of ${loc}: ${bytes.length} of ${len} bytes at ${off}`);
      counts.bytes += bytes.length;
      return bytes;
    },
  };
}

// A coin cannot go on because a pack it cannot rule out (or carries) cannot be read tonight: the
// coin fails tonight, the lane goes on. `packs` names the locations; `alerts` is [{ code, count }].
export class PackUnreadableError extends Error {
  constructor(message, { packs, alerts, cause }) {
    super(message, cause ? { cause } : undefined);
    this.name = "PackUnreadableError";
    this.packs = packs;
    this.alerts = alerts;
  }
}

// A carried pack that stat answers for but cannot be read, older than the bound.
export class PackAgedOutError extends PackGoneError {}

const PROGRAMMING = [TypeError, ReferenceError, RangeError];
// Failures that are about the pack's own bytes, the only ones that age into a bad object.
export const AGEABLE = [StoreNotFoundError, StoreRangeError];
const FATAL = [PackUnreadableError, TypeError, ReferenceError, RangeError, StoreRangeError, StoreNotFoundError, StoreRateLimitError, StoreHttpError, StoreListingError];
const BAD_OBJECT = [PackError, PackLostError, PackUnknownError, PackRowMismatchError, RecordError];

function fatalIn(err) {
  for (let e = err, depth = 0; e && depth < 8; e = e.cause, depth++) {
    if (FATAL.some((C) => e instanceof C)) return e;
  }
  return null;
}

// "bad": evidence of a bad stored object; "failed": a failure to obtain bytes (or the lane's own
// PackUnreadableError); a programming error, or an error of no known class, is thrown.
export function classify(err) {
  const fatal = fatalIn(err);
  if (fatal) {
    if (PROGRAMMING.some((C) => fatal instanceof C)) throw fatal;
    return { kind: "failed", error: fatal };
  }
  if (!BAD_OBJECT.some((C) => err instanceof C)) throw err;
  return { kind: "bad", error: err };
}

// The failure of a pack's own bytes inside an error (or its causes), or null: the only failures
// that age into a bad object (adoptionUnreadable.js).
export function ageableCause(err) {
  const fatal = fatalIn(err);
  return fatal && AGEABLE.some((C) => fatal instanceof C) ? fatal : null;
}

// Returns the error when it means "bad stored object"; throws it (or its fatal cause) otherwise.
export function dropOrThrow(err) {
  const fatal = fatalIn(err);
  if (fatal) throw fatal;
  if (!BAD_OBJECT.some((C) => err instanceof C)) throw err;
  return err;
}

// One header read per pack location for the whole lane, however many coins ask. The answer
// is { ok: true, header, headerSha256 }, { ok: false, bad: true, detail } (evidence of a bad
// object, or a pack that stat confirms is gone) or { ok: false, bad: false, ageable, error,
// detail } (a failure to obtain the bytes; `ageable` says it is about the pack's own bytes).
// headerSha256 is the hash of the prefix and the header bytes, the fact a bundle reference carries.
export function createHeaderReader({ blobs, counts, pause }) {
  const counted = countingBlobs(blobs, counts, "headerReads");
  const seen = new Map();
  async function read(entry) {
    const chunks = [];
    try {
      const pack = await openPack({
        name: entry.loc, size: entry.size,
        readRange: async (off, len) => {
          const bytes = await counted.readRange(entry.loc, off, len);
          chunks.push(bytes);
          return bytes;
        },
      });
      return { ok: true, header: pack.header, headerSha256: sha256Hex(Buffer.concat(chunks).subarray(0, pack.bodyStart)) };
    } catch (err) {
      return unreadable(err, entry);
    }
  }

  // A not-found is confirmed with one stat before the pack is called unreadable.
  async function unreadable(err, entry) {
    const { kind, error } = classify(err);
    if (kind === "bad") return { ok: false, bad: true, detail: error.message };
    if (error instanceof StoreNotFoundError) {
      counts.confirmations++;
      let found;
      try {
        found = await counted.stat(entry.loc);
      } catch (statErr) {
        return { ok: false, bad: false, ageable: false, error: classify(statErr).error, detail: `${error.message}; stat failed too` };
      }
      if (found === null) return { ok: false, bad: true, detail: `pack is gone: the read found nothing and stat confirms it` };
    }
    return { ok: false, bad: false, ageable: AGEABLE.some((C) => error instanceof C), error, detail: error.message };
  }
  // The second look at a header that failed past the bound: the wait, then the same read, once per
  // location for the lane.
  const second = new Map();
  async function look(entry) {
    await pause(entry.loc);
    counts.secondLooks++;
    const again = await read(entry);
    if (again.ok) counts.recovered++;
    return again;
  }
  return {
    first: (entry) => {
      if (!seen.has(entry.loc)) seen.set(entry.loc, read(entry));
      return seen.get(entry.loc);
    },
    again: (entry) => {
      if (!second.has(entry.loc)) second.set(entry.loc, look(entry));
      return second.get(entry.loc);
    },
  };
}
