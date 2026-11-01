import { describe, expect, it, vi } from "vitest";
import { getTransactionAnyVersion, unsupportedVersionFrom } from "./getTransaction.js";

const versionError = (n) =>
  new Error(`solana getTransaction: every RPC endpoint failed. [https://x: Transaction version (${n}) is not supported by the requesting client. Please try the request again]`);

describe("unsupportedVersionFrom", () => {
  it("reads the version the node named", () => {
    expect(unsupportedVersionFrom(versionError(1))).toBe(1);
    expect(unsupportedVersionFrom(versionError(2))).toBe(2);
  });

  it("ignores other errors and out-of-range versions", () => {
    expect(unsupportedVersionFrom(new Error("HTTP 429"))).toBeNull();
    expect(unsupportedVersionFrom(versionError(0))).toBeNull();
    expect(unsupportedVersionFrom(versionError(9999))).toBeNull();
    expect(unsupportedVersionFrom(undefined)).toBeNull();
  });
});

describe("getTransactionAnyVersion", () => {
  it("asks for version 0 first and returns that result", async () => {
    const call = vi.fn(async () => ({ slot: 1 }));
    await expect(getTransactionAnyVersion(call, "sig")).resolves.toEqual({ slot: 1 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1][1]).toMatchObject({ maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "finalized" });
  });

  it("retries once with the version the node named", async () => {
    const call = vi.fn().mockRejectedValueOnce(versionError(1)).mockResolvedValueOnce({ slot: 2 });
    await expect(getTransactionAnyVersion(call, "sig")).resolves.toEqual({ slot: 2 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][1][1].maxSupportedTransactionVersion).toBe(1);
  });

  it("does not retry other errors", async () => {
    const call = vi.fn().mockRejectedValue(new Error("HTTP 500"));
    await expect(getTransactionAnyVersion(call, "sig")).rejects.toThrow("HTTP 500");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("surfaces the second failure instead of looping", async () => {
    const call = vi.fn().mockRejectedValue(versionError(1));
    await expect(getTransactionAnyVersion(call, "sig")).rejects.toThrow(/version \(1\)/);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
