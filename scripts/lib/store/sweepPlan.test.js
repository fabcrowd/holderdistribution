// The plan's rules, each on both sides of its boundary (design 2.1 section 4.3), and the
// plan's own guarantees: every object once, no argument changed, no plan on bad input.
import { describe, it, expect } from "vitest";
import { planSweep, headerCandidates } from "./sweepPlan.js";
import { SweepPlanError } from "./sweepErrors.js";
import { dayBefore } from "./sweepRules.js";
import { SWEEP_WAIT_DAYS, EVENTS_KEEP_DAYS, REMOVED_COIN_HOLD_DAYS, SITE_ROOTS_KEPT } from "./storeConstants.js";
import { TODAY, NOW, HISTORY_DAYS, LONG_AGO, ok, unreadable, livePack, histPack, eventsPack, siteRoot, entry, world } from "./sweepKit.js";

const verdict = (plan, loc) => {
  const d = plan.delete.find((e) => e.loc === loc);
  const k = plan.keep.find((e) => e.loc === loc);
  expect([d, k].filter(Boolean), `${loc} must be listed exactly once`).toHaveLength(1);
  return d ? "delete" : "keep";
};

// One live pack of `ageDays`, listing `coins`, in a world with the given coins.
function liveCase(ageDays, { state = "uploaded", coins = ["example"], refs, ...over } = {}) {
  const e = entry("live", livePack(1), { ageDays, state });
  const input = world({
    listings: { live: [e] }, coinsByLoc: new Map([[e.loc, coins]]),
    references: new Map([["example", refs ?? ok("example", [])], ["other", ok("other", [])]]), ...over,
  });
  return { e, plan: planSweep(input), input };
}

describe("live", () => {
  it("deletes at the wait and keeps one day short of it", () => {
    const a = liveCase(SWEEP_WAIT_DAYS);
    expect(verdict(a.plan, a.e.loc)).toBe("delete");
    expect(a.plan.delete[0].rule).toMatch(/named by no readable coin; 432\.00 h old \(18\.00 days\), at least 18 days/);
    const b = liveCase(SWEEP_WAIT_DAYS - 1);
    expect(verdict(b.plan, b.e.loc)).toBe("keep");
    expect(b.plan.keep[0].reason).toMatch(/408\.00 h old, waits until 432 h/);
  });

  it("a dead upload goes at 1 day and not at 0, long before the wait", () => {
    const day1 = liveCase(1, { state: "starter" });
    expect(verdict(day1.plan, day1.e.loc)).toBe("delete");
    expect(day1.plan.delete[0].rule).toMatch(/dead upload \(state starter\) 24\.00 h old/);
    const young = liveCase(0, { state: "starter" });
    expect(verdict(young.plan, young.e.loc)).toBe("keep");
    expect(young.plan.keep[0].code).toBe("dead-upload-young");
  });

  it("a location a readable coin names is kept at any age, in any class", () => {
    const l = entry("live", livePack(1), { ageDays: 90 });
    const h = entry("hist", histPack(2, "2024-01-01"), { ageDays: 900 });
    const ev = entry("events", eventsPack(3, "2024-01-01"), { ageDays: 900 });
    const plan = planSweep(world({
      listings: { live: [l], hist: [h], events: [ev] }, coinsByLoc: new Map([[l.loc, ["example"]], [h.loc, ["example"]], [ev.loc, ["example"]]]),
      references: new Map([["example", ok("example", [l.loc, h.loc, ev.loc])]]), oldestNeededDay: new Map([["example", "2026-10-01"]]),
    }));
    expect(plan.delete).toEqual([]);
    expect(plan.keep.map((k) => k.code)).toEqual(["referenced", "referenced", "referenced"]);
    expect(plan.keep[0].reason).toBe("named by example");
  });

  it("an unreadable coin in the header pins the pack, and the pack goes once the coin is readable", () => {
    const pinned = liveCase(40, { references: new Map([["example", ok("example", [])], ["other", unreadable("other")]]), coins: ["example", "other"] });
    expect(verdict(pinned.plan, pinned.e.loc)).toBe("keep");
    expect(pinned.plan.keep[0].code).toBe("unreadable-coin");
    expect(pinned.plan.summary.byClass.live.bytesWaiting).toBe(100);
    const clear = liveCase(40, { coins: ["example", "other"] });
    expect(verdict(clear.plan, clear.e.loc)).toBe("delete");
  });

  it("a coin nobody classified pins the pack", () => {
    const c = liveCase(40, { coins: ["example", "stranger"] });
    expect(c.plan.keep[0]).toMatchObject({ code: "unknown-coin" });
    expect(c.plan.summary.reported.map((r) => r.code)).toEqual(["unknown-coin"]);
  });
});

describe("the copy of a pack name in another release", () => {
  it("is its own object: the unreferenced copy goes after the wait, the referenced copy stays", () => {
    const name = livePack(1);
    const named = entry("live", name, { ageDays: 30, seq: 1 });
    const copy = entry("live", name, { ageDays: 30, seq: 2 });
    const plan = planSweep(world({
      listings: { live: [named, copy] }, coinsByLoc: new Map([[copy.loc, ["example"]]]),
      references: new Map([["example", ok("example", [named.loc])]]),
    }));
    expect(verdict(plan, named.loc)).toBe("keep");
    expect(verdict(plan, copy.loc)).toBe("delete");
    expect(plan.keep.find((k) => k.loc === named.loc).reason).toBe("named by example");
  });
});

describe("site roots", () => {
  const roots = (n) => Array.from({ length: n }, (_, i) => entry("site", siteRoot(i + 1, `2026-10-${String(i + 1).padStart(2, "0")}`), { ageDays: 40 }));

  it("keeps the current root and the 16 before it: number 16 kept, number 17 deleted", () => {
    const all = roots(20); // oldest first; the newest is the current root
    const current = all.at(-1);
    const plan = planSweep(world({ listings: { site: all }, currentSiteRoot: current.loc }));
    const number = (n) => all.at(-1 - n).loc;
    expect(verdict(plan, current.loc)).toBe("keep");
    expect(verdict(plan, number(SITE_ROOTS_KEPT))).toBe("keep");
    expect(verdict(plan, number(SITE_ROOTS_KEPT + 1))).toBe("delete");
    expect(plan.keep.find((k) => k.loc === number(16)).reason).toMatch(/number 16/);
    expect(plan.delete).toHaveLength(3);
  });

  it("roots newer than the current one are not protected and leave by the age rule", () => {
    const all = roots(4);
    const plan = planSweep(world({ listings: { site: all }, currentSiteRoot: all[1].loc }));
    expect(plan.delete.map((d) => d.loc)).toEqual([all[2].loc, all[3].loc].sort());
    expect(verdict(plan, all[0].loc)).toBe("keep");
  });

  it("refuses to plan when the current root is unknown or missing from the listing", () => {
    const all = roots(2);
    expect(() => planSweep(world({ listings: { site: all } }))).toThrow(SweepPlanError);
    expect(() => planSweep(world({ listings: { site: all }, currentSiteRoot: "data-site-1/site.2026-09-01.r9a1p1.json" }))).toThrow(/not in the site listing/);
  });
});

describe("hist", () => {
  const first = dayBefore(TODAY, HISTORY_DAYS - 1); // the oldest day inside the horizon
  const histCase = (day, { needed = "2026-11-18", refs = null } = {}) => {
    const e = entry("hist", histPack(1, day), { ageDays: 500 });
    const references = new Map([["example", ok("example", [])], ...(refs ?? [])]);
    const plan = planSweep(world({
      listings: { hist: [e] }, coinsByLoc: new Map([[e.loc, ["example"]]]), references,
      oldestNeededDay: new Map(needed === null ? [] : [["example", needed]]),
    }));
    return { plan, e };
  };

  it("deletes when its newest day is one day outside the horizon and keeps it on the first day inside", () => {
    const out = histCase(dayBefore(first, 1));
    expect(verdict(out.plan, out.e.loc)).toBe("delete");
    const inside = histCase(first);
    expect(verdict(inside.plan, inside.e.loc)).toBe("keep");
    expect(inside.plan.keep[0].code).toBe("inside-horizon");
  });

  it("waits while a listed coin's oldest needed change day is on or before the pack's day", () => {
    const day = dayBefore(first, 5);
    const needsIt = histCase(day, { needed: day });
    expect(needsIt.plan.keep[0].code).toBe("needed-by-coin");
    const after = histCase(day, { needed: dayBefore(first, 4) });
    expect(verdict(after.plan, after.e.loc)).toBe("delete");
    const unknown = histCase(day, { needed: null });
    expect(unknown.plan.keep[0].code).toBe("needed-day-unknown");
  });

  it("a hist pack listing an unreadable coin stays", () => {
    const out = histCase(dayBefore(first, 30), { refs: [["bad", unreadable("bad")]] });
    expect(verdict(out.plan, out.e.loc)).toBe("delete"); // "bad" is not listed in its header
    const e = entry("hist", histPack(2, dayBefore(first, 30)), { ageDays: 500 });
    const plan = planSweep(world({
      listings: { hist: [e] }, coinsByLoc: new Map([[e.loc, ["example", "bad"]]]),
      references: new Map([["example", ok("example", [])], ["bad", unreadable("bad")]]), oldestNeededDay: new Map([["example", TODAY]]),
    }));
    expect(plan.keep[0].code).toBe("unreadable-coin");
  });
});

describe("events", () => {
  it("deletes a pack whose day is more than four days old and keeps one of four", () => {
    const old = entry("events", eventsPack(1, dayBefore(TODAY, EVENTS_KEEP_DAYS + 1)), { ageDays: 5 });
    const recent = entry("events", eventsPack(2, dayBefore(TODAY, EVENTS_KEEP_DAYS)), { ageDays: 4 });
    const plan = planSweep(world({
      listings: { events: [old, recent] }, coinsByLoc: new Map([[old.loc, ["example"]], [recent.loc, ["example"]]]),
      references: new Map([["example", ok("example", [])]]),
    }));
    expect(verdict(plan, old.loc)).toBe("delete");
    expect(verdict(plan, recent.loc)).toBe("keep");
    expect(plan.keep[0].code).toBe("events-recent");
  });

  it("an events pack listing an unreadable coin is pinned (10(j))", () => {
    const old = entry("events", eventsPack(1, dayBefore(TODAY, 30)), { ageDays: 30 });
    const plan = planSweep(world({
      listings: { events: [old] }, coinsByLoc: new Map([[old.loc, ["bad"]]]), references: new Map([["bad", unreadable("bad")]]),
    }));
    expect(plan.keep[0].code).toBe("unreadable-coin");
  });
});

describe("a removed coin", () => {
  const heldAt = (days) => {
    const l = entry("live", livePack(1), { ageDays: 60 });
    const h = entry("hist", histPack(2, dayBefore(TODAY, 600)), { ageDays: 60 });
    const ev = entry("events", eventsPack(3, dayBefore(TODAY, 20)), { ageDays: 20 });
    const coinsByLoc = new Map([l, h, ev].map((e) => [e.loc, ["gone"]]));
    const plan = planSweep(world({ listings: { live: [l], hist: [h], events: [ev] }, coinsByLoc, removed: new Map([["gone", dayBefore(TODAY, days)]]) }));
    return [l, h, ev].map((e) => verdict(plan, e.loc));
  };

  it("holds every pack listing it at 29 days and releases them at 30 and 31", () => {
    expect(heldAt(REMOVED_COIN_HOLD_DAYS - 1)).toEqual(["keep", "keep", "keep"]);
    expect(heldAt(REMOVED_COIN_HOLD_DAYS)).toEqual(["delete", "delete", "delete"]);
    expect(heldAt(REMOVED_COIN_HOLD_DAYS + 1)).toEqual(["delete", "delete", "delete"]);
  });

  it("is not unreadable and contributes no references; a readable coin's reference still protects a pack it shares", () => {
    const l = entry("live", livePack(1), { ageDays: 60 });
    const plan = planSweep(world({
      listings: { live: [l] }, coinsByLoc: new Map([[l.loc, ["gone", "example"]]]),
      references: new Map([["example", ok("example", [l.loc])]]), removed: new Map([["gone", "2026-01-01"]]),
    }));
    expect(plan.keep[0].code).toBe("referenced");
  });

  // A coin marked removed that has a reference result is back in the registry: the mark is ignored and reported.
  it("a removed coin that comes back readable no longer holds its packs, and the summary names it", () => {
    const l = entry("live", livePack(1), { ageDays: 60 });
    const plan = planSweep(world({
      listings: { live: [l] }, coinsByLoc: new Map([[l.loc, ["back"]]]), references: new Map([["back", ok("back", [])]]), removed: new Map([["back", dayBefore(TODAY, 2)]]),
    }));
    expect(verdict(plan, l.loc)).toBe("delete"); // not held 30 days as a removed coin, and not unknown
    expect(plan.summary.returnedCoins).toEqual(["back"]);
  });

  it("a removed coin that comes back unreadable pins its packs, and the summary names it", () => {
    const l = entry("live", livePack(1), { ageDays: 60 });
    const plan = planSweep(world({
      listings: { live: [l] }, coinsByLoc: new Map([[l.loc, ["back"]]]), references: new Map([["back", unreadable("back")]]), removed: new Map([["back", "2020-01-01"]]),
    }));
    expect(plan.keep[0].code).toBe("unreadable-coin");
    expect(plan.summary.returnedCoins).toEqual(["back"]);
  });
});

describe("releases", () => {
  it("deletes an empty release that is not current, and a release whose every asset leaves, never the current one", () => {
    const a = entry("live", livePack(1), { ageDays: 40, seq: 1 });
    const b = entry("live", livePack(2), { ageDays: 1, seq: 2 });
    const c = entry("live", livePack(3), { ageDays: 40, seq: 4 });
    const plan = planSweep(world({
      listings: { live: [a, b, c] }, emptyReleases: { live: ["data-live-3"], hist: ["data-hist-1"], events: ["data-events-1"] },
      currentReleases: { live: "data-live-4", hist: "data-hist-2", events: "data-events-1" },
      coinsByLoc: new Map([[a.loc, ["example"]], [c.loc, ["example"]]]), references: new Map([["example", ok("example", [])]]),
    }));
    // data-hist-1 is the newest of its series in the listing, so it stays although it is empty
    expect(plan.releasesToDelete.map((r) => r.tag).sort()).toEqual(["data-live-1", "data-live-3"]);
    expect(plan.summary.releasesKept.find((r) => r.tag === "data-hist-1").code).toBe("newest-release");
    expect(plan.releasesToDelete.find((r) => r.tag === "data-live-3").rule).toMatch(/^no assets, not the newest or the current release/);
    expect(plan.releasesToDelete.find((r) => r.tag === "data-live-1").rule).toMatch(/^every asset of it is deleted tonight/);
  });

  it("an inconsistent release count refuses the plan", () => {
    const e = entry("live", livePack(1), { ageDays: 40 });
    const input = world({ listings: { live: [e] } });
    input.releases.live[0].assets = 2;
    expect(() => planSweep(input)).toThrow(/the listing shows 1 asset\(s\), the release list says 2/);
  });
});

describe("what is never touched, and the plan's own guarantees", () => {
  it("keeps and reports a name that is not a store name and one from another series", () => {
    const junk = entry("live", "notes.txt", { ageDays: 90 });
    const bad = entry("live", "p.live.holders.2026-02-31.r1a1.l0f0.hdb", { ageDays: 90 });
    const stray = entry("live", histPack(1, "2020-01-01"), { ageDays: 90 });
    const plan = planSweep(world({ listings: { live: [junk, bad, stray] } }));
    expect(plan.delete).toEqual([]);
    expect(plan.keep.map((k) => k.code)).toEqual(["not-a-store-name", "not-a-store-name", "wrong-series"]);
    expect(plan.summary.reported).toHaveLength(3);
  });

  it("a pack whose header could not be read is kept and reported; one not read tonight is kept", () => {
    const a = entry("live", livePack(1), { ageDays: 40 });
    const b = entry("live", livePack(2), { ageDays: 40 });
    const plan = planSweep(world({ listings: { live: [a, b] }, coinsByLoc: new Map([[a.loc, null]]), references: new Map([["example", ok("example", [])]]) }));
    expect(plan.keep.map((k) => k.code)).toEqual(["header-unreadable", "header-unread"]);
    expect(plan.summary.reported.map((r) => r.loc)).toEqual([a.loc]);
  });

  it("every listed object is in exactly one list, the input is not changed, and the summary adds up", () => {
    const es = [entry("live", livePack(1), { ageDays: 40 }), entry("live", livePack(2), { ageDays: 3 }), entry("events", eventsPack(3, dayBefore(TODAY, 9)), { ageDays: 9 })];
    const input = world({ listings: { live: es.slice(0, 2), events: [es[2]] }, coinsByLoc: new Map(es.map((e) => [e.loc, ["example"]])), references: new Map([["example", ok("example", [])]]) });
    const frozen = JSON.stringify([input, [...input.coinsByLoc], [...input.references]]);
    const plan = planSweep(input);
    expect(JSON.stringify([input, [...input.coinsByLoc], [...input.references]])).toBe(frozen);
    expect([...plan.delete, ...plan.keep].map((e) => e.loc).sort()).toEqual(es.map((e) => e.loc).sort());
    const { live, events } = plan.summary.byClass;
    expect([live.listed, live.deleted, live.bytesDeleted, live.bytesWaiting, live.kept]).toEqual([2, 1, 100, 100, { "too-young": 1 }]);
    expect([events.listed, events.deleted]).toEqual([1, 1]);
    expect(planSweep(input)).toEqual(plan);
  });

  it("refuses bad input: a short history, an unknown status, a missing current release, a today that is not the day of now", () => {
    expect(() => planSweep(world({ historyDays: 370 }))).toThrow(SweepPlanError);
    expect(() => planSweep(world({ references: new Map([["x", { status: "maybe" }]]) }))).toThrow(/neither "ok" nor "unreadable"/);
    const input = world();
    delete input.currentReleases.hist;
    expect(() => planSweep(input)).toThrow(/no current release given for the hist series/);
    expect(() => planSweep(world({ today: "2026-11-18" }))).toThrow(/is not the UTC day of now/);
  });

  it("headerCandidates lists only objects that pass every rule that needs no header", () => {
    const young = entry("live", livePack(1), { ageDays: 3 });
    const old = entry("live", livePack(2), { ageDays: 30 });
    const named = entry("live", livePack(3), { ageDays: 30 });
    const dead = entry("live", livePack(4), { ageDays: 30, state: "starter" });
    const recent = entry("events", eventsPack(5, dayBefore(TODAY, 2)), { ageDays: 2 });
    const stale = entry("events", eventsPack(6, dayBefore(TODAY, 9)), { ageDays: 9 });
    const site = entry("site", siteRoot(1), { ageDays: 30 });
    const input = world({
      listings: { live: [young, old, named, dead], events: [recent, stale], site: [site] }, currentSiteRoot: null,
      references: new Map([["example", ok("example", [named.loc])]]),
    });
    expect(() => headerCandidates(input)).toThrow(SweepPlanError); // a site root without a current one
    input.currentSiteRoot = site.loc;
    expect(headerCandidates(input)).toEqual([old.loc, stale.loc].sort());
  });
});

describe("waits counted from creation are elapsed time (the clock of each rule)", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  // An asset created `elapsed` ms before `now`.
  const made = (elapsed, { state = "uploaded", now = NOW } = {}) => ({ ...entry("live", livePack(1), { state }), createdAt: new Date(Date.parse(now) - elapsed).toISOString() });
  const planFor = (e, now = NOW) => planSweep(world({ now, listings: { live: [e] }, coinsByLoc: new Map([[e.loc, ["example"]]]), references: new Map([["example", ok("example", [])]]) }));

  it("a dead upload made at 23:59 UTC is kept two minutes later, across midnight", () => {
    const now = "2026-11-19T00:01:00Z";
    const e = { ...entry("live", livePack(1), { state: "starter" }), createdAt: "2026-11-18T23:59:00Z" };
    const plan = planFor(e, now);
    expect(verdict(plan, e.loc)).toBe("keep");
    expect(plan.keep[0].code).toBe("dead-upload-young");
  });

  it("a dead upload: 23 h 59 min is kept, 24 h is deleted", () => {
    expect(verdict(planFor(made(DAY - 60_000, { state: "starter" })), made(0).loc)).toBe("keep");
    expect(verdict(planFor(made(DAY, { state: "starter" })), made(0).loc)).toBe("delete");
  });

  it("the live wait: 18 x 24 h minus one second is kept, exactly 18 x 24 h is deleted", () => {
    const loc = made(0).loc;
    expect(verdict(planFor(made(18 * DAY - 1000)), loc)).toBe("keep");
    expect(verdict(planFor(made(18 * DAY)), loc)).toBe("delete");
    expect(planFor(made(18 * DAY)).delete[0].rule).toMatch(/18\.00 days/);
  });

  it("a createdAt that is missing or does not parse keeps the object and reports it", () => {
    for (const bad of [undefined, null, "", "yesterday", "2026-13-45T00:00:00Z"]) {
      for (const state of ["uploaded", "starter"]) {
        const e = { ...made(40 * DAY, { state }), createdAt: bad };
        const plan = planFor(e);
        expect(plan.keep[0].code, `${String(bad)} ${state}`).toBe("created-unknown");
        expect(plan.summary.reported.map((r) => r.code)).toEqual(["created-unknown"]);
      }
    }
  });

  it("rules that go by the day in the name keep day arithmetic: an events pack of day today-5 goes at 00:01 as at 23:59", () => {
    for (const now of ["2026-11-19T00:01:00Z", "2026-11-19T23:59:00Z"]) {
      const e = entry("events", eventsPack(1, dayBefore(TODAY, 5)), { ageDays: 5 });
      const plan = planSweep(world({ now, listings: { events: [e] }, coinsByLoc: new Map([[e.loc, ["example"]]]), references: new Map([["example", ok("example", [])]]) }));
      expect(verdict(plan, e.loc)).toBe("delete");
    }
  });

  it("refuses a now that is not an instant", () => {
    expect(() => planSweep(world({ now: "noon" }))).toThrow(/now must be an instant/);
    expect(() => planSweep(world({ now: undefined }))).toThrow(/now must be an instant/);
  });
});

// An empty release is deleted only when it is not the newest of its series in the listing, not the release
// currentReleases names, its next higher existing release is at least the dead-upload wait old, and (at
// execution) a fresh count is zero. The wait is elapsed time against now.
describe("when an empty release may go", () => {
  const HOUR = 3_600_000;
  const at = (ms) => new Date(Date.parse(NOW) - ms).toISOString();
  const pack = (n, seq) => entry("live", livePack(n), { ageDays: 1, seq });
  // data-live-1 is empty; the others hold one young pack each. `stamps` sets creation times by tag.
  const plan = ({ seqs = [2], stamps = {}, current, empty = [1] } = {}) => {
    const held = seqs.map((q, i) => pack(i + 1, q));
    return planSweep(world({
      listings: { live: held }, emptyReleases: { live: empty.map((q) => `data-live-${q}`) },
      releaseCreatedAt: stamps, currentReleases: { live: current ?? `data-live-${Math.max(...seqs)}` },
      coinsByLoc: new Map(held.map((e) => [e.loc, ["example"]])), references: new Map([["example", ok("example", [])]]),
    }));
  };
  const tags = (p) => p.releasesToDelete.map((r) => r.tag);
  const kept = (p, tag) => p.summary.releasesKept.find((r) => r.tag === tag)?.code;

  it("is deleted when its successor is older than the wait, and not the newest or the named current", () => {
    expect(tags(plan())).toEqual(["data-live-1"]);
  });

  it("the newest release of the series in the listing is never deleted, whatever currentReleases says", () => {
    const p = plan({ seqs: [], empty: [1, 2], current: "data-live-1" }); // a stale current, a newer empty release
    expect(tags(p)).toEqual([]);
    expect(kept(p, "data-live-2")).toBe("newest-release");
    expect(kept(p, "data-live-1")).toBe("current-release");
  });

  it("the release currentReleases names is kept even when it is not the newest", () => {
    const p = plan({ current: "data-live-1" });
    expect(tags(p)).toEqual([]);
    expect(kept(p, "data-live-1")).toBe("current-release");
  });

  it("a successor made 23 h 59 min ago keeps it; one made 24 h ago lets it go", () => {
    const young = plan({ stamps: { "data-live-2": at(24 * HOUR - 60_000) } });
    expect(tags(young)).toEqual([]);
    expect(kept(young, "data-live-1")).toBe("successor-too-young");
    expect(tags(plan({ stamps: { "data-live-2": at(24 * HOUR) } }))).toEqual(["data-live-1"]);
  });

  it("with a gap in the numbering the next higher existing release is the successor", () => {
    const p = plan({ seqs: [4], stamps: { "data-live-4": at(HOUR), "data-live-2": LONG_AGO } });
    expect(tags(p)).toEqual([]); // 2 and 3 do not exist; 4 is 1 h old
    expect(tags(plan({ seqs: [4], stamps: { "data-live-4": at(25 * HOUR) } }))).toEqual(["data-live-1"]);
  });

  it("a successor with no creation time keeps the release and reports it", () => {
    const p = plan({ stamps: { "data-live-2": null } });
    expect(tags(p)).toEqual([]);
    expect(kept(p, "data-live-1")).toBe("successor-created-unknown");
    expect(p.summary.reported.map((r) => r.code)).toContain("successor-created-unknown");
  });

  it("a release that is empty only because everything in it is deleted tonight follows the same rules", () => {
    const old = entry("live", livePack(9), { ageDays: 40, seq: 1 });
    const young = pack(2, 2);
    const mk = (stamp) => planSweep(world({
      listings: { live: [old, young] }, releaseCreatedAt: { "data-live-2": stamp }, currentReleases: { live: "data-live-2" },
      coinsByLoc: new Map([[old.loc, ["example"]]]), references: new Map([["example", ok("example", [])]]),
    }));
    expect(tags(mk(at(30 * HOUR)))).toEqual(["data-live-1"]);
    expect(tags(mk(at(HOUR)))).toEqual([]);
  });
});
