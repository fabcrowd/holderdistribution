import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MANIFEST_SCHEMA, emptyManifest, parseManifest, serializeManifest, entryFor, withEntry, published, entryKey, validateEntry,
} from "./manifest.js";
import { RecordSyntaxError, RecordSchemaError, RecordShapeError } from "./errors.js";
import { SLUG, runOf, folderEnv, writeCoin } from "./recordKit.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const AT = "2026-11-18T03:12:40Z";

let env;
let first;
let second;
beforeAll(async () => {
  env = folderEnv();
  first = await writeCoin({ env });
  second = await writeCoin({ env, kind: "ledger", run: runOf(2, 1), day: "2026-11-18" });
});
afterAll(() => env.cleanup());

const manifest = () => withEntry(withEntry(emptyManifest(SLUG), "holders", published(first.entry, AT)), "ledger", published(second.entry, AT));

describe("coin manifest", () => {
  it("round-trips with stable bytes, a trailing newline and sorted keys", () => {
    const m = manifest();
    const text = serializeManifest(m);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(parseManifest(text, { slug: SLUG })).toEqual(m);
    expect(serializeManifest(parseManifest(text, { slug: SLUG }))).toBe(text);
    const built = withEntry(withEntry(emptyManifest(SLUG), "ledger", published(second.entry, AT)), "holders", published(first.entry, AT));
    expect(serializeManifest(built)).toBe(text); // insertion order does not matter
    expect(Object.keys(JSON.parse(text))).toEqual([...Object.keys(JSON.parse(text))].sort());
    expect(m.schema).toBe(MANIFEST_SCHEMA);
  });

  it("an empty manifest is valid and has no entries", () => {
    const m = parseManifest(serializeManifest(emptyManifest(SLUG)), { slug: SLUG });
    expect(entryFor(m, "holders")).toBeNull();
  });

  it("entryFor gives the entry of a kind, null for a kind without one, and refuses an unknown kind", () => {
    const m = manifest();
    expect(entryFor(m, "holders")).toEqual(published(first.entry, AT));
    expect(entryFor(m, "walletFlows")).toBeNull();
    expect(() => entryFor(m, "nightly")).toThrow(RecordShapeError);
  });

  it("withEntry returns a new object and mutates nothing", () => {
    const base = emptyManifest(SLUG);
    const frozen = JSON.stringify(base);
    const a = withEntry(base, "holders", published(first.entry, AT));
    expect(JSON.stringify(base)).toBe(frozen);
    expect(a).not.toBe(base);
    const entry = published(first.entry, AT);
    const b = withEntry(a, "holders", { ...entry, day: "2026-11-19", publishedAt: "2026-11-19T03:00:00Z" });
    expect(entryFor(a, "holders").day).toBe("2026-11-18");
    expect(entryFor(b, "holders").day).toBe("2026-11-19");
    expect(() => withEntry(a, "holders", { ...entry, extra: 1 })).toThrow(RecordShapeError);
  });

  it("an entry's key is its bundle's full key, which a child's parent carries", () => {
    const e = entryFor(manifest(), "holders");
    expect(entryKey(e)).toBe(`${e.bundle.release}/${e.bundle.ref}@${e.bundle.sha256}`);
  });

  describe("unreadable input is a named error that names the coin", () => {
    it("not JSON", () => {
      expect(() => parseManifest("", { slug: SLUG })).toThrow(RecordSyntaxError);
      expect(() => parseManifest("{\"schema\": 1,", { slug: SLUG })).toThrow(/example/);
      expect(() => parseManifest("<<<<<<< HEAD\n{}", { slug: SLUG })).toThrow(RecordSyntaxError);
    });
    it("another schema", () => {
      const m = clone(manifest());
      expect(() => parseManifest(JSON.stringify({ ...m, schema: 2 }), { slug: SLUG })).toThrow(RecordSchemaError);
      const { schema, ...rest } = m;
      expect(() => parseManifest(JSON.stringify(rest), { slug: SLUG })).toThrow(RecordSchemaError);
    });
    const shape = [
      ["another slug in the file", (m) => { m.slug = "other"; }],
      ["a missing entries", (m) => { delete m.entries; }],
      ["an unknown kind", (m) => { m.entries.nightly = m.entries.holders; }],
      ["an entry without a bundle", (m) => { delete m.entries.holders.bundle; }],
      ["an entry without usage", (m) => { delete m.entries.holders.usage; }],
      ["an entry without publishedAt", (m) => { delete m.entries.holders.publishedAt; }],
      ["a publishedAt that is not a UTC time", (m) => { m.entries.holders.publishedAt = "yesterday"; }],
      ["an entry day that is not a day", (m) => { m.entries.holders.day = "18-11-2026"; }],
      ["a bundle location of the wrong type", (m) => { m.entries.holders.bundle.release = 7; }],
      ["a bundle release of another series", (m) => { m.entries.holders.bundle.release = "data-hist-1"; }],
      ["a bundle ref that is not a ref", (m) => { m.entries.holders.bundle.ref = "x"; }],
      ["a bundle in a pack of another kind", (m) => { m.entries.ledger.bundle = m.entries.holders.bundle; }],
      ["a bundle sha256 that is short", (m) => { m.entries.holders.bundle.sha256 = "ab"; }],
      ["a parent in the old <pack name>#<slug> form", (m) => { m.entries.holders.parent = "p.live.holders.2026-11-17.r1a1.l0f0.hdb#example"; }],
      ["a __proto__ provider key in usage", (m) => { m.entries.holders.usage.dayTotal = JSON.parse('{"__proto__": 5}'); }],
      ["a wrong-case kind", (m) => { m.entries.Holders = m.entries.holders; delete m.entries.holders; }],
      ["an extra field in an entry", (m) => { m.entries.holders.note = "x"; }],
      ["an extra field in the manifest", (m) => { m.note = "x"; }],
      ["an extra field in usage", (m) => { m.entries.holders.usage.extra = 1; }],
      ["an entries that is an array", (m) => { m.entries = []; }],
    ];
    it.each(shape)("%s", (_, fn) => {
      const m = clone(manifest());
      fn(m);
      expect(() => parseManifest(JSON.stringify(m), { slug: SLUG })).toThrow(RecordShapeError);
      try { parseManifest(JSON.stringify(m), { slug: SLUG }); } catch (e) { expect(e.message).toMatch(/example/); }
    });
  });

  it("validateEntry takes an unpublished entry only when told it is a candidate entry", () => {
    expect(() => validateEntry(first.entry, { slug: SLUG, kind: "holders" })).toThrow(RecordShapeError);
    expect(() => validateEntry(first.entry, { slug: SLUG, kind: "holders", published: false })).not.toThrow();
    expect(() => validateEntry(published(first.entry, AT), { slug: SLUG, kind: "holders", published: false })).toThrow(RecordShapeError);
  });
});
