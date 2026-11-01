import { describe, expect, it, vi } from "vitest";
import { AGGREGATE3_SELECTOR, aggregateCalls, decodeAggregate3, encodeAggregate3, isTransportError } from "./multicall.js";

const w = (hex) => hex.padStart(64, "0");
const T1 = "0x1111111111111111111111111111111111111111";
const T2 = "0x2222222222222222222222222222222222222222";

// Independent ABI encoding of a Result[] return value, built from the spec:
// head offset, length, element offsets, then (bool, bytes) tuples.
function encodeResults(results) {
  const tuples = results.map(({ success, data }) => {
    const hex = data.replace(/^0x/, "");
    const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
    return w(success ? "1" : "0") + w("40") + w((hex.length / 2).toString(16)) + padded;
  });
  let offset = results.length * 32;
  const offsets = tuples.map((t) => {
    const here = offset;
    offset += t.length / 2;
    return w(here.toString(16));
  });
  return `0x${w("20")}${w(results.length.toString(16))}${offsets.join("")}${tuples.join("")}`;
}

describe("encodeAggregate3", () => {
  it("uses the aggregate3 selector", () => {
    expect(AGGREGATE3_SELECTOR).toBe("0x82ad56cb");
  });

  it("matches the ABI layout for one call with 4 bytes of calldata", () => {
    expect(encodeAggregate3([{ target: T1, callData: "0xdeadbeef" }])).toBe(
      "0x82ad56cb" +
        w("20") + // offset of the array
        w("1") + // length
        w("20") + // offset of element 0 (1 offset word)
        w("1111111111111111111111111111111111111111") + // target
        w("1") + // allowFailure
        w("60") + // offset of bytes in the tuple
        w("4") + // bytes length
        "deadbeef".padEnd(64, "0"),
    );
  });

  it("offsets the second element past the first (36-byte calldata spans 2 words)", () => {
    const long = `0x${"ab".repeat(36)}`;
    const hex = encodeAggregate3([{ target: T1, callData: "0xdeadbeef" }, { target: T2, callData: long }]).slice(10);
    const words = hex.match(/.{64}/g);
    expect(words[1]).toBe(w("2")); // length
    expect(words[2]).toBe(w("40")); // element 0 starts after the 2 offset words
    // element 0 is 3 head words + length + 1 data word = 5 words = 160 bytes -> element 1 at 64 + 160 = 224 = 0xe0
    expect(words[3]).toBe(w("e0"));
  });
});

describe("decodeAggregate3", () => {
  it("round-trips successes, failures and variable-length return data", () => {
    const uint = w("2a");
    const hex = encodeResults([
      { success: true, data: uint },
      { success: false, data: "0x" },
      { success: true, data: `0x${"cd".repeat(40)}` },
    ]);
    expect(decodeAggregate3(hex)).toEqual([
      { success: true, returnData: `0x${uint}` },
      { success: false, returnData: "0x" },
      { success: true, returnData: `0x${"cd".repeat(40)}` },
    ]);
  });
});

describe("aggregateCalls", () => {
  const calls = (n) => Array.from({ length: n }, (_, i) => ({ target: T1, callData: `0x${(i + 1).toString(16).padStart(8, "0")}` }));
  // A fake node: decodes nothing, just answers with the call's index as its uint.
  const okNode = () =>
    vi.fn(async (_url, _method, [{ data }]) => {
      const n = Number.parseInt(data.slice(10 + 64, 10 + 128), 16);
      return encodeResults(Array.from({ length: n }, (_, i) => ({ success: true, data: w(i.toString(16)) })));
    });

  it("makes one eth_call for a batch and keeps order", async () => {
    const call = okNode();
    const out = await aggregateCalls("https://rpc", calls(5), { call });
    expect(call).toHaveBeenCalledTimes(1);
    expect(out.map((r) => Number.parseInt(r.returnData, 16))).toEqual([0, 1, 2, 3, 4]);
  });

  it("chunks above maxBatch", async () => {
    const call = okNode();
    const out = await aggregateCalls("https://rpc", calls(10), { call, maxBatch: 4 });
    expect(call).toHaveBeenCalledTimes(3);
    expect(out).toHaveLength(10);
  });

  it("splits a rejected batch and marks only an irreducible call as failed", async () => {
    const poison = calls(4)[2].callData;
    const call = vi.fn(async (_url, _method, [{ data }]) => {
      if (data.includes(poison.slice(2))) throw new Error("execution reverted");
      const n = Number.parseInt(data.slice(10 + 64, 10 + 128), 16);
      return encodeResults(Array.from({ length: n }, () => ({ success: true, data: w("7") })));
    });
    const out = await aggregateCalls("https://rpc", calls(4), { call });
    expect(out.map((r) => r.success)).toEqual([true, true, false, true]);
  });

  // Each test call's callData is `0x0000000<index>`, so the node can recover the
  // batch's indexes from its 32-byte calldata words.
  const batchIndexes = (data) =>
    data
      .slice(10)
      .match(/.{64}/g)
      .filter((word) => /^0000000[0-9a-f]0{56}$/.test(word))
      .map((word) => Number.parseInt(word.slice(0, 8), 16));

  it("bisects a size-capped batch and keeps order", async () => {
    const call = vi.fn(async (_url, _method, [{ data }]) => {
      const ids = batchIndexes(data);
      if (ids.length > 2) throw new Error("response size exceeded");
      return encodeResults(ids.map((id) => ({ success: true, data: w(id.toString(16)) })));
    });
    const out = await aggregateCalls("https://rpc", calls(4), { call });
    expect(call.mock.calls.length).toBeGreaterThan(1);
    expect(out.map((r) => Number.parseInt(r.returnData, 16))).toEqual([1, 2, 3, 4]);
  });

  it("does not bisect a transport failure: one call, then rejects", async () => {
    const call = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(aggregateCalls("https://rpc", calls(10), { call })).rejects.toThrow("fetch failed");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not bisect an HTTP 503 from the endpoint", async () => {
    const call = vi.fn(async () => {
      throw new Error("RPC HTTP 503: Service Unavailable");
    });
    await expect(aggregateCalls("https://rpc", calls(10), { call })).rejects.toThrow("RPC HTTP 503");
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("isTransportError", () => {
  it.each(["fetch failed", "connect ECONNREFUSED", "RPC HTTP 429: Too Many", "RPC HTTP 503"])("treats %j as transport", (message) => {
    expect(isTransportError(new Error(message))).toBe(true);
  });

  it("treats timeout and abort error names as transport", () => {
    expect(isTransportError(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }))).toBe(true);
    expect(isTransportError(Object.assign(new Error("signal"), { name: "AbortError" }))).toBe(true);
  });

  it.each(["execution reverted", "response size exceeded", "RPC HTTP 400: bad"])("treats %j as batch-shape (not transport)", (message) => {
    expect(isTransportError(new Error(message))).toBe(false);
  });
});
