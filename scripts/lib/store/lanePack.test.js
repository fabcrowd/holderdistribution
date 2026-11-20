import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCandidate } from "./candidate.js";
import { readFully } from "./laneBlobs.js";
import { DuplicateCoinError, FileShrankError } from "./laneNames.js";
import { folderEnv } from "./recordKit.js";
import { DAYS, asHex, createHarness, jsonTable, publishCandidates, put, snapshot, tablePath } from "./laneKit.js";

let h;
afterEach(() => h?.cleanup());
const ONE = ["coin-a"];

// Night 1 packed and published for one coin; returns the restored start of night 2.
async function afterFirstNight(opts = {}) {
  h = createHarness(folderEnv(), { slugs: ONE, ...opts.harness });
  const first = await h.start(1);
  const { out, after } = await h.pack(1, { ...first, ...opts.pack });
  await publishCandidates({ blobs: h.env.blobs, state: h.state, files: out.candidates });
  return { out, after, second: await h.start(2) };
}

describe("end step: files and candidates", () => {
  it("writes one candidate per group with the chain, the sha256 of every stored file and no excluded file", async () => {
    h = createHarness(folderEnv());
    const first = await h.start(1);
    const { out } = await h.pack(1, first);
    expect(out.candidates).toHaveLength(1);
    expect(path.basename(out.candidates[0])).toBe("candidate-holders-l0f0-a1.json");
    const cand = parseCandidate(fs.readFileSync(out.candidates[0], "utf8"));
    expect(Object.keys(cand.coins)).toEqual(["coin-a", "coin-b", "coin-c"]);
    const files = Object.keys(cand.coins["coin-a"].files);
    expect(files).toContain(tablePath("coin-a"));
    expect(files).toContain("public/data/coin-a/summary.json");
    expect(files.some((f) => f.endsWith(".gitkeep"))).toBe(false);
    expect(cand.coins["coin-a"].chain).toHaveLength(1);
    expect(cand.coins["coin-a"].chain[0].parent).toBeNull();
    expect(cand.coins["coin-a"].chain[0].usage.run).toEqual({ providerA: 3 });
  });

  it("groups of at most groupSize coins close separately: two candidates for three coins at 2", async () => {
    h = createHarness(folderEnv());
    const first = await h.start(1);
    const { createLanePacker } = await import("./lanePack.js");
    const { layoutOf, specsOf, writeNightFiles } = await import("./laneKit.js");
    for (const s of h.slugs) await writeNightFiles(first.outDir, s, 1);
    const packer = createLanePacker({
      kind: "holders", blobs: h.env.blobs, run: { id: 7, attempt: 1, workflow: "refresh-holders.yml" }, lane: 0, day: DAYS[0], root: first.outDir, startDir: first.startDir,
      candidateDir: h.tmp("c"), spoolDir: h.tmp("s"), git: h.git, layoutFor: (s) => layoutOf(s), specsFor: (s) => specsOf(s), groupSize: 2,
    });
    for (const s of h.slugs) await packer.packCoin(s);
    const out = await packer.finish();
    expect(out.candidates.map((f) => path.basename(f))).toEqual(["candidate-holders-l0f0-a1.json", "candidate-holders-l0f1-a1.json"]);
    expect(Object.keys(parseCandidate(fs.readFileSync(out.candidates[1], "utf8")).coins)).toEqual(["coin-c"]);
  });

  it("a coin with no table has no state index and restores its blobs", async () => {
    h = createHarness(folderEnv(), { slugs: ONE, tables: false });
    const first = await h.start(1);
    const { out, after } = await h.pack(1, first);
    expect(out.coins["coin-a"].status).toBe("packed");
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: out.candidates });
    const second = await h.start(2);
    expect(asHex(snapshot(second.outDir, "coin-a"))).toEqual(asHex(after["coin-a"]));
  });

  it("writes the candidate to a temporary name and renames it, leaving no other file", async () => {
    const fsp = (await import("node:fs/promises")).default;
    const real = fsp.writeFile;
    const targets = [];
    const spy = vi.spyOn(fsp, "writeFile").mockImplementation((file, ...rest) => {
      targets.push(String(file));
      return real(file, ...rest);
    });
    try {
      h = createHarness(folderEnv(), { slugs: ONE });
      const first = await h.start(1);
      const { out } = await h.pack(1, first);
      const final = out.candidates[0];
      expect(fs.existsSync(final)).toBe(true);
      expect(targets).not.toContain(final);
      expect(targets.some((t) => t.startsWith(final))).toBe(true);
      expect(fs.readdirSync(path.dirname(final))).toEqual([path.basename(final)]);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a coin packed twice in one lane", async () => {
    h = createHarness(folderEnv(), { slugs: ONE });
    const first = await h.start(1);
    await expect(h.pack(1, { ...first, only: ["coin-a", "coin-a"] })).rejects.toThrow(DuplicateCoinError);
  });

  it("fails the coin when the manifest on main moved after the start", async () => {
    const { second } = await afterFirstNight();
    h.state.manifests.delete("coin-a");
    const { out } = await h.pack(2, second);
    expect(out.coins["coin-a"]).toMatchObject({ status: "failed", stage: "pack" });
    expect(out.candidates).toEqual([]);
  });

  it("fails the coin when start.json no longer matches the start bundle", async () => {
    const { second } = await afterFirstNight();
    const file = path.join(second.startDir, "coin-a", "start.json");
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    rec.buckets.acct[0].hash = "0000000000000001";
    fs.writeFileSync(file, JSON.stringify(rec));
    const { out } = await h.pack(2, second);
    expect(out.coins["coin-a"]).toMatchObject({ status: "failed", stage: "pack" });
    expect(out.coins["coin-a"].message).toContain("start.json");
  });
});

describe("end step: blobs", () => {
  it("readFully gathers short reads and refuses a file that ends before the buffer is full", async () => {
    const data = Buffer.from("0123456789abcdef");
    const fileHandle = (limit) => ({
      read: async (buf, off, len, pos) => {
        const n = Math.min(limit, len, Math.max(0, data.length - pos));
        data.copy(buf, off, pos, pos + n);
        return { bytesRead: n, buffer: buf };
      },
    });
    const buf = Buffer.alloc(16);
    await readFully(fileHandle(3), buf, 0, "f.bin");
    expect(buf.equals(data)).toBe(true);
    await expect(readFully(fileHandle(3), Buffer.alloc(20), 0, "f.bin")).rejects.toThrow(FileShrankError);
  });

  it("cuts a blob over 16 MiB into 8 MiB slices and carries the slices that did not change", async () => {
    h = createHarness(folderEnv(), { slugs: ONE });
    const big = Buffer.alloc(20 * 1024 * 1024, 7);
    const first = await h.start(1);
    const n1 = await h.pack(1, { ...first, extra: { "coin-a": { "data/coin-a/big.bin": big } } });
    expect(n1.out.coins["coin-a"].status).toBe("packed");
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: n1.out.candidates });
    const second = await h.start(2);
    expect(Buffer.compare(fs.readFileSync(path.join(second.outDir, "data/coin-a/big.bin")), big)).toBe(0);
    const changed = Buffer.from(big);
    changed[changed.length - 1] = 9;
    put(second.outDir, "data/coin-a/big.bin", changed);
    const n2 = await h.pack(2, second);
    const stats = n2.out.coins["coin-a"].stats.blobs;
    // slices 0 and 1 (8 MiB each) and the two unchanged small files are carried; slice 2 and the summary are written
    expect(stats.carried).toBe(4);
    expect(stats.written).toBe(2);
    expect(stats.bytesWritten).toBeLessThan(4 * 1024 * 1024 + 1024);
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: n2.out.candidates });
    const third = await h.start(3);
    expect(Buffer.compare(fs.readFileSync(path.join(third.outDir, "data/coin-a/big.bin")), changed)).toBe(0);
  }, 120_000);

  it("writes an unchanged blob again once its pack is older than historyDays minus 30 days", async () => {
    const opts = { pack: { historyDays: 31, indexOptions: { minHistoryDays: 1, ageMarginDays: 1, copySpreadNights: 1, ageSpreadDays: 1 } } };
    const { second } = await afterFirstNight(opts);
    const night = await h.pack(2, { ...second, ...opts.pack });
    expect(night.out.coins["coin-a"].status).toBe("packed");
    expect(night.out.coins["coin-a"].stats.blobs.carried).toBe(0);
    expect(night.out.coins["coin-a"].stats.blobs.written).toBeGreaterThan(0);
  });
});

describe("end step: tables", () => {
  it("a second publish of the same day appends a part and restores to the newest file", async () => {
    const { second } = await afterFirstNight();
    const mid = await h.pack(2, { ...second, runId: 201, day: DAYS[0] });
    expect(mid.out.coins["coin-a"]).toMatchObject({ status: "packed" });
    expect(mid.out.coins["coin-a"].stats.tables.acct.changeRows).toBeGreaterThan(0);
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: mid.out.candidates });
    const third = await h.start(3);
    expect(asHex(snapshot(third.outDir, "coin-a"))).toEqual(asHex(mid.after["coin-a"]));
  });

  it("holds the change rows of one bucket at a time: the peak is below the part's change rows", async () => {
    const { second } = await afterFirstNight({ harness: {} });
    const held = [];
    const night = await h.pack(2, { ...second, trace: (t) => held.push(t.held) });
    const total = night.out.coins["coin-a"].stats.tables.acct.changeRows;
    expect(held.length).toBeGreaterThan(1);
    expect(held.reduce((a, b) => a + b, 0)).toBe(total);
    expect(Math.max(...held)).toBeLessThan(total);
  });

  it("refuses a day before the newest indexed day", async () => {
    const { second } = await afterFirstNight();
    const bad = await h.pack(2, { ...second, runId: 300, day: "2026-11-10" });
    expect(bad.out.coins["coin-a"]).toMatchObject({ status: "failed", stage: "pack", error: "PackStepError" });
    expect(bad.out.coins["coin-a"].message).toContain("past day");
  });

  it("refuses a table file with a repeated key or an all-zero row, naming the table", async () => {
    const { second } = await afterFirstNight();
    const file = path.join(second.outDir, tablePath("coin-a"));
    const header = { asOf: "x" };
    for (const [rows, text] of [[[["0xaa", "1", "0"], ["0xaa", "2", "0"]], "appears twice"], [[["0xaa", "0", "0"]], "all-zero"]]) {
      fs.writeFileSync(file, JSON.stringify({ header, rows }));
      const night = await h.pack(2, { ...second, generate: false, runId: 400 + rows.length });
      expect(night.out.coins["coin-a"]).toMatchObject({ status: "failed", error: "TableFormatError" });
      expect(night.out.coins["coin-a"].message).toContain(text);
    }
    expect(jsonTable).toBeDefined();
  });

  it("a key that leaves the file is a removal and a changed value a change", async () => {
    const { second } = await afterFirstNight();
    const file = path.join(second.outDir, tablePath("coin-a"));
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const removed = doc.rows.shift();
    doc.rows[0][1] = "999999";
    fs.writeFileSync(file, JSON.stringify(doc));
    const night = await h.pack(2, { ...second, generate: false });
    expect(night.out.coins["coin-a"].stats.tables.acct.changeRows).toBe(2);
    await publishCandidates({ blobs: h.env.blobs, state: h.state, files: night.out.candidates });
    const third = await h.start(3);
    const back = JSON.parse(fs.readFileSync(path.join(third.outDir, tablePath("coin-a")), "utf8"));
    expect(back.rows.some((r) => r[0] === removed[0])).toBe(false);
    expect(back.rows.find((r) => r[0] === doc.rows[0][0])[1]).toBe("999999");
  });
});
