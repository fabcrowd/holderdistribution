import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainPackRows, checkChainPacks, judgeChain, MISSING_PACK } from "./chain.js";
import { acceptChain } from "./acceptChain.js";
import { bundleKey } from "./bundle.js";
import { RecordShapeError } from "./errors.js";
import { entryKey, labelMarker, published } from "./manifest.js";
import { packName } from "./packNames.js";
import { ADOPTION_WINDOW_DAYS } from "./storeConstants.js";
import { SLUG, runOf, folderEnv, releaseEnv, writeCoin, writeCoins } from "./recordKit.js";

const AT = "2026-11-18T03:12:40Z";
const key = (w) => bundleKey(w.bundleRef);
const h = (c) => c.repeat(64);
const usage = { day: "2026-11-18", month: "2026-11", run: { a: 1 }, dayTotal: { a: 1 }, monthTotal: { a: 1 } };
const pack = (n) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: n, attempt: 1, lane: 0, flush: 0 });
const synth = (n, id, release, sha, parent) => ({
  bundle: { ref: `${pack(n)}#${id}`, release, packSize: 100, headerSha256: h("a"), sha256: sha },
  parent, day: "2026-11-18", run: runOf(n), usage,
});

describe.each([["folder", folderEnv], ["release", releaseEnv]])("acceptChain on the %s backend", (_, makeEnv) => {
  const e = makeEnv();
  let a0;
  let a1;
  let a2;
  let shared;
  beforeAll(async () => {
    a0 = await writeCoin({ env: e, slug: "alpha", day: "2026-11-16", run: runOf(10, 1) });
    a1 = await writeCoin({ env: e, slug: "alpha", day: "2026-11-17", run: runOf(11, 1), parent: key(a0), parentUsage: a0.bundle.usage });
    a2 = await writeCoin({ env: e, slug: "alpha", day: "2026-11-18", run: runOf(12, 1), parent: key(a1), parentUsage: a1.bundle.usage });
    // Two coins in one pack, both started from alpha's bundle a0 (as a shared lane would).
    shared = await writeCoins({ env: e, specs: [
      { slug: "alpha", day: "2026-11-17", run: runOf(20, 1), parent: key(a0) },
      { slug: "beta", day: "2026-11-17", run: runOf(20, 1), parent: key(a0) },
    ] });
  });
  afterAll(() => e.cleanup());

  const accept = (blobs, main, ...entries) => acceptChain({ blobs, slug: "alpha", kind: "holders", main: main ? published(main.entry, AT) : null, chain: entries });

  it("accepts a chain of two, reading each bundle, at 0 API requests", async () => {
    const blobs = e.fresh();
    const before = blobs.stats ? blobs.stats().core : 0;
    // every accepted entry carries the label-check marker acceptChain sets
    expect(await accept(blobs, a0, a1.entry, a2.entry)).toEqual({ status: "accepted", entries: [a1.entry, a2.entry].map((x) => ({ ...x, labelCheck: labelMarker(x) })) });
    if (blobs.stats) expect(blobs.stats().core - before).toBe(0);
  });

  it("passes stale, superseded and judge-level refusals through without reading anything", async () => {
    const never = { stat: () => { throw new Error("must not be read"); }, readRange: () => { throw new Error("must not be read"); } };
    expect((await accept(never, a1, a0.entry, a1.entry)).status).toBe("superseded");
    expect((await accept(never, a1, a0.entry)).status).toBe("stale");
    expect((await accept(never, a0)).status).toBe("refused");
  });

  it("S1: another coin's bundle in the same shared pack is refused as this coin's entry", async () => {
    const [alpha, beta] = shared;
    expect(alpha.bundleRef.ref.split("#")[0]).toBe(beta.bundleRef.ref.split("#")[0]); // one pack
    expect(await accept(e.fresh(), a0, alpha.entry)).toMatchObject({ status: "accepted" }); // control
    const r = await accept(e.fresh(), a0, beta.entry);
    expect(r).toMatchObject({ status: "refused", reason: "bundle not verified", index: 0 });
    expect(r.detail).toMatch(/beta/);
    expect(judgeChain({ main: published(a0.entry, AT), chain: [beta.entry] }).status).toBe("accepted"); // the pure judge alone cannot tell
  });

  it("a bundle that does not hash to its entry's sha256 is refused", async () => {
    const bad = { ...a1.entry, bundle: { ...a1.entry.bundle, sha256: h("0") } };
    expect(await accept(e.fresh(), a0, bad)).toMatchObject({ status: "refused", reason: "bundle not verified", index: 0 });
  });

  it("an entry whose parent is not its bundle's own parent is refused", async () => {
    const x = await writeCoin({ env: e, slug: "alpha", day: "2026-11-17", run: runOf(30, 1), parent: null });
    const r = await accept(e.fresh(), a0, { ...x.entry, parent: key(a0) });
    expect(r).toMatchObject({ status: "refused", reason: "bundle not verified" });
    expect(r.detail).toMatch(/parent/);
  });

  it("an entry whose day or run differs from its bundle's is refused", async () => {
    expect(await accept(e.fresh(), a0, { ...a1.entry, day: "2026-11-30" })).toMatchObject({ status: "refused", reason: "bundle not verified" });
    expect((await accept(e.fresh(), a0, { ...a1.entry, run: runOf(99, 1) })).status).toBe("refused");
  });

  it("a missing pack is refused before any bundle is read", async () => {
    const moved = { ...a1.entry, bundle: { ...a1.entry.bundle, release: "data-live-9" } };
    expect(await accept(e.fresh(), a0, moved)).toMatchObject({ status: "refused", reason: MISSING_PACK });
  });

  it("chainPackRows and checkChainPacks check each pack at its location and size", async () => {
    const rows = chainPackRows([a1.entry]);
    expect(await checkChainPacks({ blobs: e.fresh(), rows })).toEqual({ status: "ok" });
    expect(await checkChainPacks({ blobs: e.fresh(), rows: rows.map((r) => ({ ...r, size: r.size + 1 })) })).toMatchObject({ status: "refused", reason: MISSING_PACK });
    expect(await checkChainPacks({ blobs: e.fresh(), rows: rows.map((r) => ({ ...r, loc: r.loc.replace("data-live-1", "data-live-9") })) })).toMatchObject({ status: "refused", reason: MISSING_PACK });
    expect(await checkChainPacks({ blobs: e.fresh(), rows: [] })).toEqual({ status: "ok" });
  });
});

describe("a chain longer than the adoption window", () => {
  it("is refused with a reason, before any pack is asked for", async () => {
    const never = { stat: () => { throw new Error("must not be read"); } };
    const chain = [];
    for (let i = 1; i <= ADOPTION_WINDOW_DAYS + 1; i++) chain.push(synth(i, 0, "data-live-1", h("b"), i === 1 ? null : entryKey(chain[i - 2])));
    const r = await acceptChain({ blobs: never, slug: SLUG, kind: "holders", main: null, chain });
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/longer than the adoption window of 16 days/);
  });
});

describe("acceptChain validates its arguments: a caller bug is a named shape error", () => {
  const never = { stat: () => { throw new Error("must not be read"); } };
  const good = synth(1, 0, "data-live-1", h("1"), null);
  const call = (over) => acceptChain({ blobs: never, slug: SLUG, kind: "holders", main: null, chain: [good], ...over });

  it("main = { bundle: null } (review input one)", async () => {
    await expect(call({ main: { bundle: null } })).rejects.toThrow(RecordShapeError);
  });
  it("a chain entry with no bundle field (review input two)", async () => {
    const { bundle, ...noBundle } = good;
    await expect(call({ chain: [noBundle] })).rejects.toThrow(RecordShapeError);
    await expect(call({ chain: [noBundle] })).rejects.toThrow(/example\/holders/);
  });
  it("main must be a published entry, and chain entries candidate entries", async () => {
    await expect(call({ main: good })).rejects.toThrow(RecordShapeError);
    await expect(call({ chain: [published(good, AT)] })).rejects.toThrow(RecordShapeError);
  });
  it("a bad slug, a bad kind, a chain that is not a list", async () => {
    await expect(call({ slug: "../x" })).rejects.toThrow(RecordShapeError);
    await expect(call({ kind: "Holders" })).rejects.toThrow(RecordShapeError);
    await expect(call({ chain: "nope" })).rejects.toThrow(RecordShapeError);
    await expect(call({ chain: undefined })).rejects.toThrow(RecordShapeError);
  });
  it("an entry of another kind than the call's", async () => {
    await expect(call({ kind: "ledger" })).rejects.toThrow(RecordShapeError);
  });
  it("an empty chain is still an expected outcome, not a bad argument", async () => {
    expect(await call({ chain: [] })).toEqual({ status: "refused", reason: "empty chain" });
  });
});
