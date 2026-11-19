// What a coin does with a pack that cannot be read tonight (design 2.1 section 9.3, fix round 2).
//
// A failure to obtain a pack's bytes is never proof that the pack is bad (adoptionReads.js), so
// the pack stays "unreadable", and the question is only who it holds up and for how long.
//
// Who. The lane slice must keep this invariant: one run attempt writes at most one bundle per coin
// and kind, in one pack. A coin therefore rules an unreadable pack out when a readable pack of the
// same kind, run id and attempt holds a bundle of that coin: the unreadable pack of that run
// attempt cannot hold another. Two readable packs of one run attempt with a bundle of the same
// coin show that the invariant failed for this coin: alert `run-wrote-coin-twice`, and nothing is
// ruled out for it. A coin that cannot rule an unreadable pack out fails tonight (alert
// `unreadable`, the pack named) and the lane goes on with the other coins. Every pack considered
// here is dated after the coin's main entry's day, because adoptionPacks.js selects only those.
//
// For how long. An unreadable pack is transient only while it is younger than
// UNREADABLE_PACK_DAYS (storeConstants.js), by elapsed time from its creation time to the lane's
// clock. From that age on it is a bad object: dropped, alert `unreadable-dropped`, and the coins
// go on. The cost: after three nights the bundles in that pack are given up, and with them the
// days only those bundles carried (the same consequence as the 15-bundle cap). Only a failure of
// the pack's own bytes (not found though stat answers, a range failure) ages out; a rate limit or
// an HTTP error is about the store, not the pack, and keeps the coin failing. A pack with no
// creation time is treated as young and alerted (`unreadable-undated`).
//
// The complete table, for every failure to obtain a pack's bytes (young: younger than the bound;
// old: at or past it; age is the pack's listing creation time, except for a carried pack, which
// stat gives none for: the age of the pack of the bundle that carries it, which is never older
// than the carried pack, so it can only delay the drop):
//   cause                                              inside the bound            after it
//   header read: not found, stat finds the pack        coin fails unless it        pack dropped, alert
//     (unreadable pack)                                rules the pack out          unreadable-dropped
//   header read: range failure after retries           same                        same
//   header read: not found, stat finds nothing         pack gone: dropped, alert damaged (no bound)
//   header read: rate limit, HTTP error, listing       coin fails unless it        never ages out
//     failure                                          rules the pack out
//   bundle or item read in a pack whose header read:   coin fails (alert unreadable) bundle dropped with its
//     not found (stat finds it), range failure                                      followers, alert
//                                                                                   unreadable-dropped
//   bundle or item read: not found, stat finds nothing bundle dropped, alert damaged (no bound)
//   bundle or item read: rate limit, HTTP error        coin fails (read-failed)    never ages out
//   any read: TypeError, ReferenceError, RangeError    the lane stops              the lane stops
// A coin never rules out an unreadable pack that one of its readable candidate bundles names as
// its parent (the key carries the release and pack name): that bundle is direct evidence of a
// bundle of the coin in that pack, whatever the run-attempt rule says. Without that, the same
// pack name in two releases (a crash and rerun) with one copy readable would let the coin go on
// with a chain shortened by one.
import { bundleItemsOf } from "./adoptionPacks.js";
import { PackAgedOutError, PackUnreadableError } from "./adoptionReads.js";
import { parseStoreName } from "./packNames.js";
import { UNREADABLE_PACK_DAYS } from "./storeConstants.js";

const BOUND_MS = UNREADABLE_PACK_DAYS * 86400000;

// "young" (inside the bound), "old" (at or past it) or "undated" (no usable creation time).
export function ageOf(createdAt, nowMs) {
  const t = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
  if (Number.isNaN(t)) return "undated";
  return nowMs - t >= BOUND_MS ? "old" : "young";
}

const runAttemptOf = (entry) => {
  const { run, attempt } = parseStoreName(entry.name);
  return `run ${run} attempt ${attempt}`;
};

// Run attempts of the readable packs that hold a bundle of the coin, with how many packs each has.
function runAttemptsHolding(readable, slug) {
  const seen = new Map();
  for (const { entry, head } of readable) {
    if (bundleItemsOf(head.header, slug).length > 0) seen.set(runAttemptOf(entry), (seen.get(runAttemptOf(entry)) ?? 0) + 1);
  }
  return seen;
}

function judgePack({ entry, head }, { seen, twice, evidence, nowMs }, note) {
  const age = ageOf(entry.createdAt, nowMs);
  if (age === "undated") note(`pack ${entry.loc} has no creation time and is treated as younger than ${UNREADABLE_PACK_DAYS} days`, "unreadable-undated");
  if (twice.length === 0 && !evidence.has(entry.loc) && seen.has(runAttemptOf(entry))) {
    note(`pack ${entry.loc} cannot be read tonight (${head.detail}); a readable pack of ${runAttemptOf(entry)} holds this coin's bundle, so it holds nothing more for it`);
    return true;
  }
  if (head.ageable && age === "old") {
    note(`pack ${entry.loc} cannot be read (${head.detail}) and is ${UNREADABLE_PACK_DAYS} days old or older: it is a bad object, dropped, and the bundles in it are given up`, "unreadable-dropped");
    return true;
  }
  return false;
}

// unreadable and readable: [{ entry, head }] of the selected packs of the kind; evidence: the
// locations that a readable candidate bundle of the coin names as its parent's pack. Returns when the
// coin may go on; throws PackUnreadableError naming the packs it cannot do without.
export function settleUnreadable({ unreadable, readable, evidence = new Set(), slug, nowMs }, note) {
  if (unreadable.length === 0) return;
  const seen = runAttemptsHolding(readable, slug);
  const twice = [...seen].filter(([, n]) => n > 1).map(([key]) => key);
  if (twice.length > 0) note(`${twice.join(", ")} wrote two readable packs with a bundle of ${slug}: the one-bundle-per-run-attempt rule does not hold for it, so no unreadable pack is ruled out`, "run-wrote-coin-twice", twice.length);
  const blockers = unreadable.filter((p) => !judgePack(p, { seen, twice, evidence, nowMs }, note));
  if (blockers.length === 0) return;
  const locs = blockers.map((b) => b.entry.loc);
  const detail = blockers.map((b) => `${b.entry.loc} (${b.head.detail})`).join("; ");
  note(`${slug} cannot go on tonight: ${blockers.length === 1 ? "a pack" : "packs"} that cannot be read and that it cannot rule out: ${detail}`, "unreadable", blockers.length);
  throw new PackUnreadableError(`${slug} cannot be adopted tonight: ${locs.join(", ")} cannot be read, and no readable pack of the same run attempt holds a bundle of ${slug} to rule ${locs.length === 1 ? "it" : "them"} out (${detail})`, { packs: locs, alerts: [], cause: blockers[0].head.error });
}

// A bundle or item read that failed in the pack's own bytes while the pack is there (a not-found
// stat answers for, a range failure). `createdAt` is the pack's listing creation time, or for a
// carried pack outside the listing (stat gives no creation time: the gap in the blob store) the
// creation time of the pack of the bundle that carries it. Returns the error to throw: a bad
// object once the age is at the bound, the coin's failure otherwise.
export function ownBytesFailure({ loc, createdAt, cause, nowMs }) {
  const age = ageOf(createdAt, nowMs);
  if (age === "old") return new PackAgedOutError(`pack ${loc} cannot be read (${cause.message}) and is ${UNREADABLE_PACK_DAYS} days old or older: it is a bad object, and the bundle that read it is dropped`);
  const alerts = [{ code: "unreadable", count: 1 }, ...(age === "undated" ? [{ code: "unreadable-undated", count: 1 }] : [])];
  return new PackUnreadableError(`pack ${loc} cannot be read tonight (${cause.message}) though stat finds it`, { packs: [loc], alerts, cause });
}
