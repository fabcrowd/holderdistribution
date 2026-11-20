// The publish step of design 2.1 section 9.2, steps 2 to 4 (what is decided from the candidates; the git
// checkout, commit and push, the site root, the deploy and the sweep are other steps, and the sweep is
// publishSweep.js). One call per kind:
//   publishKind({ kind, blobs, candidates, readManifest, readStoreFile, index, out, ... }) -> result
// Seams (the caller owns every file and every network call; nothing here runs git or gh):
//   candidates     [{ name, text }]        the downloaded candidate artifacts of the kind
//   readManifest   (slug) -> text | null   the coin's manifest on origin/main; null means "none on main". A throw is
//                                          an unreadable coin (the workflow must not answer null for a file it could not read)
//   readStoreFile  () -> text              store.json on origin/main (the empty store file when main has none)
//   index          { load(slug) -> rows }  the coin's state index rows on main (publishIndex.js); [] when it has none
//   out            { writeManifest(slug, text), writeIndex(slug, rows), writeStoreFile(text) }
// Optional: `clock`, `headers` (one header cache; made here when absent), `adoptionAlerts` ({ slug: [{ code, count }] },
// the alerts the lanes' restore step reported), `runReleases` ({ series: tag }, releases a lane used that no
// candidate names).
//
// What it does, per coin and independently (9.5: a failure for one coin never blocks another):
//   1. the highest attempt of each coin's candidate (candidate.js); a candidate that is not valid, or of an unknown
//      schema, is refused with an error and the others go on
//   2. the coin's manifest is read; not valid JSON, another schema, or a read that throws refuses the coin and the
//      file is never overwritten (10(j))
//   3. the chain goes through acceptChain, the only way an entry is accepted: parent rule, packs by stat, every bundle
//      read and verified, labels checked. One header cache serves every call of the publish. The `main` entry is
//      passed as read, with its `labelCheck` marker, so an entry already accepted is not checked again as if it had none
//   4. accepted: the last chain entry (with acceptChain's marker) plus `publishedAt` becomes the manifest's entry; for
//      the holders kind one index row per chain entry is written (publishIndex.js); then the manifest. Rows go first:
//      a row without a manifest is harmless (the sweep only keeps a bundle longer), a manifest without its row is not
//   stale (the parent is no longer main's) is a notice and the coin keeps its main entry; superseded (main already
//   holds the last entry) is neither written nor reported; refused, unreadable and failed are errors.
// After the coins, `store.json` takes per series the higher sequence of main and the run (pointerFiles.js
// mergeStoreFiles; the run's releases are the ones the accepted coins' bundles sit in, plus `runReleases`; a refused,
// stale or conflicting candidate moves nothing). It is written
// only when a coin was accepted: nothing accepted, nothing to commit (9.2 step 6).
//
// The result is data: { kind, publishedAt, accepted: [slug], results: [{ slug, status, ... }], issues, storeFile, headers }.
// `issues` is a list of { code, severity: "error" | "notice", slug | null, title, detail } that the caller raises
// (stale and conflicts are notices or errors as in 9.2); adoption alerts are errors. No GitHub call here.
//
// Not here (named so nothing is assumed): step 4's restore of git-held files and their hash comparison, step 5 (site
// root), the commit and the push loop of steps 6 and 7, and steps 8 to 10.
//
// Cost by size. N candidate coins, each a few KB of candidate and one manifest of about 0.7 KB; per coin the range
// reads of acceptChain (about 4 + k on a normal night, acceptChain.js has the table) and one stat per distinct pack;
// the shared header cache makes a pack that up to 16 coins share one read per publish. One index read and write per
// accepted holders coin (a few KB). Nothing grows with H, C or D. Memory: the candidates and one coin's manifest at
// a time, the header cache (bounded, packHeaderCache.js). For N = 100 a normal night is about 800 range reads and 100
// stats, for N = 1,000 about 8,000 and 1,000 (acceptChain.js), run one coin after another.
import { acceptChain } from "./acceptChain.js";
import { pickHighestAttempt, parseCandidate } from "./candidate.js";
import { RecordError } from "./errors.js";
import { emptyManifest, entryFor, parseManifest, published, serializeManifest, withEntry } from "./manifest.js";
import { KINDS, NameError, SERIES, parseReleaseTag } from "./packNames.js";
import { createHeaderCache } from "./packHeaderCache.js";
import { mergeStoreFiles, parseStoreFile, serializeStoreFile } from "./pointerFiles.js";
import { INDEX_KIND, addRows } from "./publishIndex.js";

// A named error for a missing or bad input of the publish job: it stops the job before anything is written.
export class PublishInputError extends RecordError {}

const PROGRAMMING_ERRORS = [TypeError, ReferenceError, RangeError];
export const isProgrammingError = (err) => PROGRAMMING_ERRORS.some((E) => err instanceof E);
export const issue = (code, severity, slug, title, detail) => ({ code, severity, slug, title, detail });
export const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const describe = (err) => `${err.name}: ${err.message}`;

const isFn = (v) => typeof v === "function";

function checkInputs(a) {
  const need = (ok, what) => {
    if (!ok) throw new PublishInputError(`publish: ${what}`);
  };
  need(KINDS.includes(a.kind), `kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(a.kind)}`);
  need(a.blobs && isFn(a.blobs.stat) && isFn(a.blobs.readRange), "blobs must be a blob store (stat and readRange)");
  need(Array.isArray(a.candidates) && a.candidates.every((c) => c && typeof c.text === "string"), "candidates must be a list of { name, text }");
  need(isFn(a.readManifest), "readManifest must be a function");
  need(isFn(a.readStoreFile), "readStoreFile must be a function");
  need(a.index && isFn(a.index.load), "index must have a load(slug) function");
  need(a.out && isFn(a.out.writeManifest) && isFn(a.out.writeIndex) && isFn(a.out.writeStoreFile), "out must have writeManifest, writeIndex and writeStoreFile");
  need(a.adoptionAlerts === undefined || (a.adoptionAlerts !== null && typeof a.adoptionAlerts === "object" && !Array.isArray(a.adoptionAlerts)), "adoptionAlerts must be a map of slug to alerts");
}

function parseAll(candidates, issues) {
  const parsed = [];
  for (const { name, text } of candidates) {
    try {
      parsed.push(parseCandidate(text));
    } catch (err) {
      if (!(err instanceof RecordError)) throw err;
      issues.push(issue("candidate-refused", "error", null, `candidate ${name} is refused`, describe(err)));
    }
  }
  return parsed;
}

// The releases the accepted coins' bundles sit in, per series, the highest sequence, with `extra`.
function releasesOfRun(chains, extra) {
  const releases = { ...extra };
  const consider = (tag) => {
    let p;
    try {
      p = parseReleaseTag(tag);
    } catch (err) {
      if (err instanceof NameError) return; // validated earlier; a tag that is not one names no series
      throw err;
    }
    if (!SERIES.includes(p.series)) return;
    if (releases[p.series] === undefined || parseReleaseTag(releases[p.series]).seq < p.seq) releases[p.series] = tag;
  };
  for (const chain of chains) for (const e of chain) consider(e.bundle.release);
  return { schema: 1, releases };
}

async function publishCoin({ slug, coin, kind, blobs, headers, readManifest, index, out, publishedAt, issues }) {
  const fail = (code, title, err) => {
    issues.push(issue(code, "error", slug, title, describe(err)));
    return { slug, status: "failed", code };
  };
  let manifest;
  try {
    const text = await readManifest(slug);
    manifest = text === null ? emptyManifest(slug) : parseManifest(text, { slug });
  } catch (err) {
    if (isProgrammingError(err)) throw err;
    return fail(err instanceof RecordError ? "manifest-unreadable" : "manifest-read-failed", `the manifest of ${slug} cannot be read; the coin keeps its main entry and the file is not overwritten`, err);
  }
  let res;
  try {
    res = await acceptChain({ blobs, slug, kind, main: entryFor(manifest, kind), chain: coin.chain, headers });
  } catch (err) {
    if (isProgrammingError(err)) throw err;
    return fail("accept-failed", `the chain of ${slug} (${kind}) could not be checked; the coin keeps its main entry`, err);
  }
  if (res.status === "stale") {
    issues.push(issue("stale", "notice", slug, `${kind} candidate of ${slug} is stale`, `${res.reason}: expected parent ${res.expected}, got ${res.got}`));
    return { slug, status: "stale" };
  }
  if (res.status === "superseded") return { slug, status: "superseded" };
  if (res.status !== "accepted") {
    const { status, ...rest } = res;
    issues.push(issue("chain-refused", "error", slug, `${kind} candidate of ${slug} is refused`, JSON.stringify(rest)));
    return { slug, status };
  }
  let rows = null;
  if (kind === INDEX_KIND) {
    try {
      rows = addRows({ slug, rows: await index.load(slug), entries: res.entries, today: publishedAt.slice(0, 10) });
    } catch (err) {
      if (isProgrammingError(err)) throw err;
      return fail("index-unreadable", `the index rows of ${slug} cannot be read; the coin keeps its main entry`, err);
    }
  }
  try {
    const last = published(res.entries.at(-1), publishedAt);
    const next = withEntry(manifest, kind, last);
    if (rows !== null) await out.writeIndex(slug, rows);
    await out.writeManifest(slug, serializeManifest(next));
    return { slug, status: "accepted", day: last.day, entries: res.entries.length };
  } catch (err) {
    if (isProgrammingError(err)) throw err;
    return fail("write-failed", `the manifest or index rows of ${slug} cannot be written; the coin keeps its main entry`, err);
  }
}

function alertIssues(adoptionAlerts) {
  return Object.entries(adoptionAlerts).sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([slug, alerts]) => (
    alerts.length === 0 ? [] : [issue("adoption-alert", "error", slug, `adoption alerts for ${slug}`, alerts.map((a) => `${a.code} x${a.count}`).join(", "))]
  ));
}

export async function publishKind(args) {
  checkInputs(args);
  const { kind, blobs, candidates, readManifest, readStoreFile, index, out, clock = Date.now, headers = createHeaderCache(), adoptionAlerts = {}, runReleases = {} } = args;
  const publishedAt = isoSeconds(clock());
  const issues = [];
  const parsed = parseAll(candidates, issues);
  const storeText = await readStoreFile();
  if (typeof storeText !== "string") throw new PublishInputError("publish: store.json on main was not given (the workflow writes the empty store file when main has none)");
  const mainStore = parseStoreFile(storeText);
  const { coins, conflicts } = parsed.length > 0 ? pickHighestAttempt(parsed, kind) : { coins: {}, conflicts: [] };
  for (const c of conflicts) issues.push(issue("candidate-conflict", "error", c.slug, `candidates of ${c.slug} disagree`, c.reason));
  const results = [];
  for (const slug of Object.keys(coins).sort()) {
    results.push(await publishCoin({ slug, coin: coins[slug], kind, blobs, headers, readManifest, index, out, publishedAt, issues }));
  }
  issues.push(...alertIssues(adoptionAlerts));
  const accepted = results.filter((r) => r.status === "accepted").map((r) => r.slug);
  let storeFile = null;
  if (accepted.length > 0) {
    const merged = mergeStoreFiles(mainStore, releasesOfRun(accepted.map((slug) => coins[slug].chain), runReleases));
    if (serializeStoreFile(merged) !== serializeStoreFile(mainStore)) {
      storeFile = serializeStoreFile(merged);
      await out.writeStoreFile(storeFile);
    }
  }
  return { kind, publishedAt, accepted, results, issues, storeFile, headers: headers.stats() };
}
