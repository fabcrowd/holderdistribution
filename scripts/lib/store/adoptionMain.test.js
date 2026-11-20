import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorld, dayPlus, publishedOf } from "./adoptionKit.js";
import { adoptLane } from "./adoptionLane.js";

// Reconciled with main's lane plumbing (#205): the store answers listRelease(tag) and
// listReleaseTags(series) itself.
const SLUG = "example";
const KIND = "holders";
const D0 = "2026-11-10";
let w;
beforeEach(() => { w = createWorld(); });
afterEach(() => w.cleanup());
const rel = (n) => `data-live-${n}`;

describe("the store's own listing calls", () => {
  it("with no listRelease and no existingReleases injected, the lane lists through blobs.listRelease and blobs.listReleaseTags", async () => {
    const m = await w.one({ slug: SLUG, day: D0, run: 100, release: rel(1) });
    const chain = [];
    for (let n = 1; n <= 3; n++) chain.push(await w.one({ slug: SLUG, day: dayPlus(D0, n), run: 100 + n, parent: chain.at(-1) ?? m, release: rel(n + 1) }));
    const out = await adoptLane({ blobs: w.blobs, now: w.now, sleep: w.sleep, liveTag: rel(4), kind: KIND, coins: [{ slug: SLUG, main: publishedOf(m) }] });
    expect(out.listing.tags).toEqual([rel(4), rel(3), rel(2), rel(1)]);
    expect(out.coins[SLUG].chain).toEqual(chain.map((c) => c.entry));
    expect(w.calls.listRelease).toBe(0); // the kit's injected calls were not used
  });
});
