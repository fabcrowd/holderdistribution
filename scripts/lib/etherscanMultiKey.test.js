import { describe, expect, it, vi } from "vitest";
import { balanceAtBlock, createEtherscanKeyPool, fetchAddressTransfers, fetchContractLogs, keysFromEnv, normalizeTokenTx } from "./etherscanMultiKey.js";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);

describe("keysFromEnv", () => {
  it("reads the base key plus numbered siblings in order", () => {
    const keys = keysFromEnv({ ETHERSCAN_API_KEY: "k0", ETHERSCAN_API_KEY_1: "k1", ETHERSCAN_API_KEY_2: "k2" });
    expect(keys).toEqual(["k0", "k1", "k2"]);
  });

  it("stops at the first gap in the numbered sequence", () => {
    // ETHERSCAN_API_KEY_2 set without _1 present is a likely typo, not a key
    // to silently skip past — stopping at the gap surfaces it instead.
    const keys = keysFromEnv({ ETHERSCAN_API_KEY: "k0", ETHERSCAN_API_KEY_2: "k2" });
    expect(keys).toEqual(["k0"]);
  });

  it("returns an empty array when nothing is set", () => {
    expect(keysFromEnv({})).toEqual([]);
  });
});

describe("createEtherscanKeyPool", () => {
  it("throws when given no keys", () => {
    expect(() => createEtherscanKeyPool([])).toThrow();
  });

  it("round-robins across keys in order", async () => {
    const pool = createEtherscanKeyPool(["a", "b", "c"], { delayMs: 0 });
    const acquired = [await pool.acquire(), await pool.acquire(), await pool.acquire(), await pool.acquire()];
    expect(acquired).toEqual(["a", "b", "c", "a"]);
  });

  it("does not throttle a fresh key against a different key's recent use", async () => {
    // Both keys start unused (lastUsedAt = -Infinity), so back-to-back
    // acquisitions of DIFFERENT keys must both resolve without waiting —
    // only reacquiring the SAME key before delayMs has passed should wait.
    const start = performance.now();
    const pool = createEtherscanKeyPool(["a", "b"], { delayMs: 400 });
    await pool.acquire(); // key a
    await pool.acquire(); // key b — independent budget, must not wait on a's
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("throttles reacquiring the same key before delayMs has passed", async () => {
    let clock = 1000;
    const pool = createEtherscanKeyPool(["solo"], { delayMs: 400, now: () => clock });
    await pool.acquire(); // marks lastUsedAt = 1000 at real speed (no wait, fresh)
    clock += 100; // only 100ms of the required 400ms has passed
    const before = Date.now();
    await pool.acquire(); // must really wait out the remaining ~300ms
    expect(Date.now() - before).toBeGreaterThanOrEqual(290);
  });
});

describe("normalizeTokenTx", () => {
  it("normalizes a tokentx row into the shared transfer shape", () => {
    const result = normalizeTokenTx({ from: A.toUpperCase(), to: B, value: "500", blockNumber: "100" });
    expect(result).toEqual({ from: A, to: B, value: 500n, blockNumber: "0x64" });
  });

  it("returns null for a row with no parseable value", () => {
    expect(normalizeTokenTx({ from: A, to: B, value: "not-a-number", blockNumber: "1" })).toBeNull();
  });

  it("returns null for a row missing blockNumber", () => {
    expect(normalizeTokenTx({ from: A, to: B, value: "1" })).toBeNull();
  });
});

describe("fetchAddressTransfers", () => {
  const pool = createEtherscanKeyPool(["k"], { delayMs: 0 });

  it("paginates via startblock advance and stops on a short page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "1",
          result: Array.from({ length: 3 }, (_, i) => ({ from: A, to: B, value: "1", blockNumber: String(i + 1) })),
        }),
      });
    const results = await fetchAddressTransfers(pool, {
      chainId: 137,
      address: A,
      contractAddress: "0xtoken",
      fetchImpl,
    });
    expect(results).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps paginating when a page returns a full 1000 rows", async () => {
    // Regression guard for the actual bug found via a live sanity check: the
    // API returns exactly 1000 rows with status "1"/"OK" even when a larger
    // `offset` was requested, and this function's old PAGE_SIZE (10000) made
    // that look like a short — i.e. final — page, silently truncating any
    // address with more than 1000 transfers.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: "1",
          result: Array.from({ length: 1000 }, (_, i) => ({ from: A, to: B, value: "1", blockNumber: String(i + 1) })),
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "0", message: "No transactions found", result: [] }) });
    const results = await fetchAddressTransfers(pool, { chainId: 137, address: A, contractAddress: "0xtoken", fetchImpl });
    expect(results).toHaveLength(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toContain("startblock=1000");
  });

  it("stops cleanly on 'No transactions found' rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "0", message: "No transactions found", result: [] }),
    });
    const results = await fetchAddressTransfers(pool, { chainId: 1, address: A, contractAddress: "0xtoken", fetchImpl });
    expect(results).toEqual([]);
  });

  it("throws on a genuine API error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "0", message: "Invalid API Key", result: [] }),
    });
    await expect(
      fetchAddressTransfers(pool, { chainId: 1, address: A, contractAddress: "0xtoken", fetchImpl }),
    ).rejects.toThrow(/Invalid API Key/);
  });
});

describe("fetchContractLogs", () => {
  const pool = createEtherscanKeyPool(["k"], { delayMs: 0 });

  it("returns raw log rows unmodified, in Etherscan's native shape", async () => {
    const row = { topics: ["0xtopic0", "0xaccount"], data: "0xdeadbeef", blockNumber: "0x64" };
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "1", result: [row] }) });
    const results = await fetchContractLogs(pool, { chainId: 137, address: "0xcontract", topic0: "0xtopic0", fetchImpl });
    expect(results).toEqual([row]);
  });

  it("paginates via startblock advance on a full page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          // 1000 rows, matching the real hard cap verified against a live
          // key (requesting offset=10000 still only returns 1000 rows) —
          // an earlier version of this test used 10_000 here, which passed
          // even after PAGE_SIZE itself regressed to the wrong value, since
          // the mock never has to reflect the API's real per-page ceiling.
          status: "1",
          result: Array.from({ length: 1000 }, (_, i) => ({ topics: [], data: "0x", blockNumber: String(i + 1) })),
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "0", message: "No records found", result: [] }) });
    const results = await fetchContractLogs(pool, { chainId: 1, address: "0xc", topic0: "0xt", fetchImpl });
    expect(results).toHaveLength(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = fetchImpl.mock.calls[1][0];
    expect(secondUrl).toContain("fromBlock=1000");
  });

  it("retries the same page on 'Unexpected error, timeout or server too busy' instead of failing", async () => {
    // Regression: this exact message killed a real scan outright — it wasn't
    // one of the two messages previously special-cased as "no more data",
    // nor the one literal string special-cased as "retry".
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "0", message: "Unexpected error, timeout or server too busy. Please try again later", result: null }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "1", result: [{ topics: [], data: "0x", blockNumber: "0x1" }] }) });
    const results = await fetchContractLogs(pool, { chainId: 1, address: "0xc", topic0: "0xt", fetchImpl });
    expect(results).toHaveLength(1);
    // 1 transient retry + 1 successful short page (which terminates
    // pagination immediately, being under PAGE_SIZE) — no third call.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("still retries on the literal 'Max rate limit reached' inline error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "0", result: "Max rate limit reached" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "0", message: "No records found", result: [] }) });
    const results = await fetchContractLogs(pool, { chainId: 1, address: "0xc", topic0: "0xt", fetchImpl });
    expect(results).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("still fails fast on a genuinely fatal (non-transient) error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "0", message: "Invalid API Key", result: [] }) });
    await expect(fetchContractLogs(pool, { chainId: 1, address: "0xc", topic0: "0xt", fetchImpl })).rejects.toThrow(/Invalid API Key/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly on no results without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "0", message: "No records found", result: [] }) });
    expect(await fetchContractLogs(pool, { chainId: 1, address: "0xc", topic0: "0xt", fetchImpl })).toEqual([]);
  });
});

describe("balanceAtBlock", () => {
  it("nets incoming minus outgoing up to and including the target block", () => {
    const transfers = [
      { from: null, to: A, value: 100n, blockNumber: "0x1" },
      { from: A, to: B, value: 30n, blockNumber: "0x2" },
      { from: null, to: A, value: 50n, blockNumber: "0x5" }, // after target — excluded
    ];
    expect(balanceAtBlock(transfers, A, 2)).toBe(70n);
  });

  it("returns 0 when the address never appears", () => {
    const transfers = [{ from: null, to: B, value: 100n, blockNumber: "0x1" }];
    expect(balanceAtBlock(transfers, A, 10)).toBe(0n);
  });

  it("accepts a hex atBlock", () => {
    const transfers = [{ from: null, to: A, value: 10n, blockNumber: "0x10" }];
    expect(balanceAtBlock(transfers, A, "0x10")).toBe(10n);
  });
});
