import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CANDIDATE_SCHEMA, buildCandidate, serializeCandidate, parseCandidate, pickHighestAttempt } from "./candidate.js";
import { RecordSyntaxError, RecordSchemaError, RecordShapeError, CandidateError } from "./errors.js";
import { runOf, sha, folderEnv, writeCoin } from "./recordKit.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
let env;
let one;
let two;
let one2; // the same coin written by attempt 2 of the run
beforeAll(async () => {
  env = folderEnv();
  one = await writeCoin({ env, slug: "alpha", run: runOf(7, 1) });
  one2 = await writeCoin({ env, slug: "alpha", run: runOf(7, 2) });
  two = await writeCoin({ env, slug: "beta", run: runOf(7, 1) });
});
afterAll(() => env.cleanup());

const coin = (w, files = { "data/x/a.json": sha("a") }) => ({ chain: [w.entry], files });
const make = (attempt, coins) => buildCandidate({ kind: "holders", run: runOf(7, attempt), coins });

describe("candidate artifact", () => {
  it("round-trips with stable bytes", () => {
    const c = make(1, { alpha: coin(one), beta: coin(two, { "b.json": sha("b"), "a.json": sha("a") }) });
    const text = serializeCandidate(c);
    expect(parseCandidate(text)).toEqual(c);
    expect(serializeCandidate(parseCandidate(text))).toBe(text);
    expect(serializeCandidate(make(1, { beta: coin(two, { "a.json": sha("a"), "b.json": sha("b") }), alpha: coin(one) }))).toBe(text);
    expect(c.schema).toBe(CANDIDATE_SCHEMA);
  });

  describe("adversarial input", () => {
    const good = () => clone(make(1, { alpha: coin(one) }));
    it("not JSON, another schema", () => {
      expect(() => parseCandidate("nope")).toThrow(RecordSyntaxError);
      expect(() => parseCandidate(JSON.stringify({ ...good(), schema: 2 }))).toThrow(RecordSchemaError);
      expect(() => parseCandidate(JSON.stringify({ kind: "holders" }))).toThrow(RecordSchemaError);
    });
    const shape = [
      ["a missing kind", (c) => { delete c.kind; }],
      ["an unknown kind", (c) => { c.kind = "nightly"; }],
      ["a missing run", (c) => { delete c.run; }],
      ["coins that is an array", (c) => { c.coins = []; }],
      ["a coin with an empty chain", (c) => { c.coins.alpha.chain = []; }],
      ["a coin without files", (c) => { delete c.coins.alpha.files; }],
      ["a file hash that is not sha256", (c) => { c.coins.alpha.files["data/x/a.json"] = "abc"; }],
      ["an extra field on a coin", (c) => { c.coins.alpha.note = 1; }],
      ["an extra top-level field", (c) => { c.note = 1; }],
      ["a chain entry of another kind", (c) => { c.kind = "ledger"; }],
      ["a chain entry with a publishedAt", (c) => { c.coins.alpha.chain[0].publishedAt = "2026-11-18T03:12:40Z"; }],
      ["a last chain entry of another run", (c) => { c.run.id = 8; }],
    ];
    it.each(shape)("%s is a shape error", (_, fn) => {
      const c = good();
      fn(c);
      expect(() => parseCandidate(JSON.stringify(c))).toThrow(RecordShapeError);
      try { parseCandidate(JSON.stringify(c)); } catch (e) { expect(e.message).toMatch(/candidate|holders/); }
    });
  });

  describe("per coin, the highest attempt", () => {
    it("keeps each coin's candidate of the highest attempt, and reports it", () => {
      const a1 = make(1, { alpha: coin(one), beta: coin(two) });
      const a2 = make(2, { alpha: coin(one2) });
      const picked = pickHighestAttempt([a1, a2], "holders");
      expect(picked.conflicts).toEqual([]);
      expect(picked.coins.alpha.attempt).toBe(2);
      expect(picked.coins.beta.attempt).toBe(1);
      expect(Object.keys(picked.coins).sort()).toEqual(["alpha", "beta"]);
      expect(pickHighestAttempt([a2, a1], "holders")).toEqual(picked); // order of artifacts does not matter
    });

    it("an identical coin in two artifacts of one attempt is one coin; different content is a conflict that drops the coin only", () => {
      const a = make(1, { alpha: coin(one), beta: coin(two) });
      const same = make(1, { alpha: coin(one) });
      expect(pickHighestAttempt([a, same], "holders").conflicts).toEqual([]);
      const other = make(1, { alpha: coin(one, { "z.json": sha("z") }) });
      const picked = pickHighestAttempt([a, other], "holders");
      expect(picked.conflicts).toHaveLength(1);
      expect(picked.conflicts[0].slug).toBe("alpha");
      expect(picked.coins.alpha).toBeUndefined();
      expect(picked.coins.beta).toBeDefined();
    });

    it("refuses artifacts of another kind or of another run id (a mixed download is a bug, not an outcome)", () => {
      const a = make(1, { alpha: coin(one) });
      expect(() => pickHighestAttempt([a], "ledger")).toThrow(CandidateError);
      const b = clone(a);
      b.run.id = 8;
      b.coins.alpha.chain[0].run.id = 8;
      expect(() => pickHighestAttempt([a, b], "holders")).toThrow(CandidateError);
    });

    it("does not mutate its input and gives no coins from no artifacts", () => {
      const a = make(2, { alpha: coin(one2) });
      const f = JSON.stringify(a);
      pickHighestAttempt([a], "holders");
      expect(JSON.stringify(a)).toBe(f);
      expect(pickHighestAttempt([], "holders")).toEqual({ coins: {}, conflicts: [] });
    });

    it("review M5: validates each artifact itself (a bad coin key or a chain that is not a list throws)", () => {
      const run = { id: 1, attempt: 1, workflow: "w.yml" };
      expect(() => pickHighestAttempt([{ schema: 1, kind: "holders", run, coins: { "../x": { chain: "nope", files: {} } } }], "holders")).toThrow(RecordShapeError);
      expect(() => pickHighestAttempt([{ schema: 2, kind: "holders", run, coins: {} }], "holders")).toThrow(RecordSchemaError);
      expect(() => pickHighestAttempt([{ schema: 1, kind: "holders", run, coins: { alpha: { chain: [], files: {} } } }], "holders")).toThrow(RecordShapeError);
    });

    it("a coin the top attempt does not carry is taken from the highest lower attempt that does", () => {
      const picked = pickHighestAttempt([make(1, { alpha: coin(one), beta: coin(two) }), make(2, { alpha: coin(one2) })], "holders");
      expect(picked.coins.beta.attempt).toBe(1);
    });
  });

  it("review M1: __proto__, constructor and prototype are refused as coin keys and file paths", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const c = clone(make(1, { alpha: coin(one) }));
      c.coins = JSON.parse(`{"${key}": ${JSON.stringify(c.coins.alpha)}}`);
      expect(() => parseCandidate(JSON.stringify(c))).toThrow(RecordShapeError);
      const f = clone(make(1, { alpha: coin(one) }));
      f.coins.alpha.files = JSON.parse(`{"${key}": "${sha("x")}"}`);
      expect(() => parseCandidate(JSON.stringify(f))).toThrow(RecordShapeError);
    }
  });
});
