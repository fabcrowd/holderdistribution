// Adoption of design 2.1 section 9.3, for one kind and one coin: find the unpublished work of
// earlier runs and continue from it. Given the coin's `main` entry (null for a new coin), the
// lane's shared listing and the blob store, it
//   1. keeps packs of this kind, state `uploaded`, dated after the main entry's day, whose
//      header lists the coin (adoptionPacks.js), reading each header once per lane by range;
//   2. reads the coin's bundle in each (readBundle: the bytes hash to the header's rawSha256,
//      the bundle is this coin's and this kind's) to get its parent;
//   3. links bundles by parent key, never by name: a bundle is `<release>/<pack>#<id>@<sha256>`,
//      and the same pack name in two releases is two bundles;
//   4. takes the longest chain from a bundle whose parent is the main entry, capped (below);
//      the same depth is decided by the newer day, then the higher run id, then the higher
//      attempt, then the later key;
//   5. verifies the chosen chain, oldest first, item by item by hash; a bundle that fails is
//      dropped with every bundle after it and the next best chain is verified.
// Days never go backwards: a bundle whose day is before its parent's day (or, for the first,
// before the main entry's day) is dropped with the reason "day goes backwards", and the
// publish side refuses such a chain too (chain.js judgeChain). Equal days are allowed.
// It returns { failed, chain, start, why, alerts }. `chain` is the adopted entries, oldest first, as
// candidate entries (no `publishedAt`); `start` is { source: "adopted", entry, bundle } for
// the newest verified bundle, { source: "main", entry, bundle: null } with no chain, null for
// a new coin with nothing; `why` is a list of plain sentences about what was skipped; `alerts`
// is the same facts as data, [{ code, count }] sorted by code, so a lane can raise an issue
// without parsing sentences: `too-long` (bundles left unadopted by the cap: more than 15
// unpublished bundles is an outage that needs an operator), `listing-too-shallow` (the lane's
// listing hit its maximum of releases before it reached everything uploaded since T, adoptionLane.js:
// raised for every coin of the lane), `damaged` (bundles dropped for a bad hash, or a pack that is
// bad or confirmed gone), `broken-link` (readable bundles newer than the main entry that were not
// adopted because their parent was not found, with the listing complete: the count of such bundles,
// separate from the pack's own `damaged`; a shallow listing says `listing-too-shallow` instead),
// `day-backwards`, `unreadable-dropped` (a pack that stayed unreadable
// for UNREADABLE_PACK_DAYS and was dropped), `unreadable-undated` (an unreadable pack with no
// creation time, treated as young), `run-wrote-coin-twice`, and, on a failed coin, `unreadable`
// or `read-failed`.
//
// A coin that cannot finish tonight is returned with `failed: true`, its `error`, `chain` and
// `start` null (never "nothing to adopt") and an alert; the lane's other coins are not touched.
// A pack that cannot be read tonight fails only the coins that cannot rule it out, and only
// while it is younger than UNREADABLE_PACK_DAYS; the rules and their cost are in
// adoptionUnreadable.js. The principle is unchanged: a failure to obtain bytes is never proof of
// a bad object, and adoption never returns a chain shortened by one.
//
// The cap. acceptChain refuses a chain of more than ADOPTION_WINDOW_DAYS (16) entries, and a
// lane's candidate is the adopted chain plus its own entry. A coin that adopted 16 would
// publish 17 and be refused every night. So the chain is capped at 16 - `reserve` entries,
// `reserve` being 1 by default (the run's own entry): with more candidates the first 15 are
// adopted and the later ones named "too long". The coin continues from the 15th. This path
// never publishes the bundles after it; recovering their days depends on the ledger being
// readable for past days (a `pastReadable: false` ledger loses them). `reserve: 0` gives the
// longest chain acceptChain alone accepts.
//
// A bad stored object drops that bundle and everything after it in its chain, and is named in
// `why`. Only evidence from bytes read or from sizes already known counts as a bad object (or a
// pack that stat confirms is gone, or one unreadable for the whole bound); a failure to obtain
// bytes fails the coin tonight, and a programming error is thrown out of the lane (the rule is in
// the header of adoptionReads.js). A verified item is remembered by its
// location, its pack row's header hash and size, and its id, so a bundle that names the same
// location under a different row is verified again.
//
// Cost by size (one coin, on top of the lane's listing, which adoptionLane.js makes once):
//   - nothing to adopt (the usual night): no read at all, only the shared listing;
//   - per pack that lists the coin: one header read by range (shared by the lane's coins);
//   - per candidate bundle of this coin: a stat, one header read and one item read, a KB;
//   - per bundle of the chosen chain: one header read per pack it names (at most 64 KiB + 8
//     bytes) and one range read per item it names that an earlier bundle of the chain did not
//     already verify: those items are the only bytes read in full, never a whole pack.
// Over the whole lane this grows with N (through the packs, about N/16 per unpublished day),
// with L (one listing per lane job), and with the days left unpublished (at most the releases
// listed, adoptionLane.js); it does not grow with H, C or D: the items named are bundle-sized by design
// (b blobs and B buckets per bundle), and no row of a table is read.
import { bundleItems, bundleKey, ownPackRow, readBundle } from "./bundle.js";
import { BundleVerifyError } from "./errors.js";
import { parseItemRef, packNameOf, refsIn } from "./itemRef.js";
import { buildEntry, entryKey, validateEntry } from "./manifest.js";
import { kindField, slugField } from "./recordFields.js";
import { shapeOf } from "./shape.js";
import { ADOPTION_WINDOW_DAYS } from "./storeConstants.js";
import { StoreNotFoundError } from "./blobStore.js";
import { bundleItemsOf, doesNotList, listsCoin, selectPacks, skippedLines, tooLongLine } from "./adoptionPacks.js";
import { PackAgedOutError, PackGoneError, PackUnreadableError, ageableCause, classify, countingBlobs, dropOrThrow } from "./adoptionReads.js";
import { ageOf, ownBytesFailure, settleUnreadable } from "./adoptionUnreadable.js";

export const DEFAULT_RESERVE = 1;

export function checkCoinArguments({ slug, kind, main, reserve = DEFAULT_RESERVE }) {
  const s = shapeOf("adoption");
  slugField(s, slug, "slug");
  kindField(s, kind, "kind");
  if (main !== null) validateEntry(main, { slug, kind, published: true });
  if (!Number.isInteger(reserve) || reserve < 0 || reserve >= ADOPTION_WINDOW_DAYS) {
    throw s.bad("reserve", `must be a whole number from 0 to ${ADOPTION_WINDOW_DAYS - 1}, got ${JSON.stringify(reserve)}`);
  }
}

const wrongCoin = (err) => err instanceof BundleVerifyError && /is the bundle of /.test(err.message);

// A failure of the pack's own bytes (adoptionUnreadable.js): null when the error is of another
// kind; a not-found is believed only when stat, the store's own answer, also finds nothing (one
// counted request), and then the pack is gone; otherwise the error to throw or to drop with.
async function ownBytes(ctx, err, loc, createdAt) {
  const cause = ageableCause(err);
  if (!cause) return null;
  if (cause instanceof StoreNotFoundError) {
    ctx.counts.confirmations++;
    if ((await countingBlobs(ctx.blobs, ctx.counts, "itemReads").stat(loc)) === null) return new PackGoneError(`pack ${loc} is gone: the read found nothing and stat confirms it`);
  }
  return ownBytesFailure({ loc, createdAt, cause, nowMs: ctx.nowMs });
}

// One read of a pack's bytes, judged (ownBytes). A failure that ownBytes finds past the bound is
// given a second look: the wait (shared only with a wait for the pack that just ended), then the same read. Returns the value, or
// throws what ownBytes judged (or the read's own error when it is not about the pack's bytes).
async function readJudged(ctx, { loc, createdAt, read }) {
  try {
    return await read();
  } catch (err) {
    const failure = await ownBytes(ctx, err, loc, createdAt);
    if (!(failure instanceof PackAgedOutError)) throw failure ?? err;
    await ctx.pause(loc);
    ctx.counts.secondLooks++;
    try {
      const value = await read();
      ctx.counts.recovered++;
      return value;
    } catch (again) {
      throw (await ownBytes(ctx, again, loc, createdAt)) ?? again;
    }
  }
}

async function readCandidate({ ctx, blobs, entry, head, item, slug, kind }, note) {
  const bundleRef = { ref: `${entry.name}#${item.id}`, release: entry.release, packSize: entry.size, headerSha256: head.headerSha256, sha256: item.rawSha256 };
  try {
    const bundle = await readJudged(ctx, { loc: entry.loc, createdAt: entry.createdAt, read: () => readBundle({ blobs, slug, kind, bundleRef }) });
    return { key: bundleKey(bundleRef), bundleRef, bundle, entry: buildEntry({ slug, kind, bundleRef, bundle }), children: [], dead: false, depth: 0 };
  } catch (err) {
    if (err instanceof PackUnreadableError) throw err;
    if (err instanceof PackGoneError) {
      note(`bundle ${bundleRef.ref} in ${entry.release} is dropped: ${err.message}`, err instanceof PackAgedOutError ? "unreadable-dropped" : "damaged");
      return null;
    }
    dropOrThrow(err);
    // readBundle words a bundle of another coin or kind as "is the bundle of <slug>/<kind>".
    note(wrongCoin(err)
      ? `pack ${entry.loc}: its bundle for ${slug} belongs to another coin or kind and is dropped (${err.message})`
      : `bundle ${bundleRef.ref} in ${entry.release} is dropped: bad hash or unreadable (${err.message})`, wrongCoin(err) ? null : "damaged");
    return null;
  }
}

// The pack's header; a failure of the pack's own bytes past the bound is read again (second look).
async function headOf(ctx, entry) {
  const head = await ctx.readHeader(entry);
  if (head.ok || head.bad || !head.ageable || ageOf(entry.createdAt, entry.loc, ctx.nowMs) !== "old") return head;
  return ctx.rereadHeader(entry);
}

async function loadCandidates(ctx, { slug, kind, main }, note) {
  const { packs, skipped } = selectPacks({ entries: ctx.entries, kind, main });
  skippedLines(skipped, main).forEach(note);
  const heads = [];
  for (const entry of packs) heads.push({ entry, head: await headOf(ctx, entry) });
  const readable = heads.filter(({ head }) => head.ok);
  for (const { entry, head } of heads.filter((h) => !h.head.ok && h.head.bad)) note(`pack ${entry.loc} cannot be read (${head.detail}); its bundles are dropped`, "damaged");
  const blobs = countingBlobs(ctx.blobs, ctx.counts, "bundleReads");
  const nodes = new Map();
  let notListing = 0;
  for (const { entry, head } of readable) {
    if (!listsCoin(head.header, slug)) {
      notListing++;
      continue;
    }
    for (const item of bundleItemsOf(head.header, slug)) {
      const node = await readCandidate({ ctx, blobs, entry, head, item, slug, kind }, note);
      if (node && node.key !== (main ? entryKey(main) : null)) nodes.set(node.key, node);
    }
  }
  if (notListing > 0) note(doesNotList(notListing, slug));
  const evidence = new Set([...nodes.values()].map((n) => n.bundle.parent).filter(Boolean).map((p) => p.split("#")[0]));
  settleUnreadable({ unreadable: heads.filter((h) => !h.head.ok && !h.head.bad), readable, evidence, slug, nowMs: ctx.nowMs }, note);
  return nodes;
}

const dropped = (n, what) => `bundle ${n.bundleRef.ref} in ${n.bundleRef.release} ${what}`;

// Day rule and followers: a bundle follows a dropped parent down, and its day is on or after its
// parent's day (the main entry's day for the first).
function judgeDay(n, parent, main, note) {
  if (parent?.dead) {
    n.dead = true;
    note(dropped(n, "follows a bundle that was dropped"));
    return;
  }
  const before = parent ? parent.bundle.day : main?.day;
  if (before !== undefined && n.bundle.day < before) {
    n.dead = true;
    note(dropped(n, `is dropped: day goes backwards (its day ${n.bundle.day} is before ${parent ? "its parent's" : "the main entry's"} day ${before})`), "day-backwards");
  }
}

// Bundles the walk from the root never reaches have a parent that is neither the main entry nor
// an adoptable bundle. When the listing stopped at its maximum before it reached everything
// uploaded since T (listing-too-shallow, raised for the coin at the start), the missing parent is
// taken to be outside the listing; otherwise the listing reaches it and the link is broken or
// the parent was damaged (its own line says so).
function reportLost(lost, shallow, note) {
  lost.forEach((n) => { n.dead = true; });
  for (const n of lost) {
    note(dropped(n, shallow
      ? `has a parent ${n.bundle.parent} outside the listing`
      : `has a broken link: its parent ${n.bundle.parent} is neither the main entry nor an adoptable bundle (a damaged or unreadable parent has its own line)`));
  }
  if (!shallow && lost.length > 0) note(`${lost.length} readable bundle${lost.length === 1 ? "" : "s"} newer than the main entry could not be adopted: the parent was not found`, "broken-link", lost.length);
}

// Parents and children by key; depth from the main entry (1 for a child of it).
function linkNodes(nodes, { main, cap, shallow }, note) {
  const byParent = new Map();
  for (const n of nodes.values()) byParent.set(n.bundle.parent, [...(byParent.get(n.bundle.parent) ?? []), n]);
  const reached = new Set();
  let layer = (byParent.get(main ? entryKey(main) : null) ?? []).map((n) => ({ n, parent: null }));
  for (let depth = 1; layer.length > 0; depth++) {
    const nextLayer = [];
    for (const { n, parent } of layer) {
      if (reached.has(n.key)) continue;
      reached.add(n.key);
      Object.assign(n, { depth, parent });
      parent?.children.push(n);
      judgeDay(n, parent, main, note);
      nextLayer.push(...(byParent.get(n.key) ?? []).map((c) => ({ n: c, parent: n })));
    }
    layer = nextLayer;
  }
  reportLost([...nodes.values()].filter((n) => !reached.has(n.key)), shallow, note);
  const tooLong = [...nodes.values()].filter((n) => !n.dead && n.depth > cap);
  if (tooLong.length > 0) note(tooLongLine(tooLong.length, cap), "too-long", tooLong.length);
}

const rank = (n) => [n.depth, n.bundle.day, n.bundle.run.id, n.bundle.run.attempt, n.key];
function better(a, b) {
  const x = rank(a);
  const y = rank(b);
  const i = x.findIndex((v, k) => v !== y[k]);
  return i >= 0 && x[i] > y[i];
}

const pickBest = (nodes, cap) => [...nodes.values()].filter((n) => !n.dead && n.depth <= cap).reduce((a, n) => (a === null || better(n, a) ? n : a), null);

function pathTo(node) {
  const path = [];
  for (let n = node; n; n = n.parent) path.unshift(n);
  return path;
}

// One item. A failure of the pack's own bytes is judged by ownBytes: inside the bound the coin
// fails tonight, past it the bundle is dropped. A carried pack outside the listing takes the age of
// the pack of the bundle that carries it (stat gives no creation time, and a carried pack is older
// than its carrier, so the carrier's age never overstates the carried pack's).
async function readRef(ctx, items, ref, loc, carrierCreatedAt) {
  await readJudged(ctx, { loc, createdAt: ctx.listed.has(loc) ? ctx.createdAt.get(loc) : carrierCreatedAt, read: () => items.get(ref) });
}

// Reads every item the bundle names that an earlier bundle of this call has not verified under
// the same pack row (location, header hash, size).
async function verifyItems(ctx, node, seen) {
  const { bundle, bundleRef } = node;
  const rows = new Map([...bundle.packs, ownPackRow(bundleRef)].map((r) => [r.name, r]));
  const rowOf = (ref) => rows.get(packNameOf(ref));
  const idOf = (ref) => `${rowOf(ref).loc}|${rowOf(ref).headerSha256}|${rowOf(ref).size}#${parseItemRef(ref).id}`;
  const todo = [...refsIn([bundle.blobs, bundle.tables, bundle.stateIndex])].sort().filter((ref) => !seen.has(idOf(ref)));
  if (todo.length === 0) return;
  const items = bundleItems({ blobs: countingBlobs(ctx.blobs, ctx.counts, "itemReads"), bundle, bundleRef });
  const carrierCreatedAt = ctx.createdAt.get(ownPackRow(bundleRef).loc);
  for (const ref of todo) {
    await readRef(ctx, items, ref, rowOf(ref).loc, carrierCreatedAt);
    seen.add(idOf(ref));
  }
}

function dropWithFollowers(node, note) {
  node.dead = true;
  for (const child of node.children) {
    if (!child.dead) note(dropped(child, "follows a bundle that was dropped"));
    dropWithFollowers(child, note);
  }
}

async function chooseChain(ctx, nodes, cap, note) {
  const verified = new Set();
  const seenItems = new Set();
  for (;;) {
    const best = pickBest(nodes, cap);
    if (!best) return [];
    const path = pathTo(best);
    let failed = null;
    for (const node of path.filter((n) => !verified.has(n.key))) {
      try {
        await verifyItems(ctx, node, seenItems);
        verified.add(node.key);
      } catch (err) {
        note(dropped(node, `is dropped: bad hash or unreadable item (${dropOrThrow(err).message})`), err instanceof PackAgedOutError ? "unreadable-dropped" : "damaged");
        failed = node;
        break;
      }
    }
    if (!failed) return path;
    dropWithFollowers(failed, note);
  }
}

function newLog() {
  const why = [];
  const tally = new Map();
  const note = (line, code, n = 1) => {
    why.push(line);
    if (code) tally.set(code, (tally.get(code) ?? 0) + n);
  };
  const alerts = (extra = []) => {
    const merged = new Map(tally);
    for (const { code, count } of extra) merged.set(code, (merged.get(code) ?? 0) + count);
    return [...merged].sort(([x], [y]) => (x < y ? -1 : 1)).map(([code, count]) => ({ code, count }));
  };
  return { why, note, alerts };
}

async function adoptChecked(ctx, { slug, kind, main, reserve = DEFAULT_RESERVE }, { why, note, alerts }) {
  if (ctx.shallow) note(`listing does not reach back far enough: the maximum number of releases was listed and the oldest still holds nothing created before the earliest main day, so unpublished bundles of ${slug} may be missing`, "listing-too-shallow");
  const cap = ADOPTION_WINDOW_DAYS - reserve;
  const nodes = await loadCandidates(ctx, { slug, kind, main }, note);
  linkNodes(nodes, { main, cap, shallow: ctx.shallow }, note);
  const path = await chooseChain(ctx, nodes, cap, note);
  if (path.length === 0) note(`no adoptable bundle starts from ${main ? "the main entry" : "a new coin (no parent)"}`);
  const last = path.at(-1);
  const start = last ? { source: "adopted", entry: structuredClone(last.entry), bundle: structuredClone(last.bundle) }
    : main ? { source: "main", entry: structuredClone(main), bundle: null } : null;
  return { failed: false, chain: path.map((n) => structuredClone(n.entry)), start, why, alerts: alerts() };
}

// A coin whose adoption cannot finish tonight is returned as failed, with its error and an alert
// (`unreadable` for a pack it cannot do without, `read-failed` for any other failure to obtain
// bytes); `chain` and `start` are null so that it is never read as "nothing to adopt". Only a
// programming error (TypeError, ReferenceError, RangeError) or an error of no known class is
// thrown, which stops the lane.
export async function adoptCoin(ctx, args) {
  checkCoinArguments(args);
  const log = newLog();
  try {
    return await adoptChecked(ctx, args, log);
  } catch (err) {
    const { kind, error } = classify(err);
    if (kind === "bad") throw err;
    log.note(`${args.slug} fails tonight: ${error.message}`);
    const extra = error instanceof PackUnreadableError ? error.alerts : [{ code: "read-failed", count: 1 }];
    return { failed: true, error, chain: null, start: null, why: log.why, alerts: log.alerts(extra) };
  }
}
