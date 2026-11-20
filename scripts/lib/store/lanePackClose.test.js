import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { parseCandidate } from "./candidate.js";
import { createLanePacker } from "./lanePack.js";
import { DuplicateCoinError } from "./laneNames.js";
import { folderEnv } from "./recordKit.js";
import { DAYS, createHarness, layoutOf, specsOf, writeNightFiles } from "./laneKit.js";

// The lane's own `endCoin` fails for coin-b only: the failure path of packCoin must not drop that error.
vi.mock("./packLane.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    createLane: (opts) => {
      const lane = real.createLane(opts);
      return { ...lane, endCoin: async (slug, names) => { if (slug === "coin-b") throw new Error("end boom"); return lane.endCoin(slug, names); } };
    },
  };
});

let h;
afterEach(() => h?.cleanup());

describe("a coin whose end of items failed", () => {
  it("stays failed for the run: not in the candidate, not packed later, a second packCoin is refused", async () => {
    h = createHarness(folderEnv(), { slugs: ["coin-a", "coin-b"] });
    const first = await h.start(1);
    for (const s of h.slugs) await writeNightFiles(first.outDir, s, 1);
    const packer = createLanePacker({
      kind: "holders", blobs: h.env.blobs, run: { id: 7, attempt: 1, workflow: "refresh-holders.yml" }, lane: 0, day: DAYS[0], root: first.outDir, startDir: first.startDir,
      candidateDir: h.tmp("c"), spoolDir: h.tmp("s"), git: h.git, layoutFor: (s) => layoutOf(s, h.slugs), specsFor: (s) => specsOf(s),
    });
    await packer.packCoin("coin-b");
    await packer.packCoin("coin-a");
    await expect(packer.packCoin("coin-b")).rejects.toThrow(DuplicateCoinError);
    const out = await packer.finish();
    expect(out.coins["coin-b"]).toMatchObject({ status: "failed", stage: "pack" });
    expect(out.coins["coin-b"].message).toContain("end boom");
    expect(out.coins["coin-a"].status).toBe("packed");
    expect(Object.keys(parseCandidate(fs.readFileSync(out.candidates[0], "utf8")).coins)).toEqual(["coin-a"]);
  });
});

describe("a coin that fails and whose items cannot be closed either", () => {
  it("is reported with both reasons; the others of the lane still pack", async () => {
    h = createHarness(folderEnv(), { slugs: ["coin-a", "coin-b"] });
    const first = await h.start(1);
    const { out } = await h.pack(1, { ...first, extra: { "coin-b": { "public/data/coin-b/x.json#slice.0": "x" } } });
    expect(out.coins["coin-a"].status).toBe("packed");
    expect(out.coins["coin-b"]).toMatchObject({ status: "failed", stage: "pack" });
    expect(out.coins["coin-b"].message).toContain("end boom");
    expect(out.coins["coin-b"].message).toContain("neither stored nor excluded");
  });
});
