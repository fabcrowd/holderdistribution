import { describe, expect, it, vi } from "vitest";
import { classifyTransfers, listSignatures, pairTransfers, scanVenueFlows, utcDay } from "./flowScan.js";
import { markPartialDay } from "../partialDay.js";
import { applyFlowEvents, buildExchangeHistory, buildSolanaTierDays, emptyFlowStore } from "./flowFeeds.js";

// Responses are modelled on the jsonParsed getTransaction / getSignaturesForAddress
// shapes of the public mainnet endpoint (checked live 2026-10-29); addresses are
// synthetic but valid-looking base58, case preserved.
const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const MEXC = "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ";
const GATE = "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w";
const POOL = "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w";
const VAULT = "HJqK7re4GDSm4roQQS2iSLt5p7Gyb9MHBy9dHJw9obUp";
const VAULT_ATA = "3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo";
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const ATA = { [MEXC]: "MexcAta1", [GATE]: "GateAta1", [POOL]: "PoolAta1" };
const silent = { log: vi.fn(), warn: vi.fn() };

const roles = () => ({ cex: new Map([[MEXC, "MEXC"], [GATE, "Gate.io"]]), dex: new Set([POOL]), staking: new Set([VAULT, VAULT_ATA]) });
const moves = (...triples) => triples.map(([from, to, raw]) => ({ from, to, raw: BigInt(raw) }));

/** meta balances for owners: [{owner, pre, post}] (each its own token account). */
const tx = (rows, { keys = [] } = {}) => ({
  transaction: { message: { accountKeys: [...keys] } },
  meta: {
    err: null,
    preTokenBalances: rows.map((r, i) => ({ accountIndex: i, mint: MINT, owner: r.owner, uiTokenAmount: { amount: String(r.pre) } })),
    postTokenBalances: rows.map((r, i) => ({ accountIndex: i, mint: MINT, owner: r.owner, uiTokenAmount: { amount: String(r.post) } })),
  },
});

describe("pairTransfers", () => {
  it("pairs gains with losses and leaves mint/burn legs unpaired", () => {
    expect(pairTransfers(new Map([[ALICE, -100n], [MEXC, 100n]]))).toEqual(moves([ALICE, MEXC, 100]));
    expect(pairTransfers(new Map([[ALICE, -30n], [MEXC, 50n]]))).toEqual(moves([ALICE, MEXC, 30], [null, MEXC, 20]));
    expect(pairTransfers(new Map([[ALICE, -30n]]))).toEqual(moves([ALICE, null, 30]));
  });
});

describe("classifyTransfers", () => {
  it("counts a CEX deposit and a withdrawal against the exchange", () => {
    const ev = classifyTransfers(moves([ALICE, MEXC, 500], [GATE, BOB, 70]), roles());
    expect(ev).toEqual([
      { kind: "cexIn", venue: "MEXC", counterparty: ALICE, raw: 500n },
      { kind: "cexOut", venue: "Gate.io", counterparty: BOB, raw: 70n },
    ]);
  });

  it("marks CEX to CEX as internal (not an in/out)", () => {
    expect(classifyTransfers(moves([MEXC, GATE, 900]), roles())).toEqual([{ kind: "internal", venue: "Gate.io", counterparty: MEXC, raw: 900n }]);
  });

  it("classifies a transfer through a staking vault, by owner or by listed token account", () => {
    expect(classifyTransfers(moves([VAULT, MEXC, 40]), roles())[0].kind).toBe("staking");
    const onlyAta = { ...roles(), staking: new Set([VAULT_ATA]) };
    const t = tx([{ owner: VAULT, pre: 100, post: 60 }, { owner: MEXC, pre: 0, post: 40 }], { keys: [{ pubkey: VAULT_ATA }, { pubkey: "MexcAta1" }] });
    expect(classifyTransfers(moves([VAULT, MEXC, 40]), onlyAta, t, MINT)[0].kind).toBe("staking");
    expect(classifyTransfers(moves([VAULT, MEXC, 40]), onlyAta)[0].kind).toBe("cexIn"); // unresolved without the tx
  });

  it("books pool flow only when the counterparty is not a CEX", () => {
    expect(classifyTransfers(moves([ALICE, POOL, 10], [POOL, BOB, 4], [POOL, MEXC, 3]), roles()).map((e) => e.kind)).toEqual(["dexIn", "dexOut", "cexIn"]);
  });
});

// ---- fake chain ----------------------------------------------------------

function fakeChain({ sigsByAccount, txs, accountsByOwner }) {
  const calls = { getTransaction: 0, getSignaturesForAddress: 0 };
  const call = async (method, params) => {
    calls[method] = (calls[method] ?? 0) + 1;
    if (method === "getTokenAccountsByOwner") return { value: (accountsByOwner[params[0]] ?? []).map((pubkey) => ({ pubkey })) };
    if (method === "getSignaturesForAddress") {
      const [account, opts] = params;
      const all = sigsByAccount[account] ?? [];
      let from = opts.before ? all.findIndex((s) => s.signature === opts.before) + 1 : 0;
      const rows = [];
      for (; from < all.length && rows.length < opts.limit; from += 1) {
        if (opts.until && all[from].signature === opts.until) break;
        rows.push({ err: null, ...all[from] });
      }
      return rows;
    }
    if (method === "getTransaction") return txs[params[0]] ?? null;
    throw new Error(`unexpected ${method}`);
  };
  return { call, calls };
}

const T0 = Date.parse("2026-10-25T10:00:00Z") / 1000;
const sig = (name, slot, dayOffset = 0) => ({ signature: name, slot, blockTime: T0 + dayOffset * 86400 });

// MEXC account: s4 (day 2) newest ... s1 (day 0) oldest. s3 is a MEXC->Gate.io move shared with Gate's account.
const world = () => ({
  accountsByOwner: { [MEXC]: [ATA[MEXC]], [GATE]: [ATA[GATE]], [POOL]: [ATA[POOL]] },
  sigsByAccount: {
    MexcAta1: [sig("s4", 400, 2), sig("s3", 300, 1), sig("s1", 100, 0)],
    GateAta1: [sig("s3", 300, 1)],
    PoolAta1: [sig("s2", 200, 0)],
  },
  txs: {
    s1: tx([{ owner: ALICE, pre: 5_000_000, post: 2_000_000 }, { owner: MEXC, pre: 0, post: 3_000_000 }]), // deposit 3.0 ZBCN
    s2: tx([{ owner: BOB, pre: 1_000_000, post: 0 }, { owner: POOL, pre: 0, post: 1_000_000 }]), // sale into pool
    s3: tx([{ owner: MEXC, pre: 9_000_000, post: 4_000_000 }, { owner: GATE, pre: 0, post: 5_000_000 }]), // internal
    s4: tx([{ owner: MEXC, pre: 4_000_000, post: 2_500_000 }, { owner: BOB, pre: 0, post: 1_500_000 }]), // withdrawal 1.5
  },
});

const scan = (chain, extra = {}) =>
  scanVenueFlows({
    call: chain.call, mint: MINT, cexWallets: [{ address: MEXC, exchange: "MEXC" }, { address: GATE, exchange: "Gate.io" }],
    dexOwners: [POOL], stakingAddresses: [VAULT], state: null, sinceSec: T0 - 3600, maxTx: 100, logger: silent, ...extra,
  });

describe("scanVenueFlows", () => {
  it("finds deposit, withdrawal, pool sale and an internal move, attributing a shared tx once", async () => {
    const chain = fakeChain(world());
    const res = await scan(chain);
    expect(chain.calls.getTransaction).toBe(4); // s3 appears in two accounts, fetched once
    const byKind = Object.fromEntries(res.events.map((e) => [e.signature, e.kind]));
    expect(byKind).toEqual({ s1: "cexIn", s2: "dexIn", s3: "internal", s4: "cexOut" });
    expect(res.remaining).toBe(0);
    expect(res.events.find((e) => e.signature === "s1")).toMatchObject({ date: "2026-10-25", raw: "3000000", counterparty: ALICE, venue: "MEXC" });
  });

  it("resumes from the checkpoint and is idempotent on re-run", async () => {
    const chain = fakeChain(world());
    const first = await scan(chain);
    const again = await scan(fakeChain(world()), { state: { accounts: first.accounts } });
    expect(again.events).toEqual([]);
    expect(again.accounts).toEqual(first.accounts);
    // A new transaction after the cursor is the only thing scanned.
    const w = world();
    w.sigsByAccount.MexcAta1.unshift(sig("s5", 500, 3));
    w.txs.s5 = tx([{ owner: ALICE, pre: 1_000_000, post: 0 }, { owner: MEXC, pre: 0, post: 1_000_000 }]);
    const next = fakeChain(w);
    const res = await scan(next, { state: { accounts: first.accounts } });
    expect(res.events.map((e) => e.signature)).toEqual(["s5"]);
    expect(next.calls.getTransaction).toBe(1);
  });

  it("works through a budget oldest-first across runs, losing nothing", async () => {
    const w = world();
    let state = null;
    const seen = [];
    for (let run = 0; run < 5; run += 1) {
      const res = await scan(fakeChain(w), { state, maxTx: 1 });
      seen.push(...res.events.map((e) => e.signature));
      state = { accounts: res.accounts };
      if (res.remaining === 0 && res.processed === 0) break;
    }
    expect(seen).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("never splits a slot across runs", async () => {
    const w = world();
    w.sigsByAccount.PoolAta1 = [sig("s2b", 100, 0), sig("s2", 200, 0)];
    w.txs.s2b = tx([{ owner: ALICE, pre: 2, post: 1 }, { owner: MEXC, pre: 0, post: 1 }]);
    const res = await scan(fakeChain(w), { maxTx: 1 });
    expect(res.processed).toBe(2); // s1 and s2b share slot 100
  });

  it("reports progress per chunk with advancing cursors", async () => {
    const progress = [];
    const res = await scan(fakeChain(world()), { chunkSize: 1, onProgress: (p) => progress.push(p) });
    expect(progress.map((p) => p.newEvents.map((e) => e.signature))).toEqual([["s1"], ["s2"], ["s3"], ["s4"]]);
    expect(progress.map((p) => p.processed)).toEqual([1, 2, 3, 4]);
    expect(progress[0].accounts.MexcAta1.until).toBe("s1");
    expect(progress[3].remaining).toBe(0);
    expect(progress.flatMap((p) => p.newEvents)).toEqual(res.events);
  });

  it("keeps earlier chunks when a later transaction fetch fails", async () => {
    const w = world();
    const chain = fakeChain(w);
    const flaky = async (method, params) => {
      if (method === "getTransaction" && params[0] === "s3") throw new Error("every RPC endpoint failed");
      return chain.call(method, params);
    };
    const progress = [];
    await expect(scan({ call: flaky }, { chunkSize: 1, onProgress: (p) => progress.push(p) })).rejects.toThrow(/every RPC endpoint failed/);
    expect(progress.map((p) => p.processed)).toEqual([1, 2]);
    expect(progress[1].accounts.MexcAta1.until).toBe("s1");
  });

  it("stops at the deadline without losing the cursor", async () => {
    const chain = fakeChain(world());
    const res = await scan(chain, { deadlineMs: Date.now() - 1 });
    expect(res.timedOut).toBe(true);
    expect(res.processed).toBe(0);
    expect(chain.calls.getTransaction).toBe(0);
    expect(res.remaining).toBeGreaterThan(0);
  });

  it("skips failed transactions and counts unavailable ones", async () => {
    const w = world();
    w.sigsByAccount.MexcAta1[0] = { ...w.sigsByAccount.MexcAta1[0], err: { InstructionError: [0, "x"] } };
    delete w.txs.s1;
    const res = await scan(fakeChain(w));
    expect(res.events.map((e) => e.signature).sort()).toEqual(["s2", "s3"]);
    expect(res.missing).toBe(1);
  });
});

describe("listSignatures", () => {
  it("pages with before and stops at the floor", async () => {
    const rows = [sig("a", 5, 3), sig("b", 4, 2), sig("c", 3, 1), sig("d", 2, 0), sig("e", 1, -2)];
    const { call, calls } = fakeChain({ sigsByAccount: { X: rows }, txs: {}, accountsByOwner: {} });
    const out = await listSignatures(call, "X", { sinceSec: T0 - 3600, pageSize: 2 });
    expect(out.map((s) => s.signature)).toEqual(["a", "b", "c", "d"]);
    expect(calls.getSignaturesForAddress).toBe(3);
  });
});

describe("feeds", () => {
  const events = (list) => list.map((e) => ({ date: utcDay(T0), ...e }));
  it("scales raw by decimals, excludes internal/staking", () => {
    const store = emptyFlowStore();
    applyFlowEvents(store, "solana", events([
      { kind: "cexIn", venue: "MEXC", counterparty: ALICE, raw: "3000000" },
      { kind: "cexOut", venue: "MEXC", counterparty: BOB, raw: "1500000" },
      { kind: "internal", venue: "Gate.io", counterparty: MEXC, raw: "9000000" },
      { kind: "staking", venue: "MEXC", counterparty: VAULT, raw: "7000000" },
      { kind: "dexIn", venue: "dex", counterparty: BOB, raw: "1000000" },
    ]));
    const rows = buildExchangeHistory(store, { decimals: 6 });
    expect(rows).toEqual([{
      date: "2026-10-25", chains: { solana: { in: 3, out: 1.5, dexIn: 1, dexOut: 0 } },
      in: 3, out: 2, net: 2, dexIn: 1, dexOut: 0, dexNet: 1,
    }]);
    // The open UTC day is flagged by the shared helper, like TEL's last row.
    expect(markPartialDay(rows, new Date("2026-10-25T12:00:00Z"))[0].partial).toBe(true);
    expect(markPartialDay(rows, new Date("2026-10-26T00:00:01Z"))[0].partial).toBeUndefined();
    // Idempotent rebuild from the same store.
    expect(buildExchangeHistory(store, { decimals: { solana: 6 } })).toEqual(rows);
  });

  it("builds tier buckets only for real snapshot dates and tiered counterparties", () => {
    const store = emptyFlowStore();
    applyFlowEvents(store, "solana", [
      { date: "2026-10-24", kind: "cexIn", venue: "MEXC", counterparty: ALICE, raw: "1000000" },
      { date: "2026-10-25", kind: "cexIn", venue: "MEXC", counterparty: ALICE, raw: "3000000" },
      { date: "2026-10-25", kind: "dexIn", venue: "dex", counterparty: BOB, raw: "2000000" },
      { date: "2026-10-25", kind: "cexOut", venue: "MEXC", counterparty: BOB, raw: "500000" },
      { date: "2026-10-25", kind: "cexIn", venue: "MEXC", counterparty: "Unknown", raw: "9000000" },
    ]);
    const tiers = new Map([[ALICE, "1M-5M"], [BOB, "250K-1M"]]);
    const days = buildSolanaTierDays(store, { decimals: 6, firstSnapshotDate: "2026-10-25", tierAt: () => tiers });
    expect([...days.keys()]).toEqual(["2026-10-25"]);
    const d = days.get("2026-10-25");
    expect(d["1M-5M"]).toMatchObject({ cex: 3, byExchange: { MEXC: 3 }, dex: 0 });
    expect(d["250K-1M"]).toMatchObject({ dex: 2, dexSwap: 2, inflows: { cex: 0.5, dex: 0 } });
    expect(d["250K-1M"].byChain.solana.inflows.cex).toBe(0.5);
  });
});
