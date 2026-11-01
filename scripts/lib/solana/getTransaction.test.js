import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSupportedVersionForTests, getTransactionAnyVersion, unsupportedVersionFrom } from "./getTransaction.js";

const versionError = (n) =>
  new Error(`solana getTransaction: every RPC endpoint failed. [https://x: Transaction version (${n}) is not supported by the requesting client. Please try the request again]`);
const sentVersion = (call, i = 0) => call.mock.calls[i][1][1].maxSupportedTransactionVersion;

beforeEach(() => __resetSupportedVersionForTests());

describe("unsupportedVersionFrom", () => {
  it("reads a version above the current ceiling", () => {
    expect(unsupportedVersionFrom(versionError(2))).toBe(2);
    expect(unsupportedVersionFrom(versionError(7))).toBe(7);
  });

  it("ignores other errors, versions already supported, and out-of-range versions", () => {
    expect(unsupportedVersionFrom(new Error("HTTP 429"))).toBeNull();
    expect(unsupportedVersionFrom(versionError(1))).toBeNull();
    expect(unsupportedVersionFrom(versionError(0))).toBeNull();
    expect(unsupportedVersionFrom(versionError(9999))).toBeNull();
    expect(unsupportedVersionFrom(undefined)).toBeNull();
  });
});

describe("getTransactionAnyVersion", () => {
  it("asks for version 1 first, so legacy, v0 and v1 transactions all succeed in one call", async () => {
    const call = vi.fn(async () => ({ slot: 1 }));
    await expect(getTransactionAnyVersion(call, "sig")).resolves.toEqual({ slot: 1 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1][1]).toMatchObject({ maxSupportedTransactionVersion: 1, encoding: "jsonParsed", commitment: "finalized" });
  });

  it("raises the ceiling when a node names a higher version and keeps it for later calls", async () => {
    const call = vi.fn().mockRejectedValueOnce(versionError(2)).mockResolvedValue({ slot: 2 });
    await expect(getTransactionAnyVersion(call, "a")).resolves.toEqual({ slot: 2 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(sentVersion(call, 1)).toBe(2);
    await getTransactionAnyVersion(call, "b");
    expect(sentVersion(call, 2)).toBe(2);
  });

  it("does not retry other errors", async () => {
    const call = vi.fn().mockRejectedValue(new Error("HTTP 500"));
    await expect(getTransactionAnyVersion(call, "sig")).rejects.toThrow("HTTP 500");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("surfaces a second failure instead of looping", async () => {
    const call = vi.fn().mockRejectedValue(versionError(2));
    await expect(getTransactionAnyVersion(call, "sig")).rejects.toThrow(/version \(2\)/);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
