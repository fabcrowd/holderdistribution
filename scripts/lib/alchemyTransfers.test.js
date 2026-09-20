import { describe, expect, it, vi } from "vitest";
import { callGetAssetTransfers, fetchAllTransfers, normalizeTransfer } from "./alchemyTransfers.js";

const A = "0x" + "A".repeat(40);
const B = "0x" + "B".repeat(40);
const ZERO = "0x0000000000000000000000000000000000000000";

const transfer = (overrides = {}) => ({
  from: A,
  to: B,
  blockNum: "0x64",
  rawContract: { value: "0x64", address: "0xtoken", decimal: "0x2" },
  ...overrides,
});

describe("normalizeTransfer", () => {
  it("normalizes addresses to lowercase and parses the raw hex value as BigInt", () => {
    const result = normalizeTransfer(transfer());
    expect(result).toEqual({
      from: A.toLowerCase(),
      to: B.toLowerCase(),
      value: 100n,
      blockNumber: "0x64",
      transactionHash: null,
    });
  });

  it("carries transactionHash through, so a cached transfer can still be receipt-classified", () => {
    // Without this, generate-tier-outflows.js cannot split dexSwap vs dexLp
    // from a cached row, which is what forced every scanner to re-fetch the
    // same logs. See tasks/rpc-dedup-design.md.
    const hash = "0x" + "d".repeat(64);
    expect(normalizeTransfer(transfer({ hash })).transactionHash).toBe(hash);
  });

  it("leaves transactionHash null when absent, so readers can detect a pre-field cached row", () => {
    expect(normalizeTransfer(transfer()).transactionHash).toBeNull();
  });

  it("nulls the from/to leg that is the zero address (mint/burn)", () => {
    expect(normalizeTransfer(transfer({ from: ZERO })).from).toBeNull();
    expect(normalizeTransfer(transfer({ to: ZERO })).to).toBeNull();
  });

  it("ignores Alchemy's own pre-decoded `value` field entirely", () => {
    // Deliberately using rawContract.value + our own known decimals, not
    // Alchemy's decoded float — see the module header for why.
    const result = normalizeTransfer(transfer({ value: 999.999 }));
    expect(result.value).toBe(100n);
  });

  it("returns null when rawContract.value is missing or malformed", () => {
    expect(normalizeTransfer(transfer({ rawContract: {} }))).toBeNull();
    expect(normalizeTransfer(transfer({ rawContract: { value: "not-hex" } }))).toBeNull();
  });

  it("returns null when blockNum is missing", () => {
    expect(normalizeTransfer(transfer({ blockNum: undefined }))).toBeNull();
  });
});

describe("callGetAssetTransfers", () => {
  it("posts the alchemy_getAssetTransfers method and returns the result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ result: { transfers: [], pageKey: null } }),
    });
    const result = await callGetAssetTransfers("https://rpc", { fromBlock: "0x0" }, fetchImpl);
    expect(result).toEqual({ transfers: [], pageKey: null });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.method).toBe("alchemy_getAssetTransfers");
    expect(body.params).toEqual([{ fromBlock: "0x0" }]);
  });

  it("throws immediately on a non-transient RPC error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ error: { message: "invalid params" } }),
    });
    await expect(callGetAssetTransfers("https://rpc", {}, fetchImpl)).rejects.toThrow(/invalid params/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a transient rate-limit error and returns the eventual success", async () => {
    // Regression: a live rebuild run hit exactly this message after 375,000
    // transfers on one shard and died outright — see the module header.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ error: { message: "Rate limit exceeded" } }) })
      .mockResolvedValueOnce({ json: async () => ({ error: { message: "Rate limit exceeded" } }) })
      .mockResolvedValueOnce({ json: async () => ({ result: { transfers: [], pageKey: null } }) });
    const delayImpl = vi.fn().mockResolvedValue(undefined);

    const result = await callGetAssetTransfers("https://rpc", {}, fetchImpl, delayImpl);
    expect(result).toEqual({ transfers: [], pageKey: null });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(delayImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially between transient retries, capped at 60s", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ error: { message: "timeout" } }) });
    const delayImpl = vi.fn().mockResolvedValue(undefined);
    await expect(callGetAssetTransfers("https://rpc", {}, fetchImpl, delayImpl)).rejects.toThrow(/exceeded 12 retries/);
    expect(delayImpl.mock.calls.map((c) => c[0])).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000, 60000, 60000,
    ]);
  });

  it("gives up after the retry ceiling on a persistent transient error, naming the last error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ error: { message: "rate limit" } }) });
    const delayImpl = vi.fn().mockResolvedValue(undefined);
    await expect(callGetAssetTransfers("https://rpc", {}, fetchImpl, delayImpl)).rejects.toThrow(
      /exceeded 12 retries on transient errors — last: rate limit/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(13); // initial attempt + 12 retries
  });

  it("logs each retry attempt so an eventual exhaustion is diagnosable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ error: { message: "rate limit exceeded" } }) })
      .mockResolvedValueOnce({ json: async () => ({ result: { transfers: [], pageKey: null } }) });
    await callGetAssetTransfers("https://rpc", {}, fetchImpl, vi.fn().mockResolvedValue(undefined));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rate limit exceeded"));
    warn.mockRestore();
  });

  it("retries a truncated response body instead of dying on the parse error", async () => {
    // Regression: a live rebuild run hit "Unexpected end of JSON input" from
    // response.json() after 400,000+ transfers on one shard under sustained
    // load — a dropped connection, not a JSON-RPC error object.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } })
      .mockResolvedValueOnce({ json: async () => ({ result: { transfers: [], pageKey: null } }) });
    const delayImpl = vi.fn().mockResolvedValue(undefined);

    const result = await callGetAssetTransfers("https://rpc", {}, fetchImpl, delayImpl);
    expect(result).toEqual({ transfers: [], pageKey: null });
    expect(delayImpl).toHaveBeenCalledTimes(1);
  });

  it("retries when fetch itself throws (connection reset)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ json: async () => ({ result: { transfers: [], pageKey: null } }) });
    const delayImpl = vi.fn().mockResolvedValue(undefined);

    const result = await callGetAssetTransfers("https://rpc", {}, fetchImpl, delayImpl);
    expect(result).toEqual({ transfers: [], pageKey: null });
  });

  it("gives up after the retry ceiling on a persistent network failure, naming the last error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const delayImpl = vi.fn().mockResolvedValue(undefined);
    await expect(callGetAssetTransfers("https://rpc", {}, fetchImpl, delayImpl)).rejects.toThrow(
      /exceeded 12 retries on transient errors — last: network error: fetch failed/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(13);
  });
});

describe("fetchAllTransfers", () => {
  it("follows pageKey until exhausted and normalizes every transfer", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ result: { transfers: [transfer()], pageKey: "page2" } }) })
      .mockResolvedValueOnce({ json: async () => ({ result: { transfers: [transfer()], pageKey: null } }) });

    const results = await fetchAllTransfers("https://rpc", {
      fromBlock: 0,
      toBlock: 100,
      contractAddress: "0xtoken",
      fetchImpl,
    });

    expect(results).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondBody.params[0].pageKey).toBe("page2");
  });

  it("converts numeric block inputs to hex for the request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ result: { transfers: [], pageKey: null } }) });
    await fetchAllTransfers("https://rpc", { fromBlock: 256, toBlock: 512, contractAddress: "0xtoken", fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.params[0].fromBlock).toBe("0x100");
    expect(body.params[0].toBlock).toBe("0x200");
  });

  it("resumes from a supplied pageKey instead of starting over", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ result: { transfers: [], pageKey: null } }) });
    await fetchAllTransfers("https://rpc", {
      fromBlock: 0,
      toBlock: 100,
      contractAddress: "0xtoken",
      resumePageKey: "resume-here",
      fetchImpl,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.params[0].pageKey).toBe("resume-here");
  });

  it("calls onPage after every page with the running count and next cursor", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ result: { transfers: [transfer()], pageKey: "p2" } }) })
      .mockResolvedValueOnce({ json: async () => ({ result: { transfers: [transfer(), transfer()], pageKey: null } }) });
    const onPage = vi.fn();
    await fetchAllTransfers("https://rpc", { fromBlock: 0, toBlock: 100, contractAddress: "0xtoken", onPage, fetchImpl });
    expect(onPage).toHaveBeenNthCalledWith(1, 1, "p2");
    expect(onPage).toHaveBeenNthCalledWith(2, 3, null);
  });

  it("skips malformed transfers within a page rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ result: { transfers: [transfer(), { garbage: true }], pageKey: null } }),
    });
    const results = await fetchAllTransfers("https://rpc", { fromBlock: 0, toBlock: 100, contractAddress: "0xtoken", fetchImpl });
    expect(results).toHaveLength(1);
  });
});
