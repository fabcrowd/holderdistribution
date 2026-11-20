import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleItems, readBundle } from "./bundle.js";
import { entryFor, emptyManifest, parseManifest, serializeManifest } from "./manifest.js";
import { folderEnv } from "./recordKit.js";
import { readStartRecord } from "./startRecord.js";
import { safeJoin } from "./laneRestore.js";
import { DuplicateCoinError, OriginFactsError, RestoreError } from "./laneNames.js";
import { fileGit } from "./laneCli.js";
import { KIND, SLUGS, asHex, createHarness, gitSeam, jsonTable, publishCandidates, put, snapshot, tablePath, tableText, writeOriginFacts } from "./laneKit.js";

let h;
afterEach(() => h?.cleanup());

async function onePublishedNight() {
  h = createHarness(folderEnv());
  const first = await h.start(1);
  const { out, after } = await h.pack(1, first);
  await publishCandidates({ blobs: h.env.blobs, state: h.state, files: out.candidates });
  return { after };
}

describe("restore, start step", () => {
  it("a new coin restores nothing and writes a start record with no parent and no chain", async () => {
    h = createHarness(folderEnv());
    const { startDir, outDir, r } = await h.start(1);
    expect(r.coins["coin-a"]).toMatchObject({ status: "restored", source: "new", files: [], chain: 0 });
    expect(fs.readdirSync(outDir)).toEqual([]);
    expect(await readStartRecord(startDir, "coin-a")).toMatchObject({ parent: null, chain: [], usage: null, buckets: {} });
  });

  it("restores blobs and tables, and start.json holds the checked state hash of every bucket", async () => {
    const { after } = await onePublishedNight();
    const second = await h.start(2);
    for (const slug of SLUGS) {
      expect(second.r.coins[slug].status).toBe("restored");
      expect(asHex(snapshot(second.outDir, slug))).toEqual(asHex(after[slug]));
    }
    const rec = await readStartRecord(second.startDir, "coin-a");
    expect(rec.parent).not.toBeNull();
    expect(rec.chain).toEqual([]);
    expect(rec.buckets.acct.length).toBeGreaterThan(1);
    for (const b of rec.buckets.acct) expect(b.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(rec.usage.run).toEqual({ providerA: 3 });
  });

  it("a refusal of the stale-code guard stops every coin with a named stage", async () => {
    h = createHarness(folderEnv(), { commits: [{ sha: "abcdef1", committedAt: "2026-11-01T00:00:00Z", files: ["scripts/x.js"] }] });
    h.git.isAncestor = async () => false;
    const { r: res } = await h.start(1);
    for (const slug of SLUGS) expect(res.coins[slug]).toMatchObject({ status: "failed", stage: "stale-code", error: "RestoreError" });
    expect(res.coins["coin-a"].message).toContain("run is older than the code on main");
  });

  it("a coin whose manifest is unreadable is skipped and the lane goes on", async () => {
    const { after } = await onePublishedNight();
    const git = gitSeam(h.state);
    const real = git.readManifest;
    git.readManifest = async (slug) => (slug === "coin-b" ? "{ not json" : real(slug));
    const second = await h.start(2, { git });
    expect(second.r.coins["coin-b"]).toMatchObject({ status: "failed", stage: "manifest" });
    expect(second.r.coins["coin-a"].status).toBe("restored");
    expect(asHex(snapshot(second.outDir, "coin-c"))).toEqual(asHex(after["coin-c"]));
    expect(snapshot(second.outDir, "coin-b").size).toBe(0);
  });

  it("a damaged base fails that coin only: the state check or the item hash names it", async () => {
    await onePublishedNight();
    const entry = entryFor(parseManifest(serializeManifest(h.state.manifests.get("coin-a"))), KIND);
    const bundle = await readBundle({ blobs: h.env.blobs, slug: "coin-a", kind: KIND, bundleRef: entry.bundle, crossCheck: false });
    const baseRef = bundle.tables.acct.buckets.find((b) => b.base).base;
    const items = bundleItems({ blobs: h.env.blobs, bundle, bundleRef: entry.bundle });
    const it = await items.entryOf(baseRef);
    const pack = baseRef.slice(0, baseRef.lastIndexOf("#"));
    const row = bundle.packs.find((p) => p.name === pack);
    const file = path.join(h.env.dir, row.loc);
    const bytes = fs.readFileSync(file);
    const bodyStart = 8 + bytes.readUInt32BE(4);
    bytes[bodyStart + it.off + (it.len >> 1)] ^= 0xff;
    fs.writeFileSync(file, bytes);
    const second = await h.start(2);
    expect(second.r.coins["coin-a"]).toMatchObject({ status: "failed", stage: "start" });
    expect(second.r.coins["coin-a"].error).toMatch(/Pack|Store|Check/);
    for (const slug of ["coin-b", "coin-c"]) expect(second.r.coins[slug].status).toBe("restored");
  });

  it("a bundle with a table no spec names fails the coin", async () => {
    await onePublishedNight();
    const noTables = createHarness(h.env, { tables: false });
    noTables.state.manifests = h.state.manifests;
    noTables.state.liveTag = h.state.liveTag;
    const second = await noTables.start(2);
    for (const slug of SLUGS) expect(second.r.coins[slug]).toMatchObject({ status: "failed", stage: "start" });
    expect(second.r.coins["coin-a"].message).toContain("no table spec names");
    expect(second.r.coins["coin-a"].message).toContain("retired");
  });
});

const sharing = (env, from, opts) => {
  const other = createHarness(env, opts);
  other.state.manifests = from.state.manifests;
  other.state.liveTag = from.state.liveTag;
  return other;
};

describe("origin facts fail closed (H1)", () => {
  it("an empty origin directory fails the lane; a coin with a published manifest but no manifest file fails that coin only", async () => {
    await onePublishedNight();
    await expect(h.start(2, { git: fileGit(h.tmp("origin-empty")) })).rejects.toThrow(OriginFactsError);
    const origin = h.tmp("origin");
    const text = (slug) => serializeManifest(h.state.manifests.get(slug));
    writeOriginFacts(origin, { manifests: { "coin-a": text("coin-a"), "coin-c": text("coin-c") }, store: `${JSON.stringify({ schema: 1, releases: { live: h.state.liveTag } })}\n` });
    const second = await h.start(2, { git: fileGit(origin) });
    expect(second.r.coins["coin-b"]).toMatchObject({ status: "failed", stage: "origin", error: "OriginFactsError" });
    expect(second.r.coins["coin-b"].message).toContain("coin-b");
    expect(snapshot(second.outDir, "coin-b").size).toBe(0);
    expect(second.r.coins["coin-a"]).toMatchObject({ status: "restored", source: expect.not.stringMatching(/^new$/) });
    expect(second.r.coins["coin-c"].status).toBe("restored");
  });

  it("the explicit marker is a new coin; a history that is not complete stops the lane", async () => {
    h = createHarness(folderEnv());
    const origin = h.tmp("origin");
    writeOriginFacts(origin, { manifests: { "coin-a": null, "coin-b": null, "coin-c": null } });
    const first = await h.start(1, { git: fileGit(origin) });
    for (const slug of SLUGS) expect(first.r.coins[slug]).toMatchObject({ status: "restored", source: "new" });
    writeOriginFacts(origin, { manifests: {}, history: { commits: [], complete: false } });
    await expect(h.start(1, { git: fileGit(origin) })).rejects.toThrow(/complete must be true/);
  });

  it("a coin named twice is refused", async () => {
    h = createHarness(folderEnv());
    await expect(h.start(1, { lane: { slugs: ["coin-a", "coin-a"] } })).rejects.toThrow(DuplicateCoinError);
  });
});

describe("what a restore writes (H2, H3, M1, M2)", () => {
  it("a file that was a blob and is a table tonight is still restored from the blob", async () => {
    h = createHarness(folderEnv(), { slugs: ["coin-a"], tables: false });
    const first = await h.start(1);
    const n1 = await h.pack(1, { ...first, extra: { "coin-a": { [tablePath("coin-a")]: tableText("coin-a", 1) } } });
    expect(n1.out.coins["coin-a"].status).toBe("packed");
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: n1.out.candidates });
    const withTable = sharing(h.env, h, { slugs: ["coin-a"] });
    const second = await withTable.start(2);
    expect(second.r.coins["coin-a"].status).toBe("restored");
    expect(fs.readFileSync(path.join(second.outDir, tablePath("coin-a")), "utf8")).toBe(tableText("coin-a", 1));
    const n2 = await withTable.pack(2, second);
    expect(n2.out.coins["coin-a"].status).toBe("packed");
    await publishCandidates({ blobs: h.env.blobs, state: withTable.state, files: n2.out.candidates });
    const third = await withTable.start(3);
    expect(asHex(snapshot(third.outDir, "coin-a"))).toEqual(asHex(n2.after["coin-a"]));
  });

  it("a file the generator deleted stays deleted, also when the output directory is a checkout that still holds it", async () => {
    h = createHarness(folderEnv(), { slugs: ["coin-a"] });
    const first = await h.start(1);
    const n1 = await h.pack(1, { ...first, extra: { "coin-a": { "data/coin-a/old.json": "{}" } } });
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: n1.out.candidates });
    const second = await h.start(2);
    expect(fs.existsSync(path.join(second.outDir, "data/coin-a/old.json"))).toBe(true);
    fs.rmSync(path.join(second.outDir, "data/coin-a/old.json"));
    const n2 = await h.pack(2, second);
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: n2.out.candidates });
    const checkout = h.tmp("checkout");
    put(checkout, "data/coin-a/old.json", "{}");
    put(checkout, "data/coin-a/cex-candidates.json", "hand kept");
    put(checkout, "data/elsewhere/x.json", "not this coin's");
    const third = await h.start(3, { outDir: checkout });
    expect(third.r.coins["coin-a"].status).toBe("restored");
    expect(fs.existsSync(path.join(checkout, "data/coin-a/old.json"))).toBe(false);
    expect(fs.readFileSync(path.join(checkout, "data/coin-a/cex-candidates.json"), "utf8")).toBe("hand kept");
    expect(fs.readFileSync(path.join(checkout, "data/elsewhere/x.json"), "utf8")).toBe("not this coin's");
    const kept = new Map([...snapshot(checkout, "coin-a")].filter(([k]) => !k.endsWith("cex-candidates.json")));
    expect(asHex(kept)).toEqual(asHex(n2.after["coin-a"]));
  });

  it("a coin with no stored state keeps the files already in the output directory", async () => {
    h = createHarness(folderEnv(), { slugs: ["coin-a"] });
    const checkout = h.tmp("checkout");
    put(checkout, "data/coin-a/keep.json", "mine");
    const first = await h.start(1, { outDir: checkout });
    expect(first.r.coins["coin-a"].source).toBe("new");
    expect(fs.readFileSync(path.join(checkout, "data/coin-a/keep.json"), "utf8")).toBe("mine");
  });

  it("a table the specs no longer name is restored as a file while its spec is kept as retired, and is packed as a blob", async () => {
    const { after } = await onePublishedNight();
    const retired = sharing(h.env, h, { tables: "retired" });
    const second = await retired.start(2);
    for (const slug of SLUGS) expect(second.r.coins[slug].status).toBe("restored");
    expect(asHex(snapshot(second.outDir, "coin-a"))).toEqual(asHex(after["coin-a"]));
    const n2 = await retired.pack(2, second);
    expect(n2.out.coins["coin-a"]).toMatchObject({ status: "packed" });
    expect(Object.keys(n2.out.coins["coin-a"].stats.tables)).toEqual([]);
    await publishCandidates({ blobs: h.env.blobs, state: retired.state, files: n2.out.candidates });
    const none = sharing(h.env, retired, { tables: false });
    const third = await none.start(3);
    for (const slug of SLUGS) expect(third.r.coins[slug].status).toBe("restored");
    expect(asHex(snapshot(third.outDir, "coin-a"))).toEqual(asHex(n2.after["coin-a"]));
  });

  it("a rebuilt table file that is not byte-equal to the file that was packed fails the coin", async () => {
    const spaced = { ...jsonTable, async write(file, header, buckets) { await jsonTable.write(file, header, buckets); fs.appendFileSync(file, " "); } };
    h = createHarness(folderEnv(), { slugs: ["coin-a"], format: spaced });
    const first = await h.start(1);
    const n1 = await h.pack(1, first);
    expect(n1.out.coins["coin-a"].status).toBe("packed");
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: n1.out.candidates });
    const second = await h.start(2);
    expect(second.r.coins["coin-a"]).toMatchObject({ status: "failed", stage: "start", error: "RestoreError" });
    expect(second.r.coins["coin-a"].message).toContain("sha256");
    expect(fs.existsSync(path.join(second.outDir, tablePath("coin-a")))).toBe(false);
  });

  it("a failed restore leaves no start.json from a prior run, so the pack step fails the coin", async () => {
    const spaced = { ...jsonTable, async write(file, header, buckets) { await jsonTable.write(file, header, buckets); fs.appendFileSync(file, " "); } };
    h = createHarness(folderEnv(), { slugs: ["coin-a"], format: spaced });
    const first = await h.start(1);
    const startFile = path.join(first.startDir, "coin-a", "start.json");
    expect(fs.existsSync(startFile)).toBe(true);
    const n1 = await h.pack(1, first);
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: n1.out.candidates });
    const second = await h.start(2, { startDir: first.startDir });
    expect(second.r.coins["coin-a"]).toMatchObject({ status: "failed", stage: "start" });
    expect(fs.existsSync(startFile)).toBe(false);
    const n2 = await h.pack(2, second);
    expect(n2.out.coins["coin-a"]).toMatchObject({ status: "failed", stage: "pack" });
    expect(n2.out.candidates).toEqual([]);
  });
});

describe("safeJoin", () => {
  it("keeps a path inside the output directory", () => {
    const root = path.resolve("out");
    expect(safeJoin(root, "public/data/x.json", "s")).toBe(path.join(root, "public", "data", "x.json"));
    for (const bad of ["../x.json", "a/../../x.json", "..", "", "x\0y"]) expect(() => safeJoin(root, bad, "s"), JSON.stringify(bad)).toThrow(RestoreError);
    expect(() => safeJoin(root, path.resolve("/etc/passwd"), "s")).toThrow(RestoreError);
  });
});

describe("a coin with no manifest file and an empty manifest", () => {
  it("an entry-less manifest is a new coin for this kind", async () => {
    h = createHarness(folderEnv());
    h.state.manifests.set("coin-a", emptyManifest("coin-a"));
    const { r: res } = await h.start(1);
    expect(res.coins["coin-a"]).toMatchObject({ status: "restored", source: "new" });
  });
});
