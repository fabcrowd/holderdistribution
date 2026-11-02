import { describe, expect, it, vi } from "vitest";
import { scanWalletFlows } from "./walletFlowScan.js";
import { STABLE_MINTS } from "./knownMints.js";

// jsonParsed shapes as in flowScan.test.js; addresses are synthetic but valid-looking base58.
const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const MEXC = "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ";
const POOL = "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w";
const ALICE_ATA = "AliceAta1";
const BOB_ATA = "BobAta1";
const NOW = Date.parse("2026-11-01T12:00:00Z") / 1000;
const DAY = 86400;

const accounts = [{ wallet: ALICE, tokenAccount: ALICE_ATA }, { wallet: BOB, tokenAccount: BOB_ATA }];
const roles = () => ({
  wallets: new Set([ALICE, BOB]),
  cex: new Map([[MEXC, "MEXC"]]),
  dex: new Set([POOL]),
  staking: new Set(),
});
const silent = { log: vi.fn(), warn: vi.fn() };

/** meta token balances for owners: [{owner, pre, post}] (each its own token account). */
const tx = (rows) => ({
  transaction: { message: { accountKeys: [] } },
  meta: {
    err: null,
    preTokenBalances: rows.map((r, i) => ({ accountIndex: i, mint: MINT, owner: r.owner, uiTokenAmount: { amount: String(r.pre) } })),
    postTokenBalances: rows.map((r, i) => ({ accountIndex: i, mint: MINT, owner: r.owner, uiTokenAmount: { amount: String(r.post) } })),
  },
});

/** getSignaturesForAddress row: newest first within an account; `daysAgo` sets blockTime. */
const sig = (name, slot, daysAgo) => ({ signature: name, slot, blockTime: NOW - daysAgo * DAY });

function fakeChain(world) {
  const fetched = [];
  const call = async (method, params) => {
    if (method === "getSignaturesForAddress") {
      const [account, opts] = params;
      const all = world.sigsByAccount[account] ?? [];
      let from = opts.before ? all.findIndex((s) => s.signature === opts.before) + 1 : 0;
      const rows = [];
      for (; from < all.length && rows.length < opts.limit; from += 1) {
        if (opts.until && all[from].signature === opts.until) break;
        rows.push({ err: null, ...all[from] });
      }
      return rows;
    }
    if (method === "getTransaction") {
      fetched.push(params[0]);
      return world.txs[params[0]] ?? null;
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, fetched };
}

// ALICE_ATA (newest first): a3 (slot 300) internal to BOB, a1 (slot 100) deposit to MEXC.
// BOB_ATA: b2 (slot 200) sale into POOL.
const world = () => ({
  sigsByAccount: {
    [ALICE_ATA]: [sig("a3", 300, 1), sig("a1", 100, 3)],
    [BOB_ATA]: [sig("b2", 200, 2)],
  },
  txs: {
    a1: tx([{ owner: ALICE, pre: 5_000_000, post: 2_000_000 }, { owner: MEXC, pre: 0, post: 3_000_000 }]),
    b2: tx([{ owner: BOB, pre: 1_000_000, post: 0 }, { owner: POOL, pre: 0, post: 1_000_000 }]),
    a3: tx([{ owner: ALICE, pre: 2_000_000, post: 1_000_000 }, { owner: BOB, pre: 0, post: 1_000_000 }]),
  },
});

const run = (chain, { state = null, caps = {}, dryRun = false } = {}) =>
  scanWalletFlows({ call: chain.call, accounts, mint: MINT, roles: roles(), state, nowSec: NOW, caps, dryRun, logger: silent });

describe("scanWalletFlows", () => {
  it("dry run makes no getTransaction calls and only counts signatures", async () => {
    const chain = fakeChain(world());
    const state = { accounts: { [ALICE_ATA]: { wallet: ALICE, until: null } }, events: [] };
    const snapshot = structuredClone(state);
    const res = await run(chain, { state, dryRun: true });
    expect(chain.fetched).toEqual([]);
    expect(res.counts).toEqual({ signatures: 3, perWallet: { [ALICE]: 2, [BOB]: 1 }, transactions: 0 });
    // One listing call per account (1 + 1) plus one getTransaction credit per signature (3).
    expect(res.estimatedCredits).toBe(5);
    expect(res.state).toEqual(snapshot);
    expect(res.truncated).toBe(false);
  });

  it("processes every signature oldest first and classifies each outflow by destination", async () => {
    const chain = fakeChain(world());
    const res = await run(chain);
    expect(chain.fetched).toEqual(["a1", "b2", "a3"]);
    expect(res.counts).toEqual({ signatures: 3, processed: 3, missing: 0, transactions: 3 });
    expect(res.truncated).toBe(false);
    expect(res.state.events).toEqual([
      { wallet: ALICE, kind: "CEX", venue: "MEXC", dest: MEXC, raw: "3000000", t: NOW - 3 * DAY, sig: "a1" },
      { wallet: BOB, kind: "DEX", venue: "dex", dest: POOL, raw: "1000000", t: NOW - 2 * DAY, sig: "b2" },
      { wallet: ALICE, kind: "internal", venue: null, dest: BOB, raw: "1000000", t: NOW - DAY, sig: "a3" },
    ]);
    expect(res.state.accounts).toEqual({
      [ALICE_ATA]: { wallet: ALICE, until: "a3" },
      [BOB_ATA]: { wallet: BOB, until: "b2" },
    });
  });

  it("stops at maxTx and reports truncated", async () => {
    const chain = fakeChain(world());
    const res = await run(chain, { caps: { maxTx: 1 } });
    expect(chain.fetched).toEqual(["a1"]);
    expect(res.counts.processed).toBe(1);
    expect(res.truncated).toBe(true);
  });

  it("keeps a busy wallet to its oldest perWalletMax signatures", async () => {
    const w = world();
    w.sigsByAccount[ALICE_ATA] = [sig("c5", 50, 0), sig("c4", 40, 1), sig("c3", 30, 2), sig("c2", 20, 3), sig("c1", 10, 4)];
    for (const name of ["c1", "c2", "c3", "c4", "c5"]) w.txs[name] = tx([{ owner: ALICE, pre: 2_000_000, post: 1_000_000 }, { owner: MEXC, pre: 0, post: 1_000_000 }]);
    w.sigsByAccount[BOB_ATA] = [sig("b1", 60, 0)];
    w.txs.b1 = tx([{ owner: BOB, pre: 1_000_000, post: 0 }, { owner: POOL, pre: 0, post: 1_000_000 }]);
    const chain = fakeChain(w);
    const res = await run(chain, { caps: { perWalletMax: 2 } });
    expect(chain.fetched).toEqual(["c1", "c2"]);
    expect(res.truncated).toBe(true);
    expect(res.state.accounts[ALICE_ATA].until).toBe("c2");
    expect(res.state.accounts[BOB_ATA].until).toBeNull();
  });

  it("resumes from the returned state without refetching and matches a single full run", async () => {
    const full = await run(fakeChain(world()));
    const firstChain = fakeChain(world());
    const first = await run(firstChain, { caps: { maxTx: 2 } });
    expect(firstChain.fetched).toEqual(["a1", "b2"]);
    const nextChain = fakeChain(world());
    const second = await run(nextChain, { state: first.state });
    expect(nextChain.fetched).toEqual(["a3"]);
    expect(second.truncated).toBe(false);
    expect(second.state.events).toEqual(full.state.events);
    expect(second.state.accounts).toEqual(full.state.accounts);
  });

  it("drops events already in state when a chunk is re-delivered", async () => {
    const full = await run(fakeChain(world()));
    const replay = await run(fakeChain(world()), { state: { accounts: {}, events: full.state.events } });
    expect(replay.state.events).toHaveLength(3);
    expect(replay.state.events).toEqual(full.state.events);
  });

  it("counts a null getTransaction as missing and keeps going", async () => {
    const w = world();
    delete w.txs.b2;
    const res = await run(fakeChain(w));
    expect(res.counts).toMatchObject({ processed: 3, missing: 1, transactions: 2 });
    expect(res.state.events.map((e) => e.sig)).toEqual(["a1", "a3"]);
  });

  it("prunes events older than the 90-day window", async () => {
    const old = { wallet: ALICE, kind: "CEX", venue: "MEXC", dest: MEXC, raw: "1", t: NOW - 91 * DAY, sig: "ancient" };
    const recent = { ...old, t: NOW - 89 * DAY, sig: "recent" };
    const res = await run(fakeChain({ sigsByAccount: {}, txs: {} }), { state: { accounts: {}, events: [old, recent] } });
    expect(res.state.events).toEqual([recent]);
  });

  it("processes nothing when the deadline has already passed", async () => {
    const chain = fakeChain(world());
    const res = await run(chain, { caps: { deadlineMs: Date.now() - 1 } });
    expect(chain.fetched).toEqual([]);
    expect(res.counts.processed).toBe(0);
    expect(res.truncated).toBe(true);
    expect(res.state.events).toEqual([]);
    expect(res.state.accounts[ALICE_ATA].until).toBeNull();
  });
});

// Sales journal: BOB sells ZBCN into POOL and receives USDC in the same tx.
const USDC = STABLE_MINTS.USDC.mint;
const BOB_USDC_ATA = "BobUsdcAta";
const BOB_ZBCN_ATA = "BobZbcnAta";
const POOL_ZBCN_ATA = "PoolZbcnAta";

/** Swap tx: BOB's ZBCN account pays `sold` to POOL; BOB's USDC account gains `gained`. */
const swapTx = (sold, gained) => ({
  transaction: { message: { accountKeys: [BOB_ZBCN_ATA, BOB_USDC_ATA, POOL_ZBCN_ATA] } },
  meta: {
    err: null,
    preTokenBalances: [
      { accountIndex: 0, mint: MINT, owner: BOB, uiTokenAmount: { amount: String(sold), decimals: 6 } },
      { accountIndex: 1, mint: USDC, owner: BOB, uiTokenAmount: { amount: "0", decimals: 6 } },
      { accountIndex: 2, mint: MINT, owner: POOL, uiTokenAmount: { amount: "0", decimals: 6 } },
    ],
    postTokenBalances: [
      { accountIndex: 0, mint: MINT, owner: BOB, uiTokenAmount: { amount: "0", decimals: 6 } },
      { accountIndex: 1, mint: USDC, owner: BOB, uiTokenAmount: { amount: String(gained), decimals: 6 } },
      { accountIndex: 2, mint: MINT, owner: POOL, uiTokenAmount: { amount: String(sold), decimals: 6 } },
    ],
  },
});

const dexSaleWorld = () => ({
  sigsByAccount: { [BOB_ATA]: [sig("s1", 500, 1)] },
  txs: { s1: swapTx(1_000_000, 2_500_000) },
});

const twoSaleWorld = () => ({
  sigsByAccount: { [BOB_ATA]: [sig("s2", 600, 1), sig("s1", 500, 1)] },
  txs: { s1: swapTx(1_000_000, 2_500_000), s2: swapTx(3_000_000, 4_000_000) },
});

const emptyWorld = () => ({ sigsByAccount: {}, txs: {} });

/** Expected sale record for BOB's swap; `t` defaults to one day before NOW (the fixture blockTime). */
const saleFor = ({ sig: name, soldRaw = "1000000", gained = "2500000", t = NOW - DAY }) => ({
  sig: name,
  t,
  wallet: BOB,
  dex: [POOL],
  soldRaw,
  legs: [{ mint: USDC, raw: gained, decimals: 6, holder: "wallet", owner: BOB, account: BOB_USDC_ATA, source: "token" }],
});

const JOURNAL = () => ({ dexOwners: new Set([POOL]) });
const dexEventOf = (name) => ({ wallet: BOB, kind: "DEX", venue: "dex", dest: POOL, raw: "1000000", t: NOW - DAY, sig: name });

const runWith = (chain, { state = null, journal = null, dryRun = false } = {}) =>
  scanWalletFlows({ call: chain.call, accounts, mint: MINT, roles: roles(), state, nowSec: NOW, caps: {}, dryRun, logger: silent, journal });

describe("scanWalletFlows sales journal", () => {
  it("records one sale with its stablecoin leg when a DEX outflow and a USDC gain share a tx", async () => {
    const res = await runWith(fakeChain(dexSaleWorld()), { journal: JOURNAL() });
    expect(res.state.sales).toEqual([saleFor({ sig: "s1" })]);
    expect(res.state.events).toEqual([dexEventOf("s1")]);
  });

  it("keeps one sale when the same signature is delivered twice", async () => {
    const first = await runWith(fakeChain(dexSaleWorld()), { journal: JOURNAL() });
    const replay = await runWith(fakeChain(dexSaleWorld()), {
      state: { accounts: {}, events: first.state.events, sales: first.state.sales },
      journal: JOURNAL(),
    });
    expect(replay.state.sales).toEqual(first.state.sales);
    expect(replay.state.sales).toHaveLength(1);
  });

  it("returns no sales key and unchanged events when journal is null", async () => {
    const res = await runWith(fakeChain(dexSaleWorld()));
    expect(Object.keys(res.state).sort()).toEqual(["accounts", "events"]);
    expect(res.state.events).toEqual([dexEventOf("s1")]);
  });

  it("sums sold raw per wallet, so the sold total never exceeds the wallet's DEX event total", async () => {
    const res = await runWith(fakeChain(twoSaleWorld()), { journal: JOURNAL() });
    expect(res.state.sales.map((s) => s.sig)).toEqual(["s1", "s2"]);
    const soldTotal = res.state.sales.reduce((sum, s) => sum + BigInt(s.soldRaw), 0n);
    const dexTotal = res.state.events
      .filter((e) => e.wallet === BOB && e.kind === "DEX")
      .reduce((sum, e) => sum + BigInt(e.raw), 0n);
    expect(soldTotal).toBe(4_000_000n);
    expect(dexTotal).toBe(4_000_000n);
    expect(soldTotal <= dexTotal).toBe(true);
  });

  it("records no sale for a DEX outflow with no wallet gain", async () => {
    const res = await runWith(fakeChain(world()), { journal: JOURNAL() });
    expect(res.state.sales).toEqual([]);
    expect(res.state.events.some((e) => e.kind === "DEX")).toBe(true);
  });

  it("keeps previous sales and unrelated state keys such as follow", async () => {
    const oldSale = saleFor({ sig: "old1", soldRaw: "7", gained: "7", t: NOW - 5 * DAY });
    const state = { accounts: {}, events: [], sales: [oldSale], follow: { cursor: "x" } };
    const res = await runWith(fakeChain(dexSaleWorld()), { state, journal: JOURNAL() });
    expect(res.state.sales).toEqual([oldSale, saleFor({ sig: "s1" })]);
    expect(res.state.follow).toEqual({ cursor: "x" });
  });

  it("keeps previous sales when no new transactions are processed", async () => {
    const oldSale = saleFor({ sig: "old1", t: NOW - 5 * DAY });
    const res = await runWith(fakeChain(emptyWorld()), {
      state: { accounts: {}, events: [], sales: [oldSale] },
      journal: JOURNAL(),
    });
    expect(res.counts.processed).toBe(0);
    expect(res.state.sales).toEqual([oldSale]);
  });

  it("returns previous sales and other keys unchanged on a dry run", async () => {
    const state = { accounts: {}, events: [], sales: [saleFor({ sig: "old1", t: NOW - 5 * DAY })], follow: { cursor: "x" } };
    const snapshot = structuredClone(state);
    const res = await runWith(fakeChain(dexSaleWorld()), { state, dryRun: true, journal: JOURNAL() });
    expect(res.state).toEqual(snapshot);
  });

  it("prunes sales older than the 90-day window", async () => {
    const ancient = saleFor({ sig: "ancient", t: NOW - 91 * DAY });
    const recent = saleFor({ sig: "recent", t: NOW - 89 * DAY });
    const res = await runWith(fakeChain(emptyWorld()), {
      state: { accounts: {}, events: [], sales: [ancient, recent] },
      journal: JOURNAL(),
    });
    expect(res.state.sales).toEqual([recent]);
  });
});
