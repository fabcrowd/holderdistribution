import { afterAll, describe, expect, it } from "vitest";
import { PublishInputError, publishKind } from "./publish.js";
import { sweepStore } from "./publishSweep.js";
import { asCandidate, candidateText, clockAt, emptyStoreText, memorySeams } from "./publishKit.js";
import { releaseEnv, runOf, writeCoins } from "./recordKit.js";
import { NOW, exists, livePack, packBytes, putObject } from "./sweepKit.js";

const envs = [];
afterAll(() => envs.forEach((e) => e.cleanup()));

// Two coins published through publishKind on the fake release server (every pack made at time 0, so old, and every
// pack named by a manifest), then orphan live packs of chosen age put beside them.
async function world() {
  const env = releaseEnv();
  envs.push(env);
  const run = runOf(3000);
  const recs = await writeCoins({ env, specs: ["example-01", "example-02"].map((slug) => ({ slug, run, day: "2026-11-17" })) });
  const chains = { "example-01": [recs[0].entry], "example-02": [recs[1].entry] };
  const seams = memorySeams();
  await publishKind({
    kind: "holders", blobs: env.blobs, candidates: [asCandidate("c.json", candidateText({ run, chains }))], clock: clockAt(),
    readManifest: seams.readManifest, readStoreFile: seams.readStoreFile, index: seams.index, out: seams.out,
  });
  const realPacks = env.server.release("data-live-1").assets.map((a) => `data-live-1/${a.name}`);
  const orphan = async (n, slug) => putObject(env.server, "data-live-1", livePack(n, "2026-10-01"), await packBytes({ slugs: [slug] }), { ageDays: 30 });
  const args = (over = {}) => ({
    blobs: env.blobs, coins: ["example-01", "example-02"], readManifest: seams.readManifest, readStoreFile: async () => seams.written.store ?? emptyStoreText(),
    index: seams.index, historyDays: 400, packsWritten: 10, sleep: async () => {}, clock: () => Date.parse(NOW), ...over,
  });
  return { env, seams, realPacks, orphan, args };
}

describe("sweepStore", () => {
  it("is a dry run by default; a real run deletes the orphan and no pack a manifest names", async () => {
    const w = await world();
    expect(w.realPacks.length).toBeGreaterThan(0);
    const gone = await w.orphan(1, "example-01");
    const dry = await sweepStore(w.args());
    expect(dry).toMatchObject({ status: "done", dryRun: true, executed: null, issues: [] });
    expect(dry.plan.delete.map((d) => d.loc)).toEqual([gone]);
    expect(exists(w.env.server, gone)).toBe(true);
    const real = await sweepStore(w.args({ dryRun: false }));
    expect(real.executed.deleted).toEqual([gone]);
    expect(exists(w.env.server, gone)).toBe(false);
    for (const loc of w.realPacks) expect(exists(w.env.server, loc), loc).toBe(true);
  });

  it("keeps every pack that lists a coin whose manifest cannot be read, and still sweeps the others", async () => {
    const w = await world();
    const mine = await w.orphan(1, "example-01");
    const pinned = await w.orphan(2, "example-02");
    const broken = memorySeams({ manifests: { "example-01": w.seams.written.manifests.get("example-01"), "example-02": "{ not json" } });
    const r = await sweepStore(w.args({ dryRun: false, readManifest: broken.readManifest }));
    expect(r.status).toBe("done");
    expect(r.executed.deleted).toEqual([mine]);
    expect(exists(w.env.server, pinned)).toBe(true);
    expect(r.plan.keep.find((k) => k.loc === pinned).code).toBe("unreadable-coin");
  });

  it("returns a plan error as an issue and deletes nothing", async () => {
    const w = await world();
    const orphan = await w.orphan(1, "example-01");
    const r = await sweepStore(w.args({ dryRun: false, removedCoins: [] }));
    expect(r).toMatchObject({ status: "failed", plan: null, executed: null });
    expect(r.issues).toEqual([expect.objectContaining({ code: "sweep-plan-error", severity: "error", slug: null, detail: expect.stringContaining("removedCoins") })]);
    expect(exists(w.env.server, orphan)).toBe(true);
  });

  it("takes the release of a series from store.json and falls back to the newest one in the listing", async () => {
    const w = await world();
    const r = await sweepStore(w.args({ readStoreFile: async () => JSON.stringify({ schema: 1, releases: { hist: "data-hist-4" } }) }));
    expect(r.status).toBe("done");
    expect(r.plan.summary.byClass).toHaveProperty("hist");
  });

  it("fails closed on a missing input", async () => {
    const w = await world();
    await expect(sweepStore(w.args({ historyDays: undefined }))).rejects.toThrow(PublishInputError);
    await expect(sweepStore(w.args({ coins: null }))).rejects.toThrow(PublishInputError);
    await expect(sweepStore(w.args({ readStoreFile: async () => null }))).rejects.toThrow(PublishInputError);
    await expect(sweepStore(w.args({ index: {} }))).rejects.toThrow(PublishInputError);
  });
});
