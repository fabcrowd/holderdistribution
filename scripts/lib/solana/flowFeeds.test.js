import { describe, expect, it } from "vitest";
import { applyFlowEventsOnce, emptyFlowStore } from "./flowFeeds.js";

const CHAIN = "solana";

const event = (signature, raw, overrides = {}) => ({
  kind: "cexIn",
  venue: "binance",
  counterparty: "OWNER",
  raw,
  date: "2026-01-01",
  signature,
  ...overrides,
});

const cexInTotal = (store) => store.chains[CHAIN].days["2026-01-01"].totals.cexIn;

describe("applyFlowEventsOnce", () => {
  it("applies a fresh chunk and records its signatures", () => {
    const store = emptyFlowStore();
    applyFlowEventsOnce(store, CHAIN, [event("s1", "100"), event("s2", "50")]);

    expect(cexInTotal(store)).toBe("150");
    expect(store.chains[CHAIN].lastApplied).toEqual(["s1", "s2"]);
  });

  it("does not double count a chunk re-delivered after a crash before the checkpoint write", () => {
    const store = emptyFlowStore();
    const chunkN = [event("s1", "100"), event("s2", "50")];
    applyFlowEventsOnce(store, CHAIN, chunkN);

    // Store was written with chunk N, but the checkpoint still points at N-1,
    // so the scan delivers chunk N again on the next run.
    applyFlowEventsOnce(store, CHAIN, chunkN);

    expect(cexInTotal(store)).toBe("150");
    expect(store.chains[CHAIN].lastApplied).toEqual(["s1", "s2"]);
  });

  it("applies the next chunk and replaces lastApplied with its signatures", () => {
    const store = emptyFlowStore();
    applyFlowEventsOnce(store, CHAIN, [event("s1", "100"), event("s2", "50")]);
    applyFlowEventsOnce(store, CHAIN, [event("s3", "25")]);

    expect(cexInTotal(store)).toBe("175");
    expect(store.chains[CHAIN].lastApplied).toEqual(["s3"]);
  });

  it("leaves lastApplied untouched for an empty chunk", () => {
    const store = emptyFlowStore();
    applyFlowEventsOnce(store, CHAIN, [event("s1", "100")]);
    applyFlowEventsOnce(store, CHAIN, []);

    expect(cexInTotal(store)).toBe("100");
    expect(store.chains[CHAIN].lastApplied).toEqual(["s1"]);
  });

  it("applies only the new events of a partially overlapping chunk", () => {
    const store = emptyFlowStore();
    applyFlowEventsOnce(store, CHAIN, [event("s1", "100"), event("s2", "50")]);
    applyFlowEventsOnce(store, CHAIN, [event("s2", "50"), event("s4", "10")]);

    expect(cexInTotal(store)).toBe("160");
    expect(store.chains[CHAIN].lastApplied).toEqual(["s2", "s4"]);
  });

  it("keeps events without a signature on every delivery", () => {
    const store = emptyFlowStore();
    const unsigned = event(undefined, "7");
    applyFlowEventsOnce(store, CHAIN, [unsigned]);
    applyFlowEventsOnce(store, CHAIN, [unsigned]);

    expect(cexInTotal(store)).toBe("14");
    expect(store.chains[CHAIN].lastApplied).toEqual([]);
  });

  it("creates the chain entry for an empty chunk without recording signatures", () => {
    const store = emptyFlowStore();
    applyFlowEventsOnce(store, CHAIN, []);

    expect(store.chains[CHAIN].days).toEqual({});
    expect(store.chains[CHAIN].lastApplied).toBeUndefined();
  });
});
