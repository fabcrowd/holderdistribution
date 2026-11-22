import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRegistry, projectDataRelPath, resolveProject } from "../projects.js";
import { workflowPlan } from "../../workflow-paths.js";
import { layoutFromRegistry } from "./laneCli.js";
import { createLanePacker } from "./lanePack.js";
import { folderEnv } from "./recordKit.js";
import { DAYS, KIND, SLUGS, asHex, createHarness, layoutOf, liveTagOf, publishCandidates, snapshot, writeNightFiles } from "./laneKit.js";
import { ROWS_PER_BUCKET, TABLE_FILES, specsFor, tableSpecsFor } from "./tableSpecs.js";

const EVER = "holders-ever-checkpoint.json";

describe("tableSpecsFor over the registry", () => {
  const slugs = loadRegistry().map((p) => p.slug);

  it("gives every registered coin the ever-held table at its own data path, from the registry alone", () => {
    expect(slugs.length).toBeGreaterThan(1);
    for (const slug of slugs) {
      const specs = tableSpecsFor(slug, layoutFromRegistry(slug, process.cwd()));
      expect(specs, slug).toHaveLength(1);
      const [spec] = specs;
      expect(spec.path).toBe(projectDataRelPath(resolveProject(slug), EVER));
      expect(spec).toMatchObject({ table: "everHeld", fields: 1, rowsPerBucket: ROWS_PER_BUCKET });
      for (const fn of ["readHeader", "readRows", "write"]) expect(typeof spec.format[fn]).toBe("function");
      expect(workflowPlan(resolveProject(slug)).HD_REQUIRED_FILES.split(" ")).toContain(EVER);
    }
    expect(new Set(slugs.map((s) => tableSpecsFor(s, layoutFromRegistry(s, process.cwd()))[0].path)).size).toBe(slugs.length);
  });

  it("gives no spec for a file the coin does not produce, and refuses an unregistered coin", () => {
    expect(specsFor({ dataDir: "public/data/x", requiredFiles: ["tel-holders.json"] })).toEqual([]);
    expect(specsFor({ dataDir: "public/data/x", requiredFiles: [EVER] }).map((s) => s.path)).toEqual([`public/data/x/${EVER}`]);
    expect(() => tableSpecsFor("no-such-coin", { dataDir: "public/data/no-such-coin" })).toThrow(/unknown project/);
  });

  it("each table file has one format and the table name is unique", () => {
    expect(new Set(TABLE_FILES.map((t) => t.table)).size).toBe(TABLE_FILES.length);
    expect(new Set(TABLE_FILES.map((t) => t.file)).size).toBe(TABLE_FILES.length);
  });
});

// Two nights of three coins through the lane's start and end steps with these specs (R lowered to 6 so the
// table has several buckets and splits), then a third start: the ever-held files come back byte for byte.
const hex = (i) => `0x${((i * 2654435761) % 2 ** 32).toString(16).padStart(8, "0")}${"ab".repeat(16)}`;
const everText = (slug, night) => {
  const addresses = Array.from({ length: 30 + 25 * night }, (_, i) => hex(i * 7 + slug.length)).sort();
  return JSON.stringify({ generatedAt: DAYS[night - 1], cumulativeHolders: addresses.length, addresses });
};

describe("the ever-held spec in the lane", () => {
  let h;
  afterEach(() => h?.cleanup());

  it("packs two nights and restores each night's file byte for byte", async () => {
    h = createHarness(folderEnv(), { tables: false });
    const slugs = SLUGS;
    const specsOf = (slug) => specsFor({ dataDir: layoutOf(slug).dataDir, requiredFiles: [EVER] }).map((s) => ({ ...s, rowsPerBucket: 6 }));
    const lane = { specsFor: specsOf };
    const expected = {};
    const stats = [];
    for (const n of [1, 2]) {
      const { outDir, startDir, r } = await h.start(n, { lane });
      for (const slug of slugs) {
        expect(JSON.stringify(r.coins[slug]), `${slug} start ${n}`).toContain("restored");
        if (n === 2) expect(asHex(snapshot(outDir, slug)), `${slug} restored at the start of night 2`).toEqual(asHex(expected[slug]));
      }
      for (const slug of slugs) await writeNightFiles(outDir, slug, n, { table: false, extra: { [`public/data/${slug}/${EVER}`]: everText(slug, n) } });
      for (const slug of slugs) expected[slug] = snapshot(outDir, slug);
      const packer = createLanePacker({
        kind: KIND, blobs: h.env.blobs, run: { id: 100 + n, attempt: 1, workflow: "refresh-holders.yml" }, lane: 0, day: DAYS[n - 1], root: outDir, startDir,
        candidateDir: h.tmp(`cand${n}`), spoolDir: h.tmp(`spool${n}`), git: h.git, layoutFor: (s) => layoutOf(s), specsFor: specsOf,
        usedFor: () => ({ providerA: 3 }),
      });
      for (const slug of slugs) await packer.packCoin(slug);
      const out = await packer.finish();
      h.state.liveTag = await liveTagOf(h.env.blobs);
      for (const slug of slugs) expect(out.coins[slug].status, `${slug} pack ${n}`).toBe("packed");
      const pub = await publishCandidates({ blobs: h.env.blobs, state: h.state, files: out.candidates });
      expect(pub.refused).toEqual([]);
      stats.push(out.coins[slugs[0]].stats.tables.everHeld);
    }
    expect(stats[0]).toMatchObject({ first: true, changeRows: 0 });
    expect(stats[1]).toMatchObject({ first: false, changeRows: 25 });
    expect(stats[1].splits + stats[1].basesWritten).toBeGreaterThan(0);

    const three = await h.start(3, { lane });
    for (const slug of slugs) {
      expect(three.r.coins[slug].status).toBe("restored");
      expect(asHex(snapshot(three.outDir, slug)), `${slug} restored after night 2`).toEqual(asHex(expected[slug]));
      expect(fs.readFileSync(path.join(three.outDir, `public/data/${slug}/${EVER}`), "utf8")).toBe(everText(slug, 2));
    }
  }, 120_000);
});
