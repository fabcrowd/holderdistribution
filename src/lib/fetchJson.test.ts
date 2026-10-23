import { describe, expect, it, vi } from "vitest";
import { FeedError, fetchJson } from "./fetchJson";

describe("fetchJson", () => {
  it("returns parsed JSON on 2xx", async () => {
    const f = vi.fn(async () => new Response('{"a":1}', { status: 200 }));
    await expect(fetchJson("/data/x.json", undefined, f as unknown as typeof fetch)).resolves.toEqual({ a: 1 });
  });
  it.each([404, 429, 500, 503])("throws FeedError on HTTP %i", async (status) => {
    const f = vi.fn(async () => new Response("nope", { status }));
    await expect(fetchJson("/data/x.json", undefined, f as unknown as typeof fetch)).rejects.toBeInstanceOf(FeedError);
    await expect(fetchJson("/data/x.json", undefined, f as unknown as typeof fetch)).rejects.toMatchObject({ status });
  });
});
