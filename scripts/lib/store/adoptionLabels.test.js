import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptChain } from "./acceptChain.js";
import { createWorld, dayPlus, publishedOf } from "./adoptionKit.js";
import { adoptLane } from "./adoptionLane.js";

// Merge of main's lane plumbing (#205): acceptChain refuses a bundle whose item is labelled with
// another coin or not labelled at all. Adoption must see that too, drop such a bundle with its
// followers, and never hand the publish a chain that acceptChain then refuses every night.
const SLUG = "example";
const KIND = "holders";
const D0 = "2026-11-10";
let w;
beforeEach(() => { w = createWorld(); });
afterEach(() => w.cleanup());

const lane = (liveTag, main) => adoptLane({ blobs: w.blobs, ...w.listing, liveTag, kind: KIND, coins: [{ slug: SLUG, main: publishedOf(main) }] });
const accepted = async (main, chain) => (await acceptChain({ blobs: w.blobs, slug: SLUG, kind: KIND, main: publishedOf(main), chain })).status;

// A pack with an unlabelled item has no coin list (pack.js), so adoption does not list it for the
// coin: the follower of that bundle reports a broken link, never silence.
describe("item labels", () => {
  for (const [label, itemSlug] of [["labelled with another coin", "intruder"], ["not labelled", null]]) {
    it(`a bundle whose blob is ${label} is dropped with its follower, the chain before it is adopted and accepted`, async () => {
      const m = await w.one({ slug: SLUG, day: D0, run: 100, release: "data-live-1" });
      const a = await w.one({ slug: SLUG, day: dayPlus(D0, 1), run: 101, parent: m, release: "data-live-2" });
      const b = await w.one({ slug: SLUG, day: dayPlus(D0, 2), run: 102, parent: a, release: "data-live-2", itemSlug });
      await w.one({ slug: SLUG, day: dayPlus(D0, 3), run: 103, parent: b, release: "data-live-2" });
      const r = (await lane("data-live-2", m)).coins[SLUG];
      expect(r.chain).toEqual([a.entry]);
      expect(r.alerts).toEqual([itemSlug === null ? { code: "broken-link", count: 1 } : { code: "damaged", count: 1 }]);
      expect(await accepted(m, r.chain)).toBe("accepted");
    });
  }

  it("the first bundle of a chain is checked in full too", async () => {
    const m = await w.one({ slug: SLUG, day: D0, run: 100, release: "data-live-1" });
    await w.one({ slug: SLUG, day: dayPlus(D0, 1), run: 101, parent: m, release: "data-live-2", itemSlug: "intruder" });
    const r = (await lane("data-live-2", m)).coins[SLUG];
    expect(r.chain).toEqual([]);
    expect(r.alerts).toEqual([{ code: "damaged", count: 1 }]);
  });
});
