import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NULL_TX_RETRY_RUNS, scanVenueFlows } from "./flowScan.js";
import { FlowBackupCapError, createFlowBackupCall, flowBackupMonthlyCap, flowBackupUrls, redactBackupText } from "./flowBackup.js";
import { getAllRpcUrls } from "../rpc.js";
import { __resetBudgetGuardForTests, __resetRpcMetricsForTests, ALCHEMY_CU, alchemyBlocked, estimateUsage, guardAlchemyCall, monthlySolanaBackupCu, snapshotCalls } from "../rpcMetrics.js";
import { aggregateRuns, evaluateBudget, mergeUsage, monthToDate, renderSummary } from "../runMetricsSummary.js";
import { projectStatus } from "../../write-pipeline-status.js";
import { __resetSupportedVersionForTests } from "./getTransaction.js";
import { __resetSolanaRpcForTests, notAlchemy, solanaCallWithFailover, solanaRpcCandidates } from "./rpc.js";

// Fake URLs only; the real ones live in .env.enc.
const ALCH0 = "https://solana-mainnet.g.alchemy.com/v2/FAKEKEY0";
const ALCH1 = "https://solana-mainnet.g.alchemy.com/v2/FAKEKEY1";
const HELIUS = "https://mainnet.helius-rpc.com/?api-key=FAKEHELIUS";
const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const MEXC = "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ";
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const T0 = Date.parse("2026-10-25T10:00:00Z") / 1000;
const silent = { log: vi.fn(), warn: vi.fn() };

const jsonResponse = (result, init = {}) => ({ ok: true, status: 200, json: async () => ({ result }), ...init });
const httpError = (status) => ({ ok: false, status, json: async () => ({}) });
const noSleep = async () => {};

const deposit = (raw) => ({
  transaction: { message: { accountKeys: [] } },
  meta: {
    err: null,
    preTokenBalances: [{ accountIndex: 0, mint: MINT, owner: ALICE, uiTokenAmount: { amount: String(raw) } }, { accountIndex: 1, mint: MINT, owner: MEXC, uiTokenAmount: { amount: "0" } }],
    postTokenBalances: [{ accountIndex: 0, mint: MINT, owner: ALICE, uiTokenAmount: { amount: "0" } }, { accountIndex: 1, mint: MINT, owner: MEXC, uiTokenAmount: { amount: String(raw) } }],
  },
});

/** Primary "Helius" chain for the scan: two signatures on one MEXC token account. */
function primaryChain({ failTx = new Set(), nullTx = new Set(), failAll = false } = {}) {
  const calls = [];
  const sigs = [{ signature: "s1", slot: 100, blockTime: T0, err: null }, { signature: "s2", slot: 200, blockTime: T0 + 60, err: null }];
  const call = async (method, params) => {
    calls.push(method);
    if (method === "getTokenAccountsByOwner") return { value: [{ pubkey: "MexcAta1" }] };
    if (method === "getSignaturesForAddress") return [...sigs].reverse();
    if (method === "getTransaction") {
      if (failAll || failTx.has(params[0])) throw new Error("every RPC endpoint failed. HTTP 429");
      return nullTx.has(params[0]) ? null : deposit(1000);
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, calls };
}

const scan = (call, extra = {}) =>
  scanVenueFlows({
    call, mint: MINT, cexWallets: [{ address: MEXC, exchange: "MEXC" }], dexOwners: [], stakingAddresses: [], state: null,
    sinceSec: T0 - 3600, maxTx: 100, chunkSize: 1, logger: silent, ...extra,
  });

beforeEach(() => {
  __resetRpcMetricsForTests();
  __resetSupportedVersionForTests();
  silent.warn.mockClear();
  silent.log.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

const backupEnv = { SOLANA_FLOW_RPC_0: ALCH0, SOLANA_FLOW_RPC_1: ALCH1 };
const makeBackup = (fetchImpl, extra = {}) =>
  createFlowBackupCall({ env: backupEnv, fetchImpl, logger: silent, sleep: noSleep, capCu: 10_000_000, usedBeforeRun: () => 0, pool: () => ({ used: 0, ceiling: Infinity }), ...extra });

describe("flow backup keys", () => {
  it("reads SOLANA_FLOW_RPC_n in slot order, ignores blanks and non-Alchemy hosts, and is null when unset", () => {
    expect(flowBackupUrls({ SOLANA_FLOW_RPC_1: ALCH1, SOLANA_FLOW_RPC_0: ` ${ALCH0}/ `, SOLANA_FLOW_RPC_2: "", SOLANA_FLOW_RPC_3: HELIUS })).toEqual([ALCH0, ALCH1]);
    expect(createFlowBackupCall({ env: {}, logger: silent })).toBeNull();
    expect(createFlowBackupCall({ env: { SOLANA_FLOW_RPC_0: "  " }, logger: silent })).toBeNull();
  });

  it("the monthly cap is config/budgets.json solanaBackupAlchemyCu (10M)", () => {
    expect(flowBackupMonthlyCap()).toBe(10_000_000);
  });
});

describe("other Solana paths keep refusing Alchemy", () => {
  it("SOLANA_FLOW_RPC_* never reaches the general pool, and Alchemy URLs are still dropped or refused", async () => {
    vi.stubEnv("SOLANA_FLOW_RPC_0", ALCH0);
    vi.stubEnv("SOLANA_FLOW_RPC_1", ALCH1);
    vi.stubEnv("SOLANA_RPC_0", ALCH0); // even an Alchemy URL in the regular key slot is dropped
    __resetSolanaRpcForTests();
    expect(getAllRpcUrls("solana")).not.toContain(ALCH1);
    expect(solanaRpcCandidates("solana").some((u) => !notAlchemy(u))).toBe(false);
    expect(solanaRpcCandidates("solana")).not.toContain(ALCH1);
    const call = vi.fn();
    await expect(solanaCallWithFailover([ALCH0, ALCH1], "getTransaction", ["s"], { call, logger: silent })).rejects.toThrow(/every RPC endpoint failed/);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("Alchemy backup call", () => {
  it("tries SOLANA_FLOW_RPC_0 then _1, meters under its own provider at 40 CU, and returns a genuine null", async () => {
    const urls = [];
    const fetchImpl = vi.fn(async (url) => {
      urls.push(url);
      return url === ALCH0 ? httpError(400) : jsonResponse(null);
    });
    const backup = makeBackup(fetchImpl);
    expect(await backup("getTransaction", ["sig"])).toBeNull();
    expect(urls).toEqual([ALCH0, ALCH1]);
    expect(snapshotCalls()["alchemy-solana"]).toEqual({ getTransaction: 2 });
    expect(snapshotCalls().alchemy).toBeUndefined();
    expect(ALCHEMY_CU.getTransaction).toBe(40);
    expect(ALCHEMY_CU.getSignaturesForAddress).toBe(40);
    expect(estimateUsage(snapshotCalls())).toMatchObject({ alchemyCu: 80, solanaBackupCu: 80, alchemyCalls: 2 });
  });

  it("serves getTransaction only: listing and account lookups are refused and never sent", async () => {
    const fetchImpl = vi.fn();
    const backup = makeBackup(fetchImpl);
    for (const method of ["getSignaturesForAddress", "getTokenAccountsByOwner", "getSlot"]) {
      await expect(backup(method, [])).rejects.toThrow(/not allowed/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries a 429 on the SAME key and meters every attempt, not just the first", async () => {
    const urls = [];
    const fetchImpl = vi.fn(async (url) => {
      urls.push(url);
      return urls.length === 1 ? httpError(429) : jsonResponse({ ok: 1 });
    });
    expect(await makeBackup(fetchImpl)("getTransaction", ["s"])).toEqual({ ok: 1 });
    expect(urls).toEqual([ALCH0, ALCH0]);
    expect(snapshotCalls()["alchemy-solana"]).toEqual({ getTransaction: 2 });
    expect(estimateUsage(snapshotCalls()).solanaBackupCu).toBe(80);
  });

  it("treats a throttle error inside an HTTP 200 like a 429", async () => {
    const urls = [];
    const fetchImpl = vi.fn(async (url) => {
      urls.push(url);
      return urls.length === 1 ? { ok: true, status: 200, json: async () => ({ error: { code: 429, message: "Too Many Requests" } }) } : jsonResponse("x");
    });
    expect(await makeBackup(fetchImpl)("getTransaction", ["s"])).toBe("x");
    expect(urls).toEqual([ALCH0, ALCH0]);
  });

  it("never puts the key URL in an error or log: HTTP failure, network error, or provider text that echoes it", async () => {
    const down = makeBackup(vi.fn(async () => httpError(500)));
    const e1 = await down("getTransaction", ["s"]).catch((e) => e);
    expect(e1.message).toMatch(/SOLANA_FLOW_RPC_0: HTTP 500 \| SOLANA_FLOW_RPC_1: HTTP 500/);
    const net = makeBackup(vi.fn(async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); }));
    const e2 = await net("getTransaction", ["s"]).catch((e) => e);
    expect(e2.message).toMatch(/network error/);
    const echo = makeBackup(vi.fn(async (url) => ({ ok: true, status: 200, json: async () => ({ error: { code: -32602, message: `bad params for ${url}` } }) })));
    const e3 = await echo("getTransaction", ["s"]).catch((e) => e);
    expect(e3.message).toMatch(/\[redacted\]/);
    const everything = [e1.message, e2.message, e3.message, JSON.stringify(silent.warn.mock.calls), JSON.stringify(silent.log.mock.calls)].join("\n");
    expect(everything).not.toMatch(/FAKEKEY|alchemy\.com/);
  });


  it("redacts every URL form a provider could echo: https, wss, bare host, /v2/<key>, and the literal configured URL or key", async () => {
    const forms = [
      "https://solana-mainnet.g.alchemy.com/v2/OTHERKEY99",
      "wss://solana-mainnet.g.alchemy.com/v2/OTHERKEY99",
      "solana-mainnet.g.alchemy.com/v2/OTHERKEY99",
      "see /v2/OTHERKEY99 for details",
      "https://rpc.example.org/key/ZZZKEY123456",
      `literal ${ALCH0}`,
      "literal key FAKEKEY0",
      "literal key FAKEKEY1 in text",
    ];
    for (const form of forms) {
      const echo = makeBackup(vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32602, message: form } }) })));
      const err = await echo("getTransaction", ["s"]).catch((e) => e);
      expect(err.message, form).not.toMatch(/OTHERKEY99|ZZZKEY|example\.org|FAKEKEY|alchemy\.com/);
      expect(err.message, form).toMatch(/SOLANA_FLOW_RPC_0/);
    }
    const logged = JSON.stringify(silent.warn.mock.calls);
    expect(logged).not.toMatch(/OTHERKEY99|FAKEKEY|alchemy\.com/);
    expect(redactBackupText("wss://x.g.alchemy.com/v2/KEYKEYKEY1 and x.g.alchemy.com/v2/KEYKEYKEY1")).not.toMatch(/KEYKEYKEY1|alchemy/);
  });

  it("an outage is logged once per distinct reason with its SOLANA_FLOW_RPC_n label and no key, and a genuine null is not", async () => {
    const genuine = makeBackup(vi.fn(async () => jsonResponse(null)));
    await genuine("getTransaction", ["s"]);
    expect(silent.warn).not.toHaveBeenCalled();
    const outage = makeBackup(vi.fn(async () => httpError(401)));
    for (let i = 0; i < 3; i += 1) await outage("getTransaction", [`s${i}`]).catch(() => {});
    const warned = silent.warn.mock.calls.map((c) => c[0]).filter((m) => m.startsWith("::warning::Solana flow backup (Alchemy) failed"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/SOLANA_FLOW_RPC_0: HTTP 401 \| SOLANA_FLOW_RPC_1: HTTP 401/);
    expect(warned[0]).not.toMatch(/FAKEKEY|alchemy\.com/);
    const net = makeBackup(vi.fn(async (url) => { throw new Error(`connect ECONNREFUSED ${url}`); }));
    await net("getTransaction", ["s"]).catch(() => {});
    expect(silent.warn.mock.calls.map((c) => c[0]).filter((m) => /network error/.test(m))).toHaveLength(1);
    expect(JSON.stringify(silent.warn.mock.calls)).not.toMatch(/FAKEKEY|alchemy\.com/);
  });

  it("only real throttles inside an HTTP 200 are retried: -32005 and generic 'exceeded ... limit' text are not", async () => {
    for (const error of [
      { code: -32005, message: "Limit exceeded: query returned more than 10000 results" },
      { code: -32602, message: "Invalid param: slot exceeded the limit of the ledger" },
    ]) {
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ error }) }));
      await expect(makeBackup(fetchImpl)("getTransaction", ["s"])).rejects.toThrow(/SOLANA_FLOW_RPC_0: .*SOLANA_FLOW_RPC_1: /);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // one attempt per key, no retry
    }
    const urls = [];
    const throttled = vi.fn(async (url) => {
      urls.push(url);
      return urls.length === 1 ? { ok: true, status: 200, json: async () => ({ error: { code: -32007, message: "Your app has exceeded its compute units per second capacity" } }) } : jsonResponse("x");
    });
    expect(await makeBackup(throttled)("getTransaction", ["s"])).toBe("x");
    expect(urls).toEqual([ALCH0, ALCH0]);
  });

  it("the cap also holds on retries: a second attempt past the cap is not sent", async () => {
    const fetchImpl = vi.fn(async () => httpError(429));
    const backup = makeBackup(fetchImpl, { capCu: 60, usedBeforeRun: () => 0 });
    await expect(backup("getTransaction", ["s"])).rejects.toBeInstanceOf(FlowBackupCapError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends every request with an abort timeout", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null));
    await makeBackup(fetchImpl)("getTransaction", ["s"]);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("stops at the monthly cap with a named warning, sends nothing, and stays off", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null));
    const backup = makeBackup(fetchImpl, { usedBeforeRun: () => 9_999_970 });
    await expect(backup("getTransaction", ["s"])).rejects.toBeInstanceOf(FlowBackupCapError);
    await expect(backup("getTransaction", ["t"])).rejects.toBeInstanceOf(FlowBackupCapError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(silent.warn.mock.calls.map((c) => c[0]).filter((m) => /cap 10,000,000 CU/.test(m))).toHaveLength(1);
  });

  it("the cap counts this run's own spend: it is crossed mid-run", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(null));
    const backup = makeBackup(fetchImpl, { capCu: 100, usedBeforeRun: () => 0 });
    await backup("getTransaction", ["a"]); // 40
    await backup("getTransaction", ["b"]); // 80
    await expect(backup("getTransaction", ["c"])).rejects.toBeInstanceOf(FlowBackupCapError); // 120 > 100
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops when the shared Alchemy pool would be exceeded, counting this run's spend", async () => {
    const backup = makeBackup(vi.fn(async () => jsonResponse(null)), { pool: () => ({ used: 0, ceiling: 100 }) });
    await backup("getTransaction", ["a"]);
    await backup("getTransaction", ["b"]);
    await expect(backup("getTransaction", ["c"])).rejects.toThrow(/shared Alchemy pool ceiling/);
    const full = makeBackup(vi.fn(), { pool: () => ({ used: 29_999_990, ceiling: 30_000_000 }) });
    await expect(full("getTransaction", ["s"])).rejects.toThrow(/shared Alchemy pool ceiling/);
  });

  it("the default pool check includes Alchemy CU that earlier processes of this run already spent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowbackup-"));
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config/budgets.json"), JSON.stringify({ monthly: { alchemyCu: 1000, solanaBackupAlchemyCu: 5000 } }));
    const file = path.join(root, "m.ndjson");
    fs.writeFileSync(file, `${JSON.stringify({ pid: -1, alchemyCu: 980 })}\n`);
    __resetBudgetGuardForTests();
    const fetchImpl = vi.fn();
    const backup = createFlowBackupCall({ env: { ...backupEnv, HD_METRICS_FILE: file }, root, fetchImpl, logger: silent, sleep: noSleep });
    await expect(backup("getTransaction", ["s"])).rejects.toThrow(/shared Alchemy pool ceiling 1,000/);
    expect(fetchImpl).not.toHaveBeenCalled();
    __resetBudgetGuardForTests();
  });
});

describe("month-to-date reads", () => {
  it("monthlySolanaBackupCu sums solanaBackupCu (not alchemyCu) of this UTC month in every project file, plus earlier processes of this run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowbackup-"));
    fs.mkdirSync(path.join(root, "data/zebec"), { recursive: true });
    fs.writeFileSync(path.join(root, "data/rpc-usage.json"), JSON.stringify({ days: { "2026-11-01": { alchemyCu: 5000, solanaBackupCu: 70 }, "2026-10-31": { alchemyCu: 9, solanaBackupCu: 9000 } } }));
    fs.writeFileSync(path.join(root, "data/zebec/rpc-usage.json"), JSON.stringify({ days: { "2026-11-05": { alchemyCu: 7000, solanaBackupCu: 30 } } }));
    const file = path.join(root, "m.ndjson");
    fs.writeFileSync(file, `${JSON.stringify({ pid: -1, alchemyCu: 900, solanaBackupCu: 5 })}\n${JSON.stringify({ pid: process.pid, solanaBackupCu: 1000 })}\n`);
    expect(monthlySolanaBackupCu(root, new Date("2026-11-08T00:00:00Z"), { HD_METRICS_FILE: file })).toBe(105);
    expect(monthlySolanaBackupCu(root, new Date("2026-11-08T00:00:00Z"), {})).toBe(100);
  });
});

describe("scanVenueFlows with the Alchemy backup", () => {
  const backupTx = () => vi.fn(async () => jsonResponse(deposit(1000)));

  it("Helius OK: the backup is never called and results match a scan without it", async () => {
    const withBackup = primaryChain();
    const backupCall = vi.fn();
    const res = await scan(withBackup.call, { backupCall });
    const baseline = primaryChain();
    const plain = await scan(baseline.call);
    expect(backupCall).not.toHaveBeenCalled();
    expect(res.events).toEqual(plain.events);
    expect(withBackup.calls).toEqual(baseline.calls);
  });

  it("no SOLANA_FLOW_RPC_* set: no backup is built and the scan is exactly today's", async () => {
    const backupCall = createFlowBackupCall({ env: {}, logger: silent });
    expect(backupCall).toBeNull();
    const a = primaryChain({ nullTx: new Set(["s2"]) });
    const b = primaryChain({ nullTx: new Set(["s2"]) });
    const withNull = await scan(a.call, { backupCall });
    const without = await scan(b.call);
    expect(withNull).toEqual(without);
    expect(a.calls).toEqual(b.calls);
    expect(withNull.accounts.MexcAta1.until).toBe("s1");
  });

  it("Helius throttled (429) then Alchemy returns the transaction: served by the backup", async () => {
    const chain = primaryChain({ failTx: new Set(["s1"]) });
    const fetchImpl = backupTx();
    const res = await scan(chain.call, { backupCall: makeBackup(fetchImpl) });
    expect(res.events.map((e) => e.signature)).toEqual(["s1", "s2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(snapshotCalls()["alchemy-solana"]).toEqual({ getTransaction: 1 });
  });

  it("Helius threw and the backup answers null: the primary error aborts the chunk, the cursor stays, no attempt is charged, night after night", async () => {
    let state = null;
    for (let night = 1; night <= 3; night += 1) {
      const chain = primaryChain({ failTx: new Set(["s1"]) });
      const progress = [];
      const backupCall = makeBackup(vi.fn(async () => jsonResponse(null)));
      await expect(scan(chain.call, { backupCall, state, onProgress: (p) => progress.push(p) })).rejects.toThrow(/every RPC endpoint failed. HTTP 429/);
      expect(progress).toEqual([]); // nothing saved: cursor stays below s1
      expect(state).toBeNull();
    }
  });

  it("Helius threw and the backup errors or is capped: the primary error is rethrown", async () => {
    const chain = primaryChain({ failTx: new Set(["s1"]) });
    const broken = makeBackup(vi.fn(async () => httpError(500)));
    await expect(scan(chain.call, { backupCall: broken })).rejects.toThrow(/every RPC endpoint failed. HTTP 429/);
    const capped = makeBackup(vi.fn(), { usedBeforeRun: () => 10_000_000 });
    await expect(scan(chain.call, { backupCall: capped })).rejects.toThrow(/every RPC endpoint failed. HTTP 429/);
    expect(silent.warn.mock.calls.some((c) => /monthly cap 10,000,000 CU/.test(c[0]))).toBe(true);
  });

  it("a later chunk's failure keeps the earlier chunks' cursor", async () => {
    const chain = primaryChain({ failTx: new Set(["s2"]) });
    const progress = [];
    const backupCall = makeBackup(vi.fn(async () => httpError(500)));
    await expect(scan(chain.call, { backupCall, onProgress: (p) => progress.push(p) })).rejects.toThrow(/Alchemy backup|HTTP 429/);
    expect(progress).toHaveLength(1);
    expect(progress[0].accounts.MexcAta1.until).toBe("s1");
  });

  it("listing and account lookups never use the backup: they fail exactly as before", async () => {
    for (const broken of ["getSignaturesForAddress", "getTokenAccountsByOwner"]) {
      const chain = primaryChain();
      const call = async (method, params) => {
        if (method === broken) throw new Error("every RPC endpoint failed");
        return chain.call(method, params);
      };
      const fetchImpl = vi.fn();
      await expect(scan(call, { backupCall: makeBackup(fetchImpl) })).rejects.toThrow(/every RPC endpoint failed$/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("a healthy-Helius null is held without touching the backup until the final attempt", async () => {
    const fetchImpl = backupTx();
    const chain = primaryChain({ nullTx: new Set(["s1"]) });
    const res = await scan(chain.call, { backupCall: makeBackup(fetchImpl) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.events).toEqual([]);
    expect(res.accounts.MexcAta1.until).toBeNull();
    expect(res.unavailable[0]).toMatchObject({ signature: "s1", attempts: 1 });
  });

  it("on the final attempt the backup is asked once; a hit is kept and not recorded missing", async () => {
    const fetchImpl = backupTx();
    const state = { accounts: {}, unavailable: [{ signature: "s1", slot: 100, blockTime: T0, attempts: NULL_TX_RETRY_RUNS - 1 }] };
    const res = await scan(primaryChain({ nullTx: new Set(["s1"]) }).call, { backupCall: makeBackup(fetchImpl), state });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.events.map((e) => e.signature)).toEqual(["s1", "s2"]);
    expect(res.missing).toBe(0);
    expect(res.unavailable).toEqual([]);
  });

  it("on the final attempt a backup null, error or cap leaves the existing give-up behaviour", async () => {
    const state = () => ({ accounts: {}, unavailable: [{ signature: "s1", slot: 100, blockTime: T0, attempts: NULL_TX_RETRY_RUNS - 1 }] });
    for (const backupCall of [makeBackup(vi.fn(async () => jsonResponse(null))), makeBackup(vi.fn(async () => httpError(500))), makeBackup(vi.fn(), { usedBeforeRun: () => 10_000_000 })]) {
      const res = await scan(primaryChain({ nullTx: new Set(["s1"]) }).call, { backupCall, state: state() });
      expect(res.missing).toBe(1);
      expect(res.events.map((e) => e.signature)).toEqual(["s2"]);
      expect(res.unavailable[0]).toMatchObject({ signature: "s1", attempts: NULL_TX_RETRY_RUNS });
    }
  });

  it("a null with one run already spent (attempts=1) is still held and the backup is not asked", async () => {
    const fetchImpl = backupTx();
    const state = { accounts: {}, unavailable: [{ signature: "s1", slot: 100, blockTime: T0, attempts: 1 }] };
    const res = await scan(primaryChain({ nullTx: new Set(["s1"]) }).call, { backupCall: makeBackup(fetchImpl), state });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.missing).toBe(0);
    expect(res.accounts.MexcAta1.until).toBeNull();
    expect(res.unavailable[0]).toMatchObject({ signature: "s1", attempts: 2 });
  });

  it("a give-up null behind a held slot is not sent to the backup (the result would be discarded)", async () => {
    const fetchImpl = backupTx();
    const state = { accounts: {}, unavailable: [{ signature: "s2", slot: 200, blockTime: T0 + 60, attempts: NULL_TX_RETRY_RUNS - 1 }] };
    const res = await scan(primaryChain({ nullTx: new Set(["s1", "s2"]) }).call, { backupCall: makeBackup(fetchImpl), state, chunkSize: 2 });
    expect(fetchImpl).not.toHaveBeenCalled(); // s1 (slot 100) is held, s2 (slot 200) sits behind it
    expect(res.accounts.MexcAta1.until).toBeNull();
    expect(res.missing).toBe(0);
  });

  it("the final-attempt backup lookup is a normal getTransaction request and survives a version bump", async () => {
    const bodies = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.params[1].maxSupportedTransactionVersion < 2) return { ok: true, status: 200, json: async () => ({ error: { code: -32015, message: "Transaction version (2) is not supported by the requesting client" } }) };
      return jsonResponse(deposit(1000));
    });
    const state = { accounts: {}, unavailable: [{ signature: "s1", slot: 100, blockTime: T0, attempts: NULL_TX_RETRY_RUNS - 1 }] };
    const res = await scan(primaryChain({ nullTx: new Set(["s1"]) }).call, { backupCall: makeBackup(fetchImpl), state });
    expect(bodies[0]).toMatchObject({ method: "getTransaction", params: ["s1", { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "finalized" }] });
    expect(bodies.at(-1).params[1].maxSupportedTransactionVersion).toBe(2);
    expect(res.events.map((e) => e.signature)).toEqual(["s1", "s2"]);
    expect(res.missing).toBe(0);
  });
});

describe("production wiring", () => {
  const scripts = path.resolve(import.meta.dirname, "../..");
  const read = (rel) => fs.readFileSync(path.join(scripts, rel), "utf8");

  it("scan-solana-flows.js builds the backup and passes it to scanVenueFlows (source check: the script runs against live RPC and writes data, so it is not executed)", () => {
    const src = read("scan-solana-flows.js");
    expect(src).toMatch(/const backupCall = createFlowBackupCall\(\)/);
    expect(src).toMatch(/scanVenueFlows\(\{[^}]*\bbackupCall\b[^}]*\}\)/s);
  });

  it("no other script or lib module reads SOLANA_FLOW_RPC_* or imports the backup", () => {
    const allowed = new Set(["scan-solana-flows.js", "lib/solana/flowBackup.js", "lib/solana/flowBackup.test.js"]);
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
          const rel = path.relative(scripts, full).split(path.sep).join("/");
          if (!allowed.has(rel) && /SOLANA_FLOW_RPC|(?:from|import\()\s*["'][^"']*flowBackup/.test(fs.readFileSync(full, "utf8"))) hits.push(rel);
        }
      }
    };
    walk(scripts);
    expect(hits).toEqual([]);
  });
});

describe("budget interaction", () => {
  const jobEnv = { HD_JOB_ID: "solana-flows", HD_JOB_ALCHEMY_CU_BUDGET: "0", HD_JOB_BUDGET_MODE: "enforce", HD_HAS_EVM: "false" };

  it("a 0-CU enforced job budget does not block the backup, and backup CU never counts against EVM job budgets", async () => {
    __resetBudgetGuardForTests();
    for (const [k, v] of Object.entries(jobEnv)) vi.stubEnv(k, v);
    expect(alchemyBlocked()).toBe(true);
    await makeBackup(vi.fn(async () => jsonResponse(null)))("getTransaction", ["s"]);
    const evmJob = { HD_JOB_ID: "exchange-flows", HD_JOB_ALCHEMY_CU_BUDGET: "30", HD_JOB_BUDGET_MODE: "enforce" };
    expect(() => guardAlchemyCall("eth_call", evmJob)).not.toThrow(); // 26 CU fits 30; the 40 CU backup call is not counted
  });

  it("a job's budget sum over earlier processes excludes their backup CU", () => {
    __resetBudgetGuardForTests();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flowbackup-")), "m.ndjson");
    fs.writeFileSync(file, `${JSON.stringify({ job: "t", project: "p", pid: -1, alchemyCu: 100, solanaBackupCu: 80 })}\n`);
    const env = { HD_JOB_ID: "t", HD_PROJECT: "p", HD_METRICS_FILE: file, HD_JOB_ALCHEMY_CU_BUDGET: "50", HD_JOB_BUDGET_MODE: "enforce" };
    expect(() => guardAlchemyCall("eth_call", env)).not.toThrow(); // 20 + 26 <= 50
    __resetBudgetGuardForTests();
  });

  it("backup CU is folded into alchemyCu and reported separately only when used", () => {
    const line = JSON.stringify({ script: "scan-solana-flows.js", pid: 1, alchemyCu: 120, solanaBackupCu: 80, alchemyCalls: 3, heliusCalls: 0, publicCalls: 0, heliusCredits: 0 });
    const agg = aggregateRuns([JSON.parse(line)]);
    expect(agg).toMatchObject({ alchemyCu: 120, solanaBackupCu: 80 });
    expect(agg.byScript["scan-solana-flows.js"].solanaBackupCu).toBe(80);
    const usage = mergeUsage(mergeUsage(null, "2026-11-08", agg), "2026-11-08", agg);
    expect(usage.days["2026-11-08"]).toMatchObject({ alchemyCu: 240, solanaBackupCu: 160 });
    const plain = mergeUsage(null, "2026-11-08", aggregateRuns([JSON.parse(JSON.stringify({ script: "a.js", pid: 2, alchemyCu: 5 }))]));
    expect(plain.days["2026-11-08"]).not.toHaveProperty("solanaBackupCu");
    expect(plain.days["2026-11-08"].byScript["a.js"]).not.toHaveProperty("solanaBackupCu");
    expect(estimateUsage({ alchemy: { eth_call: 1 } })).not.toHaveProperty("solanaBackupCu");
  });

  it("the run summary shows backup CU against the cap when used, and nothing extra when not", () => {
    const budgets = { monthly: { alchemyCu: 30_000_000, heliusCredits: 1_000_000, solanaBackupAlchemyCu: 10_000_000 }, warnAt: 0.8, failAt: 1 };
    const agg = { alchemyCu: 400, solanaBackupCu: 400, alchemyCalls: 10, heliusCalls: 0, publicCalls: 0, heliusCredits: 0, byScript: {} };
    const usage = { days: { "2026-11-08": { alchemyCu: 8_500_000, solanaBackupCu: 8_500_000, heliusCredits: 0 } } };
    const evaluation = evaluateBudget(monthToDate([usage], "2026-11"), agg, budgets);
    expect(evaluation.rows.find((r) => r.key === "solanaBackupCu")).toMatchObject({ used: 8_500_000, budget: 10_000_000, run: 400, percent: 85 });
    expect(evaluation.messages.some((m) => /Solana flow backup: 85%/.test(m.text))).toBe(true);
    expect(renderSummary({ project: "p", date: "2026-11-08", agg, evaluation })).toMatch(/Solana flow backup.*8,500,000 CU \(85%\).*10,000,000 cap/);
    const none = evaluateBudget(monthToDate([{ days: { "2026-11-08": { alchemyCu: 5, heliusCredits: 0 } } }], "2026-11"), { ...agg, solanaBackupCu: 0 }, budgets);
    expect(none.rows).toHaveLength(2);
  });

  it("pipeline status does not call backup CU an over-budget Alchemy night for a 0-CU job", () => {
    const usage = { day: "2026-11-08", byScript: { "scan-solana-flows.js": { alchemyCu: 80, solanaBackupCu: 80 } } };
    const row = projectStatus("zebec-network", { usage }).jobs.find((j) => j.id === "solana-flows");
    expect(row.alchemyCuLatest).toEqual({ day: "2026-11-08", cu: 0 });
    expect(row.health).not.toBe("over-budget");
  });
});
