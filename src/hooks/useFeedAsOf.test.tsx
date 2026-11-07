import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { feedAsOf, parseFeedAsOf, withFeedAsOf } from "./useFeedAsOf";
import { asOfBlockCaption } from "@/components/ExchangeNetDiff";
import { settledEndMs } from "@/lib/settledEnd";

const NOW = new Date("2026-11-06T15:00:00Z");

describe("parseFeedAsOf", () => {
  it("returns null when absent (current feeds)", () => {
    expect(parseFeedAsOf({ entries: [] })).toBeNull();
    expect(parseFeedAsOf(null)).toBeNull();
  });
  it("keeps date and numeric blocks", () => {
    expect(parseFeedAsOf({ asOf: { date: "2026-11-05", blocks: { polygon: 123, bad: "x" } } })).toEqual({
      date: "2026-11-05",
      blocks: { polygon: 123 },
    });
  });
  it("rejects a malformed date", () => {
    expect(parseFeedAsOf({ asOf: { date: "Nov 5" } })).toBeNull();
  });
});

describe("withFeedAsOf / feedAsOf", () => {
  it("leaves the array unchanged for existing callers", () => {
    const rows = withFeedAsOf([{ date: "2026-11-01" }], { asOf: { date: "2026-11-04" } });
    expect(rows).toEqual([{ date: "2026-11-01" }]);
    expect(Object.keys(rows)).toEqual(["0"]);
    expect(feedAsOf(rows)).toEqual({ date: "2026-11-04" });
  });
  it("survives a react-query round-trip with structuralSharing false", async () => {
    const client = new QueryClient();
    const key = ["asOf-roundtrip"];
    const fetched = await client.fetchQuery({
      queryKey: key,
      queryFn: async () => withFeedAsOf([{ date: "2026-11-01" }], { asOf: { date: "2026-11-04" } }),
      structuralSharing: false,
    });
    expect(feedAsOf(fetched)).toEqual({ date: "2026-11-04" });
    expect(feedAsOf(client.getQueryData(key))).toEqual({ date: "2026-11-04" });
    // A refetch with equal rows must not be merged into a plain array.
    await client.refetchQueries({ queryKey: key });
    expect(feedAsOf(client.getQueryData(key))).toEqual({ date: "2026-11-04" });
    client.clear();
  });
  it("is dropped by array transforms (why hooks must not map/filter the result)", () => {
    const rows = withFeedAsOf([{ date: "2026-11-01" }], { asOf: { date: "2026-11-04" } });
    expect(feedAsOf(rows.filter(() => true))).toBeNull();
    expect(feedAsOf([...rows])).toBeNull();
  });
  it("drives settledEndMs: asOf + 1 day when present, else today 00:00 UTC", () => {
    expect(settledEndMs({ asOf: feedAsOf(withFeedAsOf([], { asOf: { date: "2026-11-04" } })) }, NOW)).toBe(Date.parse("2026-11-05"));
    expect(settledEndMs({ asOf: feedAsOf(withFeedAsOf([], { entries: [] })) }, NOW)).toBe(Date.parse("2026-11-06"));
    expect(settledEndMs({ asOf: feedAsOf([]) }, NOW)).toBe(Date.parse("2026-11-06"));
    expect(settledEndMs({ asOf: feedAsOf(undefined) }, NOW)).toBe(Date.parse("2026-11-06"));
  });
});

describe("asOfBlockCaption", () => {
  it("is null without blocks", () => {
    expect(asOfBlockCaption(null)).toBeNull();
    expect(asOfBlockCaption({ date: "2026-11-04" })).toBeNull();
  });
  it("formats one or several chains", () => {
    expect(asOfBlockCaption({ date: "2026-11-04", blocks: { polygon: 9 } })).toBe("as of 2026-11-04 (block 9)");
    expect(asOfBlockCaption({ date: "2026-11-04", blocks: { polygon: 9, base: 7 } })).toBe("as of 2026-11-04 (polygon block 9, base block 7)");
  });
});
