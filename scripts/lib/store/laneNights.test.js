import { describe, expect, it } from "vitest";
import { readBundle } from "./bundle.js";
import { entryFor, parseManifest, serializeManifest } from "./manifest.js";
import { coinReferences } from "./references.js";
import { readStartRecord } from "./startRecord.js";
import { runSweep } from "./sweep.js";
import { folderEnv, releaseEnv } from "./recordKit.js";
import { DAYS, KIND, SLUGS, asHex, createHarness, liveTagOf, publishCandidates, snapshot } from "./laneKit.js";

// Three nights of three coins through the lane's start and end steps on real packs (folder backend and
// the fake release server): restore, mutate the files, pack, then the candidates go through acceptChain
// and the manifests take the accepted entries (publishCandidates is a test helper, not publish.js).
// Night 2: coin-b fails at the end step (a file the store cannot hold) and coin-c's candidate is not
// published (its publish lost the race); night 3 starts coin-b from main and adopts coin-c's bundle.
async function threeNights(h) {
  const expected = {};
  const log = [];
  for (const n of [1, 2, 3]) {
    const { outDir, startDir, r } = await h.start(n);
    for (const slug of SLUGS) {
      expect(r.coins[slug].status, `${slug} night ${n}`).toBe("restored");
      expect(asHex(snapshot(outDir, slug)), `${slug} restored at the start of night ${n}`).toEqual(n === 1 ? [] : asHex(expected[slug]));
    }
    const extra = n === 2 ? { "coin-b": { "public/data/coin-b/big.json#slice.0": "x" } } : {};
    const { out, after } = await h.pack(n, { outDir, startDir, extra });
    const pub = await publishCandidates({ blobs: h.env.blobs, state: h.state, files: out.candidates, skip: n === 2 ? ["coin-c"] : [] });
    for (const slug of SLUGS) if (out.coins[slug].status === "packed") expected[slug] = after[slug];
    log.push({ n, restored: r, out, pub, startDir });
  }
  return { expected, log };
}

describe.each([["folder", folderEnv], ["release", releaseEnv]])("three nights of three coins on the %s backend", (name, makeEnv) => {
  it("restores each night's files byte for byte, adopts an unpublished bundle, survives a failed coin", async () => {
    const h = createHarness(makeEnv());
    const env = h.env;
    const w = h;
    const { expected, log } = await threeNights(h);
    const [n1, n2, n3] = log;
    expect(n1.out.coins["coin-a"]).toMatchObject({ status: "packed", chain: 1 });
    expect(n2.out.coins["coin-b"]).toMatchObject({ status: "failed", stage: "pack", error: "UnclassifiedFileError" });
    expect(n2.out.coins["coin-a"].status).toBe("packed");
    expect(n2.pub.accepted.sort()).toEqual(["coin-a"]);
    expect(n2.pub.refused).toEqual([]);
    // coin-c's bundle of night 2 was packed but never published: night 3 adopts it and packs on top.
    expect(n3.restored.coins["coin-c"].source).toBe("adopted");
    expect(n3.restored.coins["coin-c"].chain).toBe(1);
    expect(n3.restored.coins["coin-b"].source).toBe("main");
    expect((await readStartRecord(n3.startDir, "coin-c")).chain).toHaveLength(1);
    expect(n3.out.coins["coin-c"]).toMatchObject({ status: "packed", chain: 2 });
    expect(n3.pub.accepted.sort()).toEqual(SLUGS);
    expect(n3.pub.refused).toEqual([]);
    for (const slug of SLUGS) {
      const entry = entryFor(parseManifest(serializeManifest(w.state.manifests.get(slug))), KIND);
      expect(entry.day).toBe(DAYS[2]);
    }
    // the fixtures exercise the table machinery: a first write, change files, splits, carried blobs, two classes of pack
    const table = (n) => log[n - 1].out.coins["coin-a"].stats.tables.acct;
    expect(table(1)).toMatchObject({ first: true, splits: 0 });
    expect(table(2).changeRows).toBeGreaterThan(0);
    expect(table(2).splits + table(3).splits).toBeGreaterThan(0);
    expect(log[1].out.coins["coin-a"].stats.blobs.carried).toBeGreaterThan(0);
    const names = log.flatMap((l) => l.out.packs.map((p) => p.name));
    expect(names.some((x) => x.startsWith("p.hist.holders."))).toBe(true);
    expect(names.filter((x) => x.startsWith("p.live.holders.")).length).toBeGreaterThanOrEqual(6);
    // a fourth start restores exactly the last night's files for every coin
    const four = await h.start(4);
    for (const slug of SLUGS) {
      expect(four.r.coins[slug].status).toBe("restored");
      expect(asHex(snapshot(four.outDir, slug))).toEqual(asHex(expected[slug]));
    }
    h.cleanup();
  }, 120_000);

  it("the sweep (dry run) keeps every pack a current bundle references", async () => {
    const h = createHarness(makeEnv());
    const env = h.env;
    const w = h;
    await threeNights(h);
    const clockMs = (env.server ? env.server.clock.t : Date.now()) + 40 * 86_400_000;
    const today = new Date(clockMs).toISOString().slice(0, 10);
    const needed = new Set();
    const referencesFor = async (slug) => {
      const res = await coinReferences({
        slug, today, loadManifest: async () => w.state.manifests.get(slug), loadIndexRows: async () => [],
        readBundle: (a) => readBundle({ blobs: env.blobs, ...a }),
      });
      expect(res, JSON.stringify(res)).toMatchObject({ status: "ok" });
      for (const loc of res.locations ?? []) needed.add(loc);
      return res;
    };
    const res = await runSweep({
      blobs: env.blobs, clock: () => clockMs, historyDays: 400, coins: SLUGS, referencesFor, removedCoins: new Map(), oldestNeededDay: new Map(),
      currentReleases: { live: await liveTagOf(env.blobs), hist: "data-hist-1", events: "data-events-1", site: "data-site-1" }, packsWritten: 100, sleep: async () => {}, dryRun: true,
    });
    const planned = new Set(res.plan.delete.map((d) => d.loc));
    expect(needed.size).toBeGreaterThan(0);
    for (const loc of needed) expect(planned.has(loc), `${loc} is referenced and must not be planned for deletion`).toBe(false);
    // not vacuous: nights 1 and 2 left live packs that no current bundle names
    expect(planned.size).toBeGreaterThan(0);
    // every hist pack is kept: its day is inside the horizon
    for (const d of res.plan.delete) expect(d.series).toBe("live");
    h.cleanup();
  }, 120_000);
});
