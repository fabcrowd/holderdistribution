import { afterAll, describe, expect, it, vi } from "vitest";
import { acceptChain } from "./acceptChain.js";
import { parseManifest, entryFor, labelMarker, serializeManifest, withEntry, published } from "./manifest.js";
import { parseStoreFile, serializeStoreFile } from "./pointerFiles.js";
import { createHeaderCache } from "./packHeaderCache.js";
import { parseIndexFile } from "./publishIndex.js";
import { bundleKey } from "./bundle.js";
import { PublishInputError, publishKind } from "./publish.js";
import { asCandidate, candidateText, childOf, clockAt, countingBlobs, emptyStoreText, memorySeams, PUBLISH_AT } from "./publishKit.js";
import { folderEnv, releaseEnv, runOf, writeCoins } from "./recordKit.js";

// acceptChain runs for real; the spy records what publish passes it.
vi.mock("./acceptChain.js", async (importOriginal) => ({ acceptChain: vi.fn((await importOriginal()).acceptChain) }));

const envs = [];
const track = (e) => { envs.push(e); return e; };
afterAll(() => envs.forEach((e) => e.cleanup()));

const D1 = "2026-11-17";
const D2 = "2026-11-18";
const SLUGS = ["example-01", "example-02", "example-03"];
let runs = 1000;
const run = () => runOf(runs++);

// One night of the given coins (sharing packs, as one lane's coins do): { recs, run, text }.
async function night(env, { slugs = SLUGS, day = D1, parents = {}, kind = "holders" } = {}) {
  const r = run();
  const recs = await writeCoins({ env, specs: slugs.map((slug) => ({ slug, kind, day, run: r, ...(parents[slug] ?? {}) })) });
  const chains = Object.fromEntries(recs.map((rec, i) => [slugs[i], [rec.entry]]));
  return { recs, run: r, chains, text: candidateText({ kind, run: r, chains }), by: Object.fromEntries(recs.map((rec, i) => [slugs[i], rec])) };
}

const publish = (env, seams, over = {}) => publishKind({
  kind: "holders", blobs: env.blobs, clock: clockAt(), readManifest: seams.readManifest, readStoreFile: seams.readStoreFile, index: seams.index, out: seams.out, ...over,
});
const errorsOf = (r) => r.issues.filter((i) => i.severity === "error");

describe.each([["folder", folderEnv], ["release", releaseEnv]])("publishKind on the %s backend", (_, makeEnv) => {
  it("accepts a night of coins through one shared header cache and writes manifests, rows and store.json", async () => {
    const env = track(makeEnv());
    const n = await night(env);
    const seams = memorySeams();
    const headers = createHeaderCache();
    const r = await publish(env, seams, { candidates: [asCandidate("c.json", n.text)], headers });
    expect(r.accepted).toEqual(SLUGS);
    expect(r.issues).toEqual([]);
    expect(headers.stats().hits).toBeGreaterThan(0); // coins share packs: read once per publish, not per coin
    const calls = acceptChain.mock.calls.slice(-SLUGS.length).map(([a]) => a);
    expect(calls.map((a) => a.slug)).toEqual(SLUGS);
    expect(calls.every((a) => a.headers === headers)).toBe(true);
    const own = acceptChain.mock.calls.length;
    await publish(env, memorySeams(), { candidates: [asCandidate("c.json", n.text)] });
    const made = acceptChain.mock.calls.slice(own).map(([a]) => a.headers);
    expect(made).toHaveLength(SLUGS.length);
    expect(new Set(made).size).toBe(1); // no cache given: still one for the whole publish
    expect(made[0]).toBeDefined();
    for (const slug of SLUGS) {
      const m = parseManifest(seams.written.manifests.get(slug), { slug });
      const e = entryFor(m, "holders");
      expect(e).toMatchObject({ day: D1, run: n.run, parent: null, publishedAt: PUBLISH_AT, labelCheck: labelMarker(n.by[slug].entry) });
      expect(e.bundle).toEqual(n.by[slug].entry.bundle);
      expect(parseIndexFile(`${JSON.stringify({ schema: 1, slug, rows: seams.written.index.get(slug) })}`, slug)).toEqual([{ day: D1, part: 1, bundle: n.by[slug].entry.bundle }]);
    }
    expect(seams.written.order.at(-1)).toBe("store");
    expect(parseStoreFile(seams.written.store).releases.live).toBe(n.recs[0].entry.bundle.release);
  });

  it("refuses a bundle whose bytes do not hash to the entry, and a pack of the wrong size, without touching the others", async () => {
    const env = track(makeEnv());
    const n = await night(env);
    const bad = structuredClone(n.chains["example-01"]);
    bad[0].bundle.sha256 = "0".repeat(64);
    const short = structuredClone(n.chains["example-02"]);
    short[0].bundle.packSize += 1;
    const text = candidateText({ run: n.run, chains: { ...n.chains, "example-01": bad, "example-02": short } });
    const seams = memorySeams();
    const r = await publish(env, seams, { candidates: [asCandidate("c.json", text)] });
    expect(r.accepted).toEqual(["example-03"]);
    expect(errorsOf(r).map((i) => [i.code, i.slug])).toEqual([["chain-refused", "example-01"], ["chain-refused", "example-02"]]);
    expect([...seams.written.manifests.keys()]).toEqual(["example-03"]);
    expect([...seams.written.index.keys()]).toEqual(["example-03"]);
  });

  it("answers stale with a notice and writes nothing for the coin; superseded writes nothing and raises nothing", async () => {
    const env = track(makeEnv());
    const first = await night(env, { slugs: ["example-01", "example-02"] });
    const seams1 = memorySeams();
    await publish(env, seams1, { candidates: [asCandidate("c.json", first.text)] });
    const manifests = Object.fromEntries([...seams1.written.manifests]);
    // another run published a different day-2 bundle: coin 01's candidate has no parent, so it is stale; coin 02's candidate equals main
    const other = await night(env, { slugs: ["example-01"], day: D2 });
    const m1 = withEntry(parseManifest(manifests["example-01"], { slug: "example-01" }), "holders", published(other.recs[0].entry, PUBLISH_AT));
    const seams = memorySeams({ manifests: { ...manifests, "example-01": serializeManifest(m1) } });
    const again = await night(env, { slugs: ["example-01"], day: D1 });
    const staleOnly = candidateText({ run: again.run, chains: { "example-01": again.chains["example-01"] } });
    const r = await publish(env, seams, { candidates: [asCandidate("c.json", staleOnly)] });
    expect(r.accepted).toEqual([]);
    expect(r.results).toEqual([{ slug: "example-01", status: "stale" }]);
    expect(r.issues.map((i) => [i.code, i.severity, i.slug])).toEqual([["stale", "notice", "example-01"]]);
    expect(seams.written.manifests.size).toBe(0);
    expect(r.storeFile).toBeNull();
    const sup = candidateText({ run: first.run, chains: { "example-02": first.chains["example-02"] } });
    const seams2 = memorySeams({ manifests });
    const r2 = await publish(env, seams2, { candidates: [asCandidate("c.json", sup)] });
    expect(r2.results).toEqual([{ slug: "example-02", status: "superseded" }]);
    expect(r2.issues).toEqual([]);
    expect(seams2.written.manifests.size).toBe(0);
  });

  it("one coin's failure never blocks another: unreadable, wrong-schema, unreadable-by-io and unwritable manifests", async () => {
    const env = track(makeEnv());
    const slugs = ["example-01", "example-02", "example-03", "example-04", "example-05"];
    const n = await night(env, { slugs });
    const seams = memorySeams({
      manifests: { "example-01": "{ not json", "example-02": JSON.stringify({ schema: 9, slug: "example-02", entries: {} }) },
      readFails: ["example-03"], writeFails: ["example-04"],
    });
    const r = await publish(env, seams, { candidates: [asCandidate("c.json", n.text)] });
    expect(r.accepted).toEqual(["example-05"]);
    expect(errorsOf(r).map((i) => [i.slug, i.code])).toEqual([
      ["example-01", "manifest-unreadable"], ["example-02", "manifest-unreadable"], ["example-03", "manifest-read-failed"], ["example-04", "write-failed"],
    ]);
    expect([...seams.written.manifests.keys()]).toEqual(["example-05"]); // an unreadable manifest is never overwritten
    expect(seams.written.store).not.toBeNull();
  });

  it("a second publish of the same day is part 2; a chain of two days writes a row for each entry", async () => {
    const env = track(makeEnv());
    const one = await night(env, { slugs: ["example-01"], day: D1 });
    const seams = memorySeams();
    await publish(env, seams, { candidates: [asCandidate("a.json", one.text)] });
    const sameDay = await night(env, { slugs: ["example-01"], day: D1, parents: { "example-01": childOf(one.by["example-01"]) } });
    await publish(env, seams, { candidates: [asCandidate("b.json", sameDay.text)] });
    expect(seams.written.index.get("example-01").map((r) => [r.day, r.part])).toEqual([[D1, 1], [D1, 2]]);
    // an adopted entry (day 1, third run) then this run's entry (day 2) published together
    const adopted = await night(env, { slugs: ["example-02"], day: D1 });
    const next = await night(env, { slugs: ["example-02"], day: D2, parents: { "example-02": childOf(adopted.by["example-02"]) } });
    const text = candidateText({ run: next.run, chains: { "example-02": [adopted.by["example-02"].entry, next.by["example-02"].entry] } });
    await publish(env, seams, { candidates: [asCandidate("c.json", text)] });
    expect(seams.written.index.get("example-02").map((r) => [r.day, r.part, bundleKey(r.bundle)])).toEqual([
      [D1, 1, bundleKey(adopted.by["example-02"].bundleRef)], [D2, 1, bundleKey(next.by["example-02"].bundleRef)],
    ]);
    const m = parseManifest(seams.written.manifests.get("example-02"), { slug: "example-02" });
    expect(entryFor(m, "holders").day).toBe(D2);
  });

  it("passes main's label-check marker on to acceptChain, so an accepted entry is not checked again as if it had none", async () => {
    const env = track(makeEnv());
    const one = await night(env, { slugs: ["example-01"], day: D1 });
    const seams = memorySeams();
    await publish(env, seams, { candidates: [asCandidate("a.json", one.text)] });
    const two = await night(env, { slugs: ["example-01"], day: D2, parents: { "example-01": childOf(one.by["example-01"]) } });
    const cand = [asCandidate("b.json", two.text)];
    const s2 = memorySeams({ manifests: { "example-01": seams.written.manifests.get("example-01") } });
    const counted = countingBlobs(env.blobs);
    const r = await publish(env, s2, { blobs: counted.blobs, candidates: cand });
    expect(r.accepted).toEqual(["example-01"]);
    // acceptChain got main exactly as the manifest holds it, marker included, never a stripped copy
    const call = acceptChain.mock.calls.at(-1)[0];
    expect(call.main.labelCheck).toEqual(labelMarker(one.by["example-01"].entry));
    expect(call.main).toEqual(entryFor(parseManifest(seams.written.manifests.get("example-01"), { slug: "example-01" }), "holders"));
    expect(entryFor(parseManifest(s2.written.manifests.get("example-01"), { slug: "example-01" }), "holders").labelCheck).toEqual(labelMarker(two.by["example-01"].entry));
  });

  it("writes no index row for a kind other than holders", async () => {
    const env = track(makeEnv());
    const n = await night(env, { slugs: ["example-01"], kind: "ledger" });
    const seams = memorySeams();
    const r = await publish(env, seams, { kind: "ledger", candidates: [asCandidate("c.json", n.text)] });
    expect(r.accepted).toEqual(["example-01"]);
    expect(seams.written.index.size).toBe(0);
    expect(entryFor(parseManifest(seams.written.manifests.get("example-01"), { slug: "example-01" }), "ledger").day).toBe(D1);
  });
});

describe("candidates, store.json, alerts and inputs", () => {
  it("refuses a candidate of an unknown schema with an error and carries on with the rest; no candidates writes nothing", async () => {
    const env = track(folderEnv());
    const n = await night(env, { slugs: ["example-01"] });
    const seams = memorySeams();
    const r = await publish(env, seams, { candidates: [asCandidate("old.json", JSON.stringify({ schema: 7, kind: "holders", run: n.run, coins: {} })), asCandidate("c.json", n.text)] });
    expect(r.accepted).toEqual(["example-01"]);
    expect(errorsOf(r).map((i) => [i.code, i.slug])).toEqual([["candidate-refused", null]]);
    const none = memorySeams();
    const r2 = await publish(env, none, { candidates: [] });
    expect(r2).toMatchObject({ accepted: [], storeFile: null });
    expect(none.written.order).toEqual([]);
  });

  it("takes the highest attempt of a coin and reports two different artifacts of one attempt as a conflict", async () => {
    const env = track(folderEnv());
    const r1 = runOf(2000, 1);
    const [a, b] = [await writeCoins({ env, specs: [{ slug: "example-01", run: r1, day: D1 }] }), await writeCoins({ env, specs: [{ slug: "example-01", run: r1, day: D1 }] })];
    const text = (rec) => candidateText({ run: r1, chains: { "example-01": [rec[0].entry] } });
    const seams = memorySeams();
    const r = await publish(env, seams, { candidates: [asCandidate("a.json", text(a)), asCandidate("b.json", text(b))] });
    expect(r.accepted).toEqual([]);
    expect(errorsOf(r).map((i) => i.code)).toEqual(["candidate-conflict"]);
  });

  it("store.json takes the maximum sequence of main and the run, per series, and is written only when something was accepted", async () => {
    const env = track(folderEnv());
    const n = await night(env, { slugs: ["example-01"] });
    const live = n.recs[0].entry.bundle.release;
    const main = serializeStoreFile({ schema: 1, releases: { live: "data-live-7", events: "data-events-2" } });
    const seams = memorySeams({ store: main });
    await publish(env, seams, { candidates: [asCandidate("c.json", n.text)], runReleases: { hist: "data-hist-3", events: "data-events-1" } });
    expect(parseStoreFile(seams.written.store).releases).toEqual({ live: "data-live-7", hist: "data-hist-3", events: "data-events-2" });
    expect(live).toMatch(/^data-live-\d+$/);
    const none = memorySeams({ store: main });
    await publish(env, none, { candidates: [], runReleases: { hist: "data-hist-3" } });
    expect(none.written.store).toBeNull();
  });

  it("turns adoption alerts into issues the caller can raise", async () => {
    const env = track(folderEnv());
    const r = await publish(env, memorySeams(), { candidates: [], adoptionAlerts: { "example-01": [{ code: "unreadable-dropped", count: 2 }], "example-02": [] } });
    expect(r.issues).toEqual([expect.objectContaining({ code: "adoption-alert", severity: "error", slug: "example-01", detail: expect.stringContaining("unreadable-dropped") })]);
  });

  it("fails closed on a missing or bad input, before anything is written", async () => {
    const env = track(folderEnv());
    const n = await night(env, { slugs: ["example-01"] });
    const ok = memorySeams();
    const base = { kind: "holders", blobs: env.blobs, candidates: [asCandidate("c.json", n.text)], readManifest: ok.readManifest, readStoreFile: ok.readStoreFile, index: ok.index, out: ok.out };
    for (const [name, patch] of [["kind", { kind: "nope" }], ["blobs", { blobs: null }], ["candidates", { candidates: null }], ["readManifest", { readManifest: undefined }], ["readStoreFile", { readStoreFile: undefined }], ["index", { index: {} }], ["out", { out: { writeManifest: ok.out.writeManifest } }]]) {
      await expect(publishKind({ ...base, ...patch }), name).rejects.toThrow(PublishInputError);
    }
    await expect(publishKind({ ...base, readStoreFile: async () => null })).rejects.toThrow(/store\.json/);
    await expect(publishKind({ ...base, readStoreFile: async () => "{ nope" })).rejects.toThrow(/store\.json/);
    expect(ok.written.order).toEqual([]);
  });

  it("a bad index file fails that coin only", async () => {
    const env = track(folderEnv());
    const n = await night(env, { slugs: ["example-01", "example-02"] });
    const seams = memorySeams();
    const index = { load: async (slug) => (slug === "example-01" ? [{ day: "x" }] : []) };
    const r = await publish(env, seams, { index, candidates: [asCandidate("c.json", n.text)] });
    expect(r.accepted).toEqual(["example-02"]);
    expect(errorsOf(r).map((i) => [i.slug, i.code])).toEqual([["example-01", "index-unreadable"]]);
    expect(seams.written.manifests.has("example-01")).toBe(false);
  });

  it("store.json follows the accepted coins only: A accepted in release N, B refused in N+1 leaves it at N", async () => {
    const env = track(folderEnv());
    const n = await night(env, { slugs: ["example-01", "example-02"] });
    const bad = structuredClone(n.chains["example-02"]);
    bad[0].bundle.release = "data-live-9";
    const text = candidateText({ run: n.run, chains: { "example-01": n.chains["example-01"], "example-02": bad } });
    const seams = memorySeams();
    const r = await publish(env, seams, { candidates: [asCandidate("c.json", text)] });
    expect(r.accepted).toEqual(["example-01"]);
    expect(errorsOf(r).map((i) => [i.slug, i.code])).toEqual([["example-02", "chain-refused"]]);
    expect(parseStoreFile(seams.written.store).releases).toEqual({ live: n.recs[0].entry.bundle.release });
  });
});
