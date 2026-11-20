import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../../store-publish.js";
import { LaneArgError } from "./laneCli.js";
import { OriginFactsError } from "./laneNames.js";
import { parseManifest, entryFor } from "./manifest.js";
import { parseStoreFile } from "./pointerFiles.js";
import { parseIndexFile } from "./publishIndex.js";
import { candidateText, emptyStoreText } from "./publishKit.js";
import { folderEnv, runOf, writeCoins } from "./recordKit.js";

// The CLI end to end on a folder store: origin/main facts and candidates as files, outputs as files, no git, no network.
const made = [];
const envs = [];
afterAll(() => {
  made.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  envs.forEach((e) => e.cleanup());
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "store-publish-"));
  made.push(d);
  return d;
};
const put = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const quiet = () => {
  const lines = [];
  return { logger: { log: (m) => lines.push(m), error: (m) => lines.push(m) }, lines };
};

async function setup() {
  const env = folderEnv();
  envs.push(env);
  const run = runOf(4000);
  const recs = await writeCoins({ env, specs: ["example-01", "example-02"].map((slug) => ({ slug, run, day: "2026-11-17" })) });
  const [origin, cands, out, issues] = [tmp(), tmp(), tmp(), path.join(tmp(), "issues.json")];
  put(cands, "candidate-holders-l0f1-a1/candidate.json", candidateText({ run, chains: { "example-01": [recs[0].entry], "example-02": [recs[1].entry] } }));
  put(origin, "manifests/store.json", emptyStoreText());
  for (const s of ["example-01", "example-02"]) put(origin, `manifests/${s}.absent`, "");
  const argv = ["--kind", "holders", "--origin-dir", origin, "--candidates-dir", cands, "--out-dir", out, "--issues-out", issues, "--store-dir", env.dir];
  return { env, recs, origin, cands, out, issues, argv };
}

describe("store-publish.js", () => {
  it("publishes: manifests, index rows and store.json in the out directory, and an issues file", async () => {
    const w = await setup();
    const q = quiet();
    expect(await main(w.argv, { logger: q.logger })).toBe(0);
    for (const [i, slug] of ["example-01", "example-02"].entries()) {
      const m = parseManifest(fs.readFileSync(path.join(w.out, `manifests/${slug}.json`), "utf8"), { slug });
      expect(entryFor(m, "holders").bundle).toEqual(w.recs[i].entry.bundle);
      expect(parseIndexFile(fs.readFileSync(path.join(w.out, `manifests/index/${slug}.json`), "utf8"), slug)).toHaveLength(1);
    }
    expect(parseStoreFile(fs.readFileSync(path.join(w.out, "manifests/store.json"), "utf8")).releases.live).toBe(w.recs[0].entry.bundle.release);
    expect(JSON.parse(fs.readFileSync(w.issues, "utf8"))).toEqual({ schema: 1, kind: "holders", phase: "publish", issues: [] });
    expect(q.lines[0]).toMatch(/2 accepted/);
  });

  it("writes a refused coin as an issue in the file, and the other coin is still published", async () => {
    const w = await setup();
    put(w.origin, "manifests/example-01.json", "{ not json");
    fs.rmSync(path.join(w.origin, "manifests/example-01.absent"));
    expect(await main(w.argv, { logger: quiet().logger })).toBe(0);
    const { issues } = JSON.parse(fs.readFileSync(w.issues, "utf8"));
    expect(issues.map((i) => [i.code, i.slug])).toEqual([["manifest-unreadable", "example-01"]]);
    expect(fs.existsSync(path.join(w.out, "manifests/example-01.json"))).toBe(false);
    expect(fs.existsSync(path.join(w.out, "manifests/example-02.json"))).toBe(true);
  });

  it("raises adoption alerts from a file as issues", async () => {
    const w = await setup();
    const alerts = path.join(tmp(), "alerts.json");
    fs.writeFileSync(alerts, JSON.stringify({ "example-02": [{ code: "unreadable", count: 1 }] }));
    await main([...w.argv, "--adoption-alerts", alerts], { logger: quiet().logger });
    expect(JSON.parse(fs.readFileSync(w.issues, "utf8")).issues.map((i) => i.code)).toEqual(["adoption-alert"]);
  });

  it("fails closed: a missing origin fact or candidates directory stops the step with nothing written", async () => {
    const w = await setup();
    fs.rmSync(path.join(w.origin, "manifests/store.json"));
    await expect(main(w.argv, { logger: quiet().logger })).rejects.toThrow(OriginFactsError);
    fs.rmSync(path.join(w.origin, "manifests/example-02.absent"));
    put(w.origin, "manifests/store.json", emptyStoreText());
    // a coin with neither manifest nor marker is an unreadable coin, not a new one
    await main(w.argv, { logger: quiet().logger });
    expect(JSON.parse(fs.readFileSync(w.issues, "utf8")).issues.map((i) => [i.code, i.slug])).toEqual([["manifest-read-failed", "example-02"]]);
    expect(fs.existsSync(path.join(w.out, "manifests/example-02.json"))).toBe(false);
    const fresh = path.join(tmp(), "out");
    await expect(main(w.argv.map((a) => (a === w.cands ? path.join(w.cands, "nope") : a === w.out ? fresh : a)), { logger: quiet().logger })).rejects.toThrow(OriginFactsError);
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it("refuses wrong arguments", async () => {
    const w = await setup();
    await expect(main(["--kind", "nope", ...w.argv.slice(2)], { logger: quiet().logger })).rejects.toThrow(LaneArgError);
    await expect(main(w.argv.slice(2), { logger: quiet().logger })).rejects.toThrow(LaneArgError);
    await expect(main([...w.argv, "--phase", "later"], { logger: quiet().logger })).rejects.toThrow(LaneArgError);
    await expect(main([...w.argv.filter((a) => a !== w.cands), "--bogus", "1"], { logger: quiet().logger })).rejects.toThrow(LaneArgError);
  });

  it("sweeps after the push: dry by default, needs --history-days and a site.json", async () => {
    const w = await setup();
    await main(w.argv, { logger: quiet().logger });
    const origin = tmp();
    for (const f of ["store.json", "example-01.json", "example-02.json"]) put(origin, `manifests/${f}`, fs.readFileSync(path.join(w.out, `manifests/${f}`), "utf8"));
    for (const s of ["example-01", "example-02"]) put(origin, `manifests/index/${s}.json`, fs.readFileSync(path.join(w.out, `manifests/index/${s}.json`), "utf8"));
    const sweepArgs = ["--phase", "sweep", "--kind", "holders", "--origin-dir", origin, "--issues-out", w.issues, "--store-dir", w.env.dir];
    const root = tmp();
    put(root, "config/projects.json", JSON.stringify({ projects: ["example-01", "example-02"].map((slug) => ({ slug, name: slug, ticker: "X" })) }));
    const q = quiet();
    await expect(main([...sweepArgs, "--history-days", "400"], { logger: q.logger, root })).rejects.toThrow(/site\.json/);
    expect(JSON.parse(fs.readFileSync(w.issues, "utf8")).issues.map((i) => i.code)).toEqual(["crash"]);
    put(origin, "manifests/site.json", JSON.stringify({ schema: 1, root: null }));
    await expect(main(sweepArgs, { logger: q.logger, root })).rejects.toThrow(/history-days/);
    expect(await main([...sweepArgs, "--history-days", "400"], { logger: q.logger, root })).toBe(0);
    expect(JSON.parse(fs.readFileSync(w.issues, "utf8"))).toMatchObject({ phase: "sweep", issues: [] });
    expect(q.lines.at(-1)).toMatch(/^sweep dry: done, 2 coins, 0 packs planned for deletion, 0 deleted/);
    await expect(main([...sweepArgs, "--history-days", "400", "--sweep-mode", "run"], { logger: q.logger })).rejects.toThrow(/packs-written/);
    await expect(main(["--phase", "sweep", "--kind", "ledger", ...sweepArgs.slice(4), "--history-days", "400"], { logger: q.logger })).rejects.toThrow(LaneArgError);
  });

  it("the sweep's coins are the manifests on main plus the registry's slugs", async () => {
    const w = await setup();
    await main(w.argv, { logger: quiet().logger });
    const origin = tmp();
    for (const f of ["store.json", "example-01.json", "example-02.json"]) put(origin, `manifests/${f}`, fs.readFileSync(path.join(w.out, `manifests/${f}`), "utf8"));
    put(origin, "manifests/example-03.absent", ""); // registered, no manifest yet
    put(origin, "manifests/site.json", JSON.stringify({ schema: 1, root: null }));
    const root = tmp();
    put(root, "config/projects.json", JSON.stringify({ projects: ["example-01", "example-03"].map((slug) => ({ slug, name: slug, ticker: "X" })) }));
    const q = quiet();
    const argv = ["--phase", "sweep", "--kind", "holders", "--origin-dir", origin, "--issues-out", w.issues, "--store-dir", w.env.dir, "--history-days", "400"];
    expect(await main(argv, { logger: q.logger, root })).toBe(0);
    expect(q.lines.at(-1)).toMatch(/^sweep dry: done, 3 coins,/);
  });

  it("a corrupt index file is reported as index-unreadable and the coin keeps its main entry", async () => {
    const w = await setup();
    put(w.origin, "manifests/index/example-01.json", "{ not json");
    await main(w.argv, { logger: quiet().logger });
    const { issues } = JSON.parse(fs.readFileSync(w.issues, "utf8"));
    expect(issues.map((i) => [i.code, i.slug])).toEqual([["index-unreadable", "example-01"]]);
    expect(fs.existsSync(path.join(w.out, "manifests/example-01.json"))).toBe(false);
    expect(fs.existsSync(path.join(w.out, "manifests/example-02.json"))).toBe(true);
  });

  it("a crash leaves nothing in --out-dir, no temporary sibling, and still writes the issues file with a crash issue", async () => {
    // the first coin's stats are counted on a run of its own; the crash run throws a programming error at the next one
    const probe = await setup();
    const counted = { n: 0 };
    const wrap = (blobs, throwAfter = Infinity) => ({ ...blobs, stat: (...a) => { counted.n++; if (counted.n > throwAfter) throw new TypeError("boom"); return blobs.stat(...a); } });
    await main(probe.argv, { logger: quiet().logger, blobs: wrap(probe.env.blobs) });
    const perRun = counted.n;
    expect(perRun).toBeGreaterThanOrEqual(2);
    const w = await setup();
    const parent = tmp();
    const out = path.join(parent, "out");
    const argv = w.argv.map((a) => (a === w.out ? out : a));
    counted.n = 0;
    await expect(main(argv, { logger: quiet().logger, blobs: wrap(w.env.blobs, perRun / 2) })).rejects.toThrow(TypeError);
    expect(counted.n).toBeGreaterThan(perRun / 2); // the second coin was reached after the first was written
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(parent)).toEqual([]);
    const { issues } = JSON.parse(fs.readFileSync(w.issues, "utf8"));
    expect(issues).toEqual([expect.objectContaining({ code: "crash", severity: "error", slug: null, detail: expect.stringContaining("boom") })]);
    // an input that is missing is a crash too: the issues file says so
    await expect(main(argv.map((a) => (a === w.cands ? path.join(w.cands, "nope") : a)), { logger: quiet().logger })).rejects.toThrow(OriginFactsError);
    expect(JSON.parse(fs.readFileSync(w.issues, "utf8")).issues.map((i) => i.code)).toEqual(["crash"]);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("moves a finished output into a missing or empty --out-dir and refuses one that already holds files", async () => {
    const w = await setup(); // its --out-dir is an existing empty directory
    await main(w.argv, { logger: quiet().logger });
    expect(fs.existsSync(path.join(w.out, "manifests/example-01.json"))).toBe(true);
    expect(fs.readdirSync(path.dirname(w.out)).filter((n) => n.startsWith(`${path.basename(w.out)}.tmp-`))).toEqual([]);
    await expect(main(w.argv, { logger: quiet().logger })).rejects.toThrow(LaneArgError);
    expect(JSON.parse(fs.readFileSync(w.issues, "utf8")).issues).toEqual([]); // wrong arguments are not a crash of the step
  });
});
