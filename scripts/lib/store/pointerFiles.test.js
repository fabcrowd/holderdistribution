import { describe, expect, it } from "vitest";
import {
  emptyStoreFile, parseStoreFile, serializeStoreFile, mergeStoreFiles, parseSiteFile, serializeSiteFile, buildSiteFile, siteRootLoc,
} from "./pointerFiles.js";
import { RecordSyntaxError, RecordSchemaError, RecordShapeError } from "./errors.js";
import { sha } from "./recordKit.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const store = (releases) => ({ schema: 1, releases });

describe("store.json", () => {
  it("round-trips with stable bytes and a trailing newline", () => {
    const f = store({ site: "data-site-1", keep: "data-keep-2", live: "data-live-12" });
    const text = serializeStoreFile(f);
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseStoreFile(text)).toEqual(f);
    expect(serializeStoreFile(parseStoreFile(text))).toBe(text);
    expect(serializeStoreFile(store({ live: "data-live-12", keep: "data-keep-2", site: "data-site-1" }))).toBe(text);
    expect(parseStoreFile(serializeStoreFile(emptyStoreFile()))).toEqual(emptyStoreFile());
  });

  it("the maximum rule: per series the higher sequence number, and a series one side lacks is kept", () => {
    const main = store({ keep: "data-keep-2", live: "data-live-9", events: "data-events-1" });
    const run = store({ keep: "data-keep-1", live: "data-live-10", hist: "data-hist-3" });
    expect(mergeStoreFiles(main, run)).toEqual(store({ keep: "data-keep-2", live: "data-live-10", events: "data-events-1", hist: "data-hist-3" }));
    expect(mergeStoreFiles(run, main)).toEqual(mergeStoreFiles(main, run));
    expect(mergeStoreFiles(main, main)).toEqual(main);
    expect(mergeStoreFiles(emptyStoreFile(), main)).toEqual(main);
  });

  it("numbers compare as numbers, not as text", () => {
    expect(mergeStoreFiles(store({ live: "data-live-9" }), store({ live: "data-live-10" })).releases.live).toBe("data-live-10");
  });

  it("does not mutate its arguments", () => {
    const a = store({ live: "data-live-9" });
    const b = store({ live: "data-live-10" });
    const f = JSON.stringify([a, b]);
    mergeStoreFiles(a, b);
    expect(JSON.stringify([a, b])).toBe(f);
  });

  it("names the failure: not JSON, another schema, an unknown series, a tag of another series, an extra field", () => {
    expect(() => parseStoreFile("nope")).toThrow(RecordSyntaxError);
    expect(() => parseStoreFile(JSON.stringify({ schema: 2, releases: {} }))).toThrow(RecordSchemaError);
    expect(() => parseStoreFile(JSON.stringify(store({ cold: "data-cold-1" })))).toThrow(RecordShapeError);
    expect(() => parseStoreFile(JSON.stringify(store({ live: "data-hist-1" })))).toThrow(RecordShapeError);
    expect(() => parseStoreFile(JSON.stringify(store({ live: "data-live-0" })))).toThrow(RecordShapeError);
    expect(() => parseStoreFile(JSON.stringify({ ...store({}), extra: 1 }))).toThrow(RecordShapeError);
    expect(() => parseStoreFile(JSON.stringify({ schema: 1 }))).toThrow(RecordShapeError);
    expect(() => parseStoreFile("[]")).toThrow(RecordShapeError);
  });
});

describe("site.json", () => {
  const root = { name: "site.2026-11-18.r5a1p1.json", release: "data-site-1", size: 1234, sha256: sha("root"), parent: "site.2026-11-17.r4a1p1.json" };

  it("round-trips with stable bytes, and the root may be absent", () => {
    const f = buildSiteFile(root);
    const text = serializeSiteFile(f);
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseSiteFile(text)).toEqual(f);
    expect(serializeSiteFile(parseSiteFile(text))).toBe(text);
    expect(parseSiteFile(serializeSiteFile({ schema: 1, root: null })).root).toBeNull();
    expect(parseSiteFile(serializeSiteFile(buildSiteFile({ ...root, parent: null }))).root.parent).toBeNull();
    expect(siteRootLoc(f.root)).toBe("data-site-1/site.2026-11-18.r5a1p1.json");
  });

  it("names the failure", () => {
    const bad = (fn) => { const f = clone(buildSiteFile(root)); fn(f); return JSON.stringify(f); };
    expect(() => parseSiteFile("{")).toThrow(RecordSyntaxError);
    expect(() => parseSiteFile(bad((f) => { f.schema = 3; }))).toThrow(RecordSchemaError);
    expect(() => parseSiteFile(bad((f) => { f.root.name = "x.json"; }))).toThrow(RecordShapeError);
    expect(() => parseSiteFile(bad((f) => { f.root.release = "data-live-1"; }))).toThrow(RecordShapeError);
    expect(() => parseSiteFile(bad((f) => { f.root.size = "1"; }))).toThrow(RecordShapeError);
    expect(() => parseSiteFile(bad((f) => { f.root.sha256 = "ab"; }))).toThrow(RecordShapeError);
    expect(() => parseSiteFile(bad((f) => { delete f.root.parent; }))).toThrow(RecordShapeError);
    expect(() => parseSiteFile(bad((f) => { f.root.extra = 1; }))).toThrow(RecordShapeError);
  });
});
