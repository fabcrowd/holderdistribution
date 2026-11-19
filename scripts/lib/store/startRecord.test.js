import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecordSchemaError, RecordShapeError, RecordSyntaxError } from "./errors.js";
import { entryKey, published } from "./manifest.js";
import { packName } from "./packNames.js";
import { ADOPTION_WINDOW_DAYS } from "./storeConstants.js";
import {
  START_SCHEMA, buildStartRecord, parseStartRecord, readStartRecord, serializeStartRecord, validateStartRecord, writeStartRecord,
} from "./startRecord.js";

const AT = "2026-11-18T03:12:40Z";
const h = (c) => c.repeat(64);
const day = (n) => `2026-11-${String(n).padStart(2, "0")}`;
const usageOf = (n) => ({ day: day(n), month: "2026-11", run: { providerA: n }, dayTotal: { providerA: n }, monthTotal: { providerA: n * 10 } });
const entry = (n, parent) => ({
  bundle: {
    ref: `${packName({ cls: "live", kind: "holders", day: day(n), run: n, attempt: 1, lane: 0, flush: 0 })}#3`,
    release: "data-live-1", packSize: 1000 + n, headerSha256: h("a"), sha256: n.toString(16).padStart(64, "0"),
  },
  parent, day: day(n), run: { id: n, attempt: 1, workflow: "refresh-holders.yml" }, usage: usageOf(n),
});
const main = published(entry(10, null), AT);
const chainOf = (from, count) => {
  const out = [];
  for (let n = from; n < from + count; n++) out.push(entry(n, out.length ? entryKey(out.at(-1)) : entryKey(main)));
  return out;
};
const buckets = { acct: [{ bucket: 0, count: 5, hash: "00ff00ff00ff00ff" }, { bucket: 1, count: 7, hash: "0123456789abcdef" }], scan: [{ bucket: 0, count: 2, hash: "f".repeat(16) }] };
const make = (over = {}) => buildStartRecord({ slug: "example", kind: "holders", main, chain: chainOf(11, 2), buckets, ...over });

describe("buildStartRecord", () => {
  it("takes the parent from the main entry, the usage from the newest start, and keeps the chain", () => {
    const r = make();
    expect(r).toMatchObject({ schema: START_SCHEMA, slug: "example", kind: "holders", parent: entryKey(main) });
    expect(r.chain).toHaveLength(2);
    expect(r.usage).toEqual(usageOf(12));
    expect(r.buckets).toEqual(buckets);
  });

  it("with no chain the start is the main entry: its usage is the starting usage", () => {
    const r = make({ chain: [] });
    expect(r.parent).toBe(entryKey(main));
    expect(r.usage).toEqual(main.usage);
    expect(r.chain).toEqual([]);
  });

  it("a new coin (no main entry, no chain) has a null parent and null usage", () => {
    expect(make({ main: null, chain: [], buckets: {} })).toMatchObject({ parent: null, usage: null, chain: [], buckets: {} });
  });

  it("a new coin whose first run was adopted: null parent, the chain's first entry has a null parent", () => {
    const first = entry(11, null);
    const r = make({ main: null, chain: [first, entry(12, entryKey(first))] });
    expect(r.parent).toBeNull();
    expect(r.usage).toEqual(usageOf(12));
  });

  it("does not change its arguments, and its result shares nothing with them", () => {
    const args = { slug: "example", kind: "holders", main, chain: chainOf(11, 2), buckets: structuredClone(buckets) };
    const copy = structuredClone(args);
    const r = buildStartRecord(args);
    expect(args).toEqual(copy);
    r.chain[0].day = "2000-01-01";
    r.buckets.acct[0].count = 99;
    expect(args).toEqual(copy);
  });

  it("puts buckets in order and tables in key order, so equal facts give equal records", () => {
    const shuffled = { scan: buckets.scan, acct: [...buckets.acct].reverse() };
    expect(make({ buckets: shuffled })).toEqual(make());
  });

  it("refuses a duplicate bucket in the input instead of dropping one", () => {
    expect(() => make({ buckets: { acct: [buckets.acct[0], buckets.acct[0]] } })).toThrow(RecordShapeError);
  });
});

describe("serialization", () => {
  it("round-trips: parse(serialize(r)) equals r", () => {
    const r = make();
    expect(parseStartRecord(serializeStartRecord(r))).toEqual(r);
    expect(parseStartRecord(Buffer.from(serializeStartRecord(r)))).toEqual(r);
  });

  it("gives the same bytes for equal input, whatever the key order of the input", () => {
    const a = serializeStartRecord(make());
    const reordered = { buckets: make().buckets, chain: make().chain, kind: "holders", slug: "example", usage: make().usage, parent: make().parent, schema: 1 };
    expect(serializeStartRecord(reordered)).toBe(a);
    expect(serializeStartRecord(make())).toBe(a);
    expect(a.endsWith("}\n")).toBe(true);
  });

  it("serializes only a valid record", () => {
    expect(() => serializeStartRecord({ ...make(), slug: "Bad Slug" })).toThrow(RecordShapeError);
  });
});

describe("every refused shape is a named error that names the record", () => {
  const good = () => structuredClone(make());
  const refuse = (mutate, pattern, type = RecordShapeError, named = /start record example\/holders/) => {
    const r = good();
    mutate(r);
    expect(() => validateStartRecord(r)).toThrow(type);
    expect(() => validateStartRecord(r)).toThrow(pattern);
    expect(() => validateStartRecord(r)).toThrow(named);
  };

  it("not JSON, and another schema", () => {
    expect(() => parseStartRecord("{ nope")).toThrow(RecordSyntaxError);
    expect(() => parseStartRecord(JSON.stringify({ ...good(), schema: 2 }))).toThrow(RecordSchemaError);
    expect(() => parseStartRecord("[]")).toThrow(RecordShapeError);
  });
  it("missing and unknown fields", () => {
    for (const k of ["parent", "chain", "usage", "buckets"]) {
      refuse((r) => { delete r[k]; }, new RegExp(`missing "${k}"`));
    }
    for (const k of ["slug", "kind"]) {
      const r = good();
      delete r[k];
      expect(() => validateStartRecord(r)).toThrow(new RegExp(`start record.*missing "${k}"`));
    }
    refuse((r) => { r.extra = 1; }, /unknown field "extra"/);
  });
  it("slug, kind, parent", () => {
    refuse((r) => { r.slug = "../x"; }, /slug/, RecordShapeError, /start record/);
    refuse((r) => { r.kind = "Holders"; }, /kind/, RecordShapeError, /start record example/);
    refuse((r) => { r.parent = "data-live-1/not-a-pack#0@abc"; }, /parent/);
    refuse((r) => { r.parent = 5; }, /parent/);
  });
  it("chain: not a list, a published entry, an entry of another kind, a bad entry", () => {
    refuse((r) => { r.chain = {}; }, /chain/);
    refuse((r) => { r.chain[0] = published(r.chain[0], AT); }, /entry/);
    refuse((r) => { r.chain[0].bundle.ref = r.chain[0].bundle.ref.replace("holders", "ledger"); }, /ledger/);
    refuse((r) => { r.chain[0].day = "2026-02-31"; }, /day/);
  });
  it("chain: the first entry's parent is not the record's parent", () => {
    refuse((r) => { r.chain[0].parent = null; }, /chain\[0\]\.parent/);
    refuse((r) => { r.parent = null; }, /chain\[0\]\.parent/);
  });
  it("chain: a broken link", () => {
    refuse((r) => { r.chain[1].parent = r.parent; }, /chain\[1\]\.parent/);
  });
  it(`chain: more than ${ADOPTION_WINDOW_DAYS - 1} entries leaves no room for this run's own entry`, () => {
    const longer = chainOf(11, ADOPTION_WINDOW_DAYS);
    expect(() => buildStartRecord({ slug: "example", kind: "holders", main, chain: longer, buckets })).toThrow(/own entry/);
    expect(make({ chain: chainOf(11, ADOPTION_WINDOW_DAYS - 1) }).chain).toHaveLength(ADOPTION_WINDOW_DAYS - 1);
  });
  it("usage: null with a parent, set with none, or not the newest start's", () => {
    refuse((r) => { r.usage = null; }, /usage/);
    refuse((r) => { r.usage = usageOf(11); }, /usage .*newest/);
    const fresh = structuredClone(make({ main: null, chain: [], buckets: {} }));
    fresh.usage = usageOf(1);
    expect(() => validateStartRecord(fresh)).toThrow(/usage/);
    const odd = good();
    odd.usage = { ...odd.usage, month: "2026-10" };
    expect(() => validateStartRecord(odd)).toThrow(/usage/);
  });
  it("buckets: not an object, rows not a list, a bad row", () => {
    refuse((r) => { r.buckets = []; }, /buckets/);
    refuse((r) => { r.buckets.acct = {}; }, /buckets\.acct/);
    refuse((r) => { r.buckets.acct[0].bucket = -1; }, /bucket/);
    refuse((r) => { r.buckets.acct[0].count = 1.5; }, /count/);
    refuse((r) => { r.buckets.acct[0].hash = "ABCDEF0123456789"; }, /hash/);
    refuse((r) => { r.buckets.acct[0].hash = "abc"; }, /hash/);
    refuse((r) => { r.buckets.acct[0].hash = 12; }, /hash/);
    refuse((r) => { r.buckets.acct[0].extra = 1; }, /extra/);
    refuse((r) => { delete r.buckets.acct[0].count; }, /count/);
  });
  it("buckets: out of order or repeated bucket numbers", () => {
    refuse((r) => { r.buckets.acct.reverse(); }, /out of order|increasing/);
    refuse((r) => { r.buckets.acct[1].bucket = 0; }, /increasing/);
  });
  it("buckets: a table named __proto__ is refused, not stored", () => {
    const text = JSON.stringify(good()).replace('"buckets":{', '"buckets":{"__proto__":[],');
    expect(() => parseStartRecord(text)).toThrow(/__proto__/);
  });
});

describe("writing to a directory", () => {
  const made = [];
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "start-record-"));
    made.push(d);
    return d;
  };

  it("writes <dir>/<slug>/start.json with the serialized bytes and reads it back", async () => {
    const dir = tmp();
    const r = make();
    const file = await writeStartRecord(dir, r);
    expect(file).toBe(path.join(dir, "example", "start.json"));
    expect(fs.readFileSync(file, "utf8")).toBe(serializeStartRecord(r));
    expect(await readStartRecord(dir, "example")).toEqual(r);
  });

  it("replaces an earlier record and leaves no temporary file", async () => {
    const dir = tmp();
    await writeStartRecord(dir, make());
    const second = make({ chain: [] });
    await writeStartRecord(dir, second);
    expect(await readStartRecord(dir, "example")).toEqual(second);
    expect(fs.readdirSync(path.join(dir, "example"))).toEqual(["start.json"]);
  });

  it("refuses an invalid record before it touches the disk", async () => {
    const dir = tmp();
    await expect(writeStartRecord(dir, { ...make(), slug: "../up" })).rejects.toThrow(RecordShapeError);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("reading a missing or damaged record is an error, never an empty record", async () => {
    const dir = tmp();
    await expect(readStartRecord(dir, "example")).rejects.toThrow(/ENOENT/);
    fs.mkdirSync(path.join(dir, "example"));
    fs.writeFileSync(path.join(dir, "example", "start.json"), "{");
    await expect(readStartRecord(dir, "example")).rejects.toThrow(RecordSyntaxError);
    await expect(readStartRecord(dir, "../x")).rejects.toThrow(RecordShapeError);
  });
});
