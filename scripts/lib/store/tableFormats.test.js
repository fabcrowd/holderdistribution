import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bucketCount, bucketOf } from "./buckets.js";
import { stableStringify } from "./stable.js";
import { EVER_SET_FIELDS, TableShapeError, everSetFormat, makeEverSetFormat } from "./tableFormats.js";

// The ever-held list (holders-ever-checkpoint.json) as a table format. Fixtures are real excerpts of the
// committed files of three coin kinds (public chain addresses, 37 of each, header as in the file).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = ["ever-evm", "ever-solana", "ever-hbar"];
const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tblfmt-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const put = (text) => {
  const file = path.join(tmp(), "in.json");
  fs.writeFileSync(file, text);
  return file;
};
const fixture = (name) => path.join(HERE, "fixtures", `${name}.json`);
const collect = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

// The rows of a file spread over the buckets of `layout`, as restore hands them to write (increasing bucket
// order, rows of a bucket in reverse key order so nothing leans on the file order).
function bucketed(rows, layout) {
  const by = new Map();
  for (const [k, v] of rows) {
    const b = bucketOf(k, layout);
    if (!by.has(b)) by.set(b, new Map());
    by.get(b).set(k, v);
  }
  return [...by.keys()].sort((a, b) => a - b).map((bucket) => ({ bucket, rows: new Map([...by.get(bucket)].reverse()) }));
}
async function* gen(list) {
  for (const x of list) yield x;
}
// The bundle keeps a header with its keys sorted at every depth (stable.js); restore hands write that copy.
const viaBundle = (header) => JSON.parse(stableStringify(header));
async function roundTrip(file, { layout, format = everSetFormat }) {
  const header = viaBundle(await format.readHeader(file));
  const rows = await collect(format.readRows(file));
  const out = path.join(tmp(), "out.json");
  await format.write(out, header, gen(bucketed(rows, layout)));
  return { header, rows, bytes: fs.readFileSync(out), runsLeft: fs.readdirSync(path.dirname(out)).filter((n) => n !== "out.json") };
}

describe("everSetFormat on real excerpts", () => {
  for (const name of FIXTURES) {
    it(`${name}: file -> header + rows -> file is byte-equal over 1, 4 and 6 buckets`, async () => {
      const file = fixture(name);
      const original = fs.readFileSync(file);
      for (const layout of [{ L: 0, p: 0 }, { L: 2, p: 0 }, { L: 2, p: 2 }]) {
        const r = await roundTrip(file, { layout });
        expect(Buffer.compare(r.bytes, original), `${name} ${JSON.stringify(layout)}`).toBe(0);
        expect(r.runsLeft).toEqual([]);
        expect(r.rows).toHaveLength(37);
        expect(r.rows.every(([k, v]) => typeof k === "string" && v.length === EVER_SET_FIELDS && v[0] === 1n)).toBe(true);
        expect(Object.keys(r.header)).toEqual(["prefix"]);
        expect(JSON.parse(`${r.header.prefix}]}`).cumulativeHolders).toBeGreaterThan(37);
      }
    });
  }

  it("the hedera excerpt is in string order, not numeric order (0.0.10311544 before 0.0.2)", async () => {
    const rows = await collect(everSetFormat.readRows(fixture("ever-hbar")));
    const keys = rows.map(([k]) => k);
    expect(keys).toEqual([...keys].sort());
    expect(keys.indexOf("0.0.10311544")).toBeLessThan(keys.findIndex((k) => /^0\.0\.2\d*$/.test(k)));
  });

  it("merges in several passes when there are more buckets than the fan-in, with the same bytes", async () => {
    const file = fixture("ever-evm");
    const r = await roundTrip(file, { layout: { L: 3, p: 3 }, format: makeEverSetFormat({ fanIn: 2 }) });
    expect(bucketCount({ L: 3, p: 3 })).toBe(11);
    expect(Buffer.compare(r.bytes, fs.readFileSync(file))).toBe(0);
    expect(r.runsLeft).toEqual([]);
  });
});

describe("everSetFormat shapes", () => {
  const head = '{"generatedAt":"2026-11-22","cumulativeHolders":3,"addresses":[';
  it("an empty list round-trips", async () => {
    const text = '{"generatedAt":"2026-11-22","cumulativeHolders":0,"addresses":[]}';
    const r = await roundTrip(put(text), { layout: { L: 0, p: 0 } });
    expect(r.rows).toEqual([]);
    expect(r.bytes.toString()).toBe(text);
  });
  it("keeps the other header fields in file order although the bundle sorts keys (cumulativeHolders after generatedAt, note's b before a)", async () => {
    const text = '{"generatedAt":"2026-11-22","note":{"b":1,"a":[1,2]},"cumulativeHolders":2,"addresses":["a","b"]}';
    const r = await roundTrip(put(text), { layout: { L: 1, p: 0 } });
    expect(r.header).toEqual({ prefix: text.slice(0, text.indexOf('"a","b"')) });
    expect(r.bytes.toString()).toBe(text);
  });
  it("reads across read-chunk boundaries (tiny chunks) to the same rows", async () => {
    const file = fixture("ever-solana");
    const small = makeEverSetFormat({ chunkBytes: 7 });
    expect(await collect(small.readRows(file))).toEqual(await collect(everSetFormat.readRows(file)));
  });

  const refuse = {
    "keys out of order": `${head}"b","a","c"]}`,
    "a duplicate key": `${head}"a","a","c"]}`,
    "a trailing newline": `${head}"a","b","c"]}\n`,
    "addresses not the last field": '{"addresses":["a"],"generatedAt":"2026-11-22"}',
    "no addresses field": '{"generatedAt":"2026-11-22"}',
    "pretty-printed json": `{\n  "generatedAt": "2026-11-22",\n  "addresses": [\n "a"\n ]\n}`,
    "an escaped key": `${head}"a\\u0062","c"]}`,
    "a truncated file": `${head}"a","b"`,
    "text after the list": `${head}"a","b"]} `,
    "a mixed-case hex key": `${head}"0xAbCd"]}`,
    "an empty key": `${head}""]}`,
  };
  for (const [what, text] of Object.entries(refuse)) {
    it(`refuses ${what} (the file could not be rebuilt byte for byte)`, async () => {
      const file = put(text);
      await expect(async () => {
        await everSetFormat.readHeader(file);
        await collect(everSetFormat.readRows(file));
      }).rejects.toBeInstanceOf(TableShapeError);
    });
  }

  it("write refuses a row that is not [1n] and leaves no run files behind", async () => {
    const dir = tmp();
    const out = path.join(dir, "out.json");
    const bad = gen([{ bucket: 0, rows: new Map([["a", [2n]]]) }]);
    await expect(everSetFormat.write(out, { prefix: head }, bad)).rejects.toBeInstanceOf(TableShapeError);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it("write refuses buckets out of order, keys that cannot be written back and a header that is not { prefix }", async () => {
    const out = path.join(tmp(), "out.json");
    const rows = (k) => new Map([[k, [1n]]]);
    const header = { prefix: head };
    await expect(everSetFormat.write(out, header, gen([{ bucket: 2, rows: rows("a") }, { bucket: 1, rows: rows("b") }]))).rejects.toBeInstanceOf(TableShapeError);
    await expect(everSetFormat.write(out, header, gen([{ bucket: 0, rows: rows("0xABCD") }]))).rejects.toBeInstanceOf(TableShapeError);
    await expect(everSetFormat.write(out, header, gen([{ bucket: 0, rows: rows('q"x') }]))).rejects.toBeInstanceOf(TableShapeError);
    for (const bad of [{}, { generatedAt: "d" }, { prefix: "{" }, { prefix: `${head}"a"` }, { prefix: head, extra: 1 }]) {
      await expect(everSetFormat.write(out, bad, gen([]))).rejects.toBeInstanceOf(TableShapeError);
    }
  });
});

describe("everSetFormat write safety and key length", () => {
  const head = '{"generatedAt":"d","cumulativeHolders":1,"addresses":[';
  const one = () => gen([{ bucket: 0, rows: new Map([["a", [1n]]]) }]);
  const dupe = () => gen([{ bucket: 0, rows: new Map([["a", [1n]]]) }, { bucket: 1, rows: new Map([["a", [1n]]]) }]);

  it("a refused write leaves an existing target untouched and no tmp or runs files", async () => {
    const dir = tmp();
    const out = path.join(dir, "out.json");
    fs.writeFileSync(out, "KEEP");
    await expect(everSetFormat.write(out, { prefix: head }, dupe())).rejects.toBeInstanceOf(TableShapeError);
    expect(fs.readFileSync(out, "utf8")).toBe("KEEP");
    expect(fs.readdirSync(dir)).toEqual(["out.json"]);
  });
  it("a good write replaces the target through a tmp file and leaves nothing else", async () => {
    const dir = tmp();
    const out = path.join(dir, "out.json");
    fs.writeFileSync(out, "OLD");
    await everSetFormat.write(out, { prefix: head }, one());
    expect(fs.readFileSync(out, "utf8")).toBe(`${head}"a"]}`);
    expect(fs.readdirSync(dir)).toEqual(["out.json"]);
  });
  it("never removes a directory that already has the old runs name", async () => {
    const dir = tmp();
    const out = path.join(dir, "out.json");
    fs.mkdirSync(`${out}.runs`);
    fs.writeFileSync(path.join(`${out}.runs`, "precious"), "x");
    await everSetFormat.write(out, { prefix: head }, one());
    expect(fs.readFileSync(path.join(`${out}.runs`, "precious"), "utf8")).toBe("x");
  });
  it("refuses a key over 4096 characters in write and in read, also across the 1 MiB chunk boundary", async () => {
    const long = "b".repeat(5000);
    const out = path.join(tmp(), "out.json");
    await expect(everSetFormat.write(out, { prefix: head }, gen([{ bucket: 0, rows: new Map([[long, [1n]]]) }]))).rejects.toBeInstanceOf(TableShapeError);
    const small = [];
    let size = head.length;
    for (let i = 0; size < (1 << 20) - 2500; i++) {
      const k = `a${String(i).padStart(7, "0")}`;
      small.push(`"${k}"`);
      size += k.length + 3;
    }
    for (const body of [`"${long}"`, `${small.join(",")},"${long}"`]) {
      const file = put(`${head}${body}]}`);
      await expect(collect(everSetFormat.readRows(file))).rejects.toBeInstanceOf(TableShapeError);
    }
    const ok = put(`${head}${small.join(",")},"${"b".repeat(4096)}"]}`);
    expect(await collect(everSetFormat.readRows(ok))).toHaveLength(small.length + 1);
  });
});

// Streaming bound: a child process with a small heap limit (80 MB) reads 1.2 million keys (a 17 MB file) and
// rebuilds the file from 16 buckets of 75 thousand keys. Holding the file, or all keys, would not fit
// 80 MB of heap (a Map of the 1.2 million rows takes over 130 MB); one chunk or one bucket does.
describe("everSetFormat memory", () => {
  it("reads and writes a 1.2 million key file inside an 80 MB heap", () => {
    const dir = tmp();
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { everSetFormat } from ${JSON.stringify(path.join(HERE, "tableFormats.js").replaceAll("\\", "/").replace(/^([A-Za-z]):/, "file:///$1:"))};
      import { bucketOf } from ${JSON.stringify(path.join(HERE, "buckets.js").replaceAll("\\", "/").replace(/^([A-Za-z]):/, "file:///$1:"))};
      const dir = ${JSON.stringify(dir)};
      const N = 1_200_000;
      const keyOf = (i) => "0.0." + (10_000_000 + i);
      const file = path.join(dir, "big.json");
      const fd = fs.openSync(file, "w");
      fs.writeSync(fd, '{"generatedAt":"d","cumulativeHolders":' + N + ',"addresses":[');
      let part = [];
      for (let i = 0; i < N; i++) {
        part.push(JSON.stringify(keyOf(i)));
        if (part.length === 10_000) { fs.writeSync(fd, (i + 1 === part.length ? "" : ",") + part.join(",")); part = []; }
      }
      fs.writeSync(fd, "]}");
      fs.closeSync(fd);
      const header = await everSetFormat.readHeader(file);
      const layout = { L: 4, p: 0 };
      // spool the rows of each bucket to a file, as laneTables does, then hand the buckets over one at a time
      const spool = [...Array(16)].map((_, b) => path.join(dir, "b" + b));
      let n = 0;
      const pending = spool.map(() => []);
      const flush = () => pending.forEach((lines, b) => { if (lines.length) fs.appendFileSync(spool[b], lines.join("")); lines.length = 0; });
      for await (const [k] of everSetFormat.readRows(file)) {
        pending[bucketOf(k, layout)].push(k + "\\n");
        if (++n % 50_000 === 0) flush();
      }
      flush();
      async function* buckets() {
        for (let b = 0; b < 16; b++) {
          const rows = new Map(fs.readFileSync(spool[b], "utf8").split("\\n").filter(Boolean).map((k) => [k, [1n]]));
          yield { bucket: b, rows };
        }
      }
      const out = path.join(dir, "out.json");
      await everSetFormat.write(out, header, buckets());
      const same = fs.statSync(file).size === fs.statSync(out).size && fs.readFileSync(file).equals(fs.readFileSync(out));
      console.log(JSON.stringify({ n, same }));
    `;
    const res = spawnSync(process.execPath, ["--max-old-space-size=80", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 120_000 });
    expect(res.stderr.slice(0, 400)).toBe("");
    expect(JSON.parse(res.stdout.trim())).toEqual({ n: 1_200_000, same: true });
  }, 150_000);
});
