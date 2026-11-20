import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judgeChain } from "./chain.js";
import { bundleKey } from "./bundle.js";
import { emptyManifest, entryFor, entryKey, published, withEntry } from "./manifest.js";
import { packName } from "./packNames.js";
import { SLUG, runOf, folderEnv, writeCoin } from "./recordKit.js";

const AT = "2026-11-18T03:12:40Z";
const mainOf = (w) => published(w.entry, AT);
const key = (w) => bundleKey(w.bundleRef);

let env;
let n0;
let n1;
let n2;
let n1rival;
let ledger;
beforeAll(async () => {
  env = folderEnv();
  const next = (prev, day, id) => writeCoin({ env, day, run: runOf(id, 1), parent: prev ? key(prev) : null, parentUsage: prev ? prev.bundle.usage : null });
  n0 = await next(null, "2026-11-16", 10);
  n1 = await next(n0, "2026-11-17", 11);
  n2 = await next(n1, "2026-11-18", 12);
  n1rival = await next(n0, "2026-11-17", 13); // another run that also started from n0
  ledger = await writeCoin({ env, kind: "ledger", day: "2026-11-17", run: runOf(14, 1) });
});
afterAll(() => env.cleanup());

const judge = (main, ...ws) => judgeChain({ main: main ? mainOf(main) : null, chain: ws.map((w) => w.entry) });

// Entries made of plain fields, for cases a real pack cannot make (a second copy of a pack name).
const h = (c) => c.repeat(64);
const usage = { day: "2026-11-18", month: "2026-11", run: { a: 1 }, dayTotal: { a: 1 }, monthTotal: { a: 1 } };
const pack = (n) => packName({ cls: "live", kind: "holders", day: "2026-11-18", run: n, attempt: 1, lane: 0, flush: 0 });
const synth = (n, id, release, sha, parent) => ({
  bundle: { ref: `${pack(n)}#${id}`, release, packSize: 100, headerSha256: h("a"), sha256: sha },
  parent, day: "2026-11-18", run: runOf(n), usage,
});

describe("parent rule and chain acceptance (8.2, 9.2 step 3)", () => {
  it("a first publish: main has no entry and the chain's first parent is absent", () => {
    expect(judge(null, n0)).toEqual({ status: "accepted", entries: [n0.entry] });
  });

  it("main has no entry but the chain names a parent: stale", () => {
    expect(judge(null, n1)).toMatchObject({ status: "stale", reason: "parent mismatch", expected: null, got: key(n0) });
  });

  it("main has an entry and the chain's first parent is absent: stale", () => {
    expect(judge(n1, n0)).toMatchObject({ status: "stale", expected: key(n1), got: null });
  });

  it("the chain's first parent equals main's key: accepted with every entry", () => {
    expect(judge(n0, n1)).toEqual({ status: "accepted", entries: [n1.entry] });
  });

  it("(h) a publish that failed after upload, then the next night: a chain of two is accepted", () => {
    expect(judge(n0, n1, n2)).toEqual({ status: "accepted", entries: [n1.entry, n2.entry] });
  });

  it("drops chain entries up to the one equal to main, then checks the rest", () => {
    expect(judge(n1, n0, n1, n2)).toEqual({ status: "accepted", entries: [n2.entry] });
    expect(judge(n1, n1, n2)).toEqual({ status: "accepted", entries: [n2.entry] });
  });

  it("the whole chain already on main is superseded, not stale", () => {
    expect(judge(n2, n1, n2)).toEqual({ status: "superseded", reason: expect.stringMatching(/already/) });
    expect(judge(n1, n1)).toMatchObject({ status: "superseded" });
  });

  it("a stale candidate after another publish of the same kind", () => {
    expect(judge(n1rival, n1, n2)).toMatchObject({ status: "stale", expected: key(n1rival), got: key(n0) });
  });

  it("(i) a ledger publish does not make a holders candidate stale: each kind is checked against its own entry", () => {
    let manifest = withEntry(emptyManifest(SLUG), "holders", mainOf(n0));
    const chain = [n1.entry];
    manifest = withEntry(manifest, "ledger", published(ledger.entry, AT));
    expect(judgeChain({ main: entryFor(manifest, "holders"), chain })).toMatchObject({ status: "accepted" });
    manifest = withEntry(manifest, "holders", mainOf(n1rival));
    expect(judgeChain({ main: entryFor(manifest, "holders"), chain })).toMatchObject({ status: "stale" });
  });

  it("an empty chain is refused with a reason", () => {
    expect(judgeChain({ main: mainOf(n0), chain: [] })).toEqual({ status: "refused", reason: "empty chain" });
  });

  it("a chain whose later entry does not name the previous one is refused (an inconsistent lane, not a race)", () => {
    const r = judge(n0, n1, n1rival);
    expect(r.status).toBe("refused");
    expect(r.reason).toMatch(/chain broken at entry 1/);
  });

  it("never throws for an expected outcome and does not mutate its input", () => {
    const chain = [n1.entry, n2.entry];
    const frozen = JSON.stringify(chain);
    for (const main of [null, mainOf(n0), mainOf(n2), mainOf(n1rival)]) expect(() => judgeChain({ main, chain })).not.toThrow();
    expect(JSON.stringify(chain)).toBe(frozen);
  });

  describe("review S2: the parent is the full key, so two copies of one pack name differ", () => {
    const P1 = synth(1, 0, "data-live-1", h("1"), null);
    it("B: an entry built on the other copy of main's pack is stale, alone or after that copy", () => {
      const copy = synth(1, 0, "data-live-3", h("9"), null);
      const fromCopy = synth(2, 0, "data-live-2", h("4"), entryKey(copy));
      expect(judgeChain({ main: P1, chain: [copy, fromCopy] }).status).toBe("stale");
      expect(judgeChain({ main: P1, chain: [fromCopy] }).status).toBe("stale");
      // The old "<pack name>#<slug>" parent string no longer matches anything.
      expect(judgeChain({ main: P1, chain: [{ ...fromCopy, parent: `${pack(1)}#example` }] }).status).toBe("stale");
    });
    it("C: a middle entry swapped for the copy in another release is refused", () => {
      const mid = synth(2, 0, "data-live-2", h("5"), entryKey(P1));
      const midSwap = synth(2, 0, "data-live-7", h("6"), entryKey(P1));
      const last = synth(3, 0, "data-live-3", h("7"), entryKey(mid));
      expect(judgeChain({ main: P1, chain: [mid, last] }).status).toBe("accepted");
      expect(judgeChain({ main: P1, chain: [midSwap, last] }).status).toBe("refused");
    });
    it("an entry at another copy of main's pack name is not dropped as main", () => {
      const sameNameElsewhere = { ...n1.entry, bundle: { ...n1.entry.bundle, release: "data-live-2" } };
      expect(judgeChain({ main: mainOf(n1), chain: [sameNameElsewhere, n2.entry] }).status).toBe("stale");
    });
  });
});

describe("days never go backwards along a chain", () => {
  const dayed = (n, sha, parent, day) => ({ ...synth(n, 0, "data-live-1", sha.repeat(64), parent), day });
  const main = { ...dayed(1, "a", null, "2026-11-10"), publishedAt: AT };
  const first = (day) => dayed(2, "b", entryKey(main), day);

  it("the first entry on the main entry's day or after is accepted; earlier is refused", () => {
    expect(judgeChain({ main, chain: [first("2026-11-10")] }).status).toBe("accepted");
    expect(judgeChain({ main, chain: [first("2026-11-11")] }).status).toBe("accepted");
    expect(judgeChain({ main, chain: [first("2026-11-09")] })).toMatchObject({ status: "refused", reason: expect.stringMatching(/day goes backwards/) });
  });

  it("a later entry on its parent's day or after is accepted; earlier is refused, and the reason names the entry", () => {
    const a = first("2026-11-12");
    const same = dayed(3, "c", entryKey(a), "2026-11-12");
    const earlier = dayed(3, "c", entryKey(a), "2026-11-11");
    expect(judgeChain({ main, chain: [a, same] }).status).toBe("accepted");
    const r = judgeChain({ main, chain: [a, earlier] });
    expect(r).toMatchObject({ status: "refused", reason: expect.stringMatching(/day goes backwards at entry 1/) });
  });

  it("a first publish (no main entry) has no day to compare with its first entry", () => {
    expect(judgeChain({ main: null, chain: [dayed(2, "b", null, "2020-01-01")] }).status).toBe("accepted");
  });

  it("the parent rule still comes first: a stale chain is stale whatever its days", () => {
    expect(judgeChain({ main, chain: [dayed(2, "b", null, "2026-11-01")] }).status).toBe("stale");
  });
});
