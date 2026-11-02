import { describe, expect, it } from "vitest";
import { createCallBudget } from "./callBudget.js";
import { followTask } from "./followFunds.js";

// jsonParsed shapes as in walletFlowScan.test.js; addresses are synthetic but valid-looking base58.
const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const BOB_LOWER = BOB.toLowerCase();
const MEXC = "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ";
const POOL = "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w";
const UNKNOWN = "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w";
const ALICE_ATA = "AliceAta1";
const BOB_ATA = "BobAta1";
const BOB_LOWER_ATA = "BobLowerAta1";
const MEXC_ATA = "MexcAta1";
const POOL_ATA = "PoolAta1";
const UNKNOWN_ATA = "UnknownAta1";
const NOW = Date.parse("2026-11-01T12:00:00Z") / 1000;
const DAY = 86400;

const roles = () => ({
  wallets: new Set([ALICE]),
  cex: new Map([[MEXC, "MEXC"]]),
  dex: new Set([POOL]),
  staking: new Set(),
});

/** Mint token balances: rows = [{ account, owner, pre, post }] at accountIndex = row index. */
const tx = (rows) => ({
  transaction: { message: { accountKeys: rows.map((r) => r.account) } },
  meta: {
    err: null,
    preTokenBalances: rows.map((r, i) => ({ accountIndex: i, mint: MINT, owner: r.owner, uiTokenAmount: { amount: String(r.pre), decimals: 6 } })),
    postTokenBalances: rows.map((r, i) => ({ accountIndex: i, mint: MINT, owner: r.owner, uiTokenAmount: { amount: String(r.post), decimals: 6 } })),
  },
});

/** Alice (5 -> 2) pays `amount` to the MEXC hot wallet. */
const aliceToMexc = (amount) =>
  tx([
    { account: ALICE_ATA, owner: ALICE, pre: 5_000_000, post: 5_000_000 - amount },
    { account: MEXC_ATA, owner: MEXC, pre: 0, post: amount },
  ]);

/** getSignaturesForAddress row, newest first in a listing; `daysAgo` sets blockTime. */
const sig = (name, slot, daysAgo) => ({ signature: name, slot, blockTime: NOW - daysAgo * DAY });

function fakeChain(world) {
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "getTokenAccountsByOwner") {
      const [owner] = params;
      return { value: (world.tokenAccounts?.[owner] ?? []).map((pubkey) => ({ pubkey })) };
    }
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
    if (method === "getTransaction") return world.txs[params[0]] ?? null;
    throw new Error(`unexpected ${method}`);
  };
  const fetched = () => calls.filter((c) => c.method === "getTransaction").map((c) => c.params[0]);
  return { call, calls, fetched };
}

const baseTask = (overrides = {}) => ({
  id: `trace|ref1|${ALICE}|${MINT}`,
  kind: "trace",
  ref: "ref1",
  rootWallet: ALICE,
  owner: ALICE,
  account: ALICE_ATA,
  mint: MINT,
  decimals: 6,
  sinceSec: NOW - 10 * DAY,
  remaining: "5000000",
  depth: 0,
  until: null,
  status: "open",
  ...overrides,
});

const follow = (call, task, extra = {}) => followTask({ call, task, roles: roles(), nowSec: NOW, ...extra });

describe("followTask", () => {
  it("turns a transfer from the owner to a CEX owner into a CEX hop", async () => {
    const chain = fakeChain({ sigsByAccount: { [ALICE_ATA]: [sig("s1", 100, 1)] }, txs: { s1: aliceToMexc(3_000_000) } });
    const res = await follow(chain.call, baseTask());
    expect(res.hops).toEqual([
      { taskId: baseTask().id, depth: 0, from: ALICE, to: MEXC, kind: "CEX", venue: "MEXC", mint: MINT, raw: "3000000", t: NOW - DAY, sig: "s1" },
    ]);
    expect(res.task).toMatchObject({ remaining: "2000000", until: "s1", status: "open" });
    expect(res.nextTasks).toEqual([]);
  });

  it("never emits hops whose raw sum exceeds remaining, clipping the last one", async () => {
    const world = {
      sigsByAccount: { [ALICE_ATA]: [sig("s2", 200, 0), sig("s1", 100, 1)] },
      txs: { s1: aliceToMexc(3_000_000), s2: aliceToMexc(3_000_000) },
    };
    const res = await follow(fakeChain(world).call, baseTask({ remaining: "4000000" }));
    const total = res.hops.reduce((sum, h) => sum + BigInt(h.raw), 0n);
    expect(res.hops.map((h) => h.raw)).toEqual(["3000000", "1000000"]);
    expect(total <= 4_000_000n).toBe(true);
    expect(res.task).toMatchObject({ remaining: "0", status: "done" });
  });

  it("returns busy with no getTransaction calls when a full page is listed", async () => {
    const page = Array.from({ length: 100 }, (_, i) => sig(`p${i}`, 1000 - i, 0.01 * (i + 1)));
    const chain = fakeChain({ sigsByAccount: { [ALICE_ATA]: page }, txs: {} });
    const task = baseTask();
    const res = await follow(chain.call, task);
    expect(res.task).toEqual({ ...task, status: "busy" });
    expect(res.hops).toEqual([]);
    expect(chain.fetched()).toEqual([]);
  });

  it("creates a next task for an unlabelled hop below maxDepth, with the recipient account", async () => {
    const world = {
      sigsByAccount: { [ALICE_ATA]: [sig("s1", 100, 1)] },
      txs: {
        s1: tx([
          { account: ALICE_ATA, owner: ALICE, pre: 5_000_000, post: 2_000_000 },
          { account: UNKNOWN_ATA, owner: UNKNOWN, pre: 0, post: 3_000_000 },
        ]),
      },
    };
    const res = await follow(fakeChain(world).call, baseTask());
    expect(res.hops).toHaveLength(1);
    expect(res.hops[0]).toMatchObject({ kind: "unlabelled", to: UNKNOWN });
    expect(res.nextTasks).toEqual([
      {
        id: `trace|ref1|${UNKNOWN}|${MINT}`,
        kind: "trace",
        ref: "ref1",
        rootWallet: ALICE,
        owner: UNKNOWN,
        account: UNKNOWN_ATA,
        mint: MINT,
        decimals: 6,
        sinceSec: NOW - DAY,
        remaining: "3000000",
        depth: 1,
        until: null,
        status: "open",
      },
    ]);
  });

  it("creates no next task at depth == maxDepth", async () => {
    const world = {
      sigsByAccount: { [ALICE_ATA]: [sig("s1", 100, 1)] },
      txs: {
        s1: tx([
          { account: ALICE_ATA, owner: ALICE, pre: 5_000_000, post: 2_000_000 },
          { account: UNKNOWN_ATA, owner: UNKNOWN, pre: 0, post: 3_000_000 },
        ]),
      },
    };
    const res = await follow(fakeChain(world).call, baseTask({ depth: 1 }), { maxDepth: 1 });
    expect(res.hops).toHaveLength(1);
    expect(res.nextTasks).toEqual([]);
  });

  it("on a rerun from the returned until, fetches only newer signatures", async () => {
    const world = {
      sigsByAccount: { [ALICE_ATA]: [sig("s2", 200, 0), sig("s1", 100, 1)] },
      txs: { s1: aliceToMexc(1_000_000), s2: aliceToMexc(2_000_000) },
    };
    const chain = fakeChain(world);
    const first = await follow(chain.call, baseTask({ remaining: "10000000" }), { maxTx: 1 });
    expect(chain.fetched()).toEqual(["s1"]);
    expect(first.task).toMatchObject({ until: "s1", status: "open" });

    const second = await follow(chain.call, first.task);
    const listings = chain.calls.filter((c) => c.method === "getSignaturesForAddress");
    expect(listings.at(-1).params[1].until).toBe("s1");
    expect(chain.fetched()).toEqual(["s1", "s2"]);
    expect(second.hops.map((h) => h.sig)).toEqual(["s2"]);
    expect(second.task.remaining).toBe("7000000");
  });

  it("returns the unchanged task with status budget when the call budget runs out", async () => {
    const world = {
      sigsByAccount: { [ALICE_ATA]: [sig("s2", 200, 0), sig("s1", 100, 1)] },
      txs: { s1: aliceToMexc(1_000_000), s2: aliceToMexc(1_000_000) },
    };
    const budget = createCallBudget(fakeChain(world).call, 2);
    const task = baseTask();
    const res = await follow(budget.call, task);
    expect(res.task).toEqual({ ...task, status: "budget" });
    expect(res.hops).toEqual([]);
    expect(res.nextTasks).toEqual([]);
  });

  it("does not mutate the input task", async () => {
    const world = { sigsByAccount: { [ALICE_ATA]: [sig("s1", 100, 1)] }, txs: { s1: aliceToMexc(3_000_000) } };
    const task = baseTask();
    const snapshot = structuredClone(task);
    const res = await follow(fakeChain(world).call, task);
    expect(task).toEqual(snapshot);
    expect(res.task).not.toBe(task);
  });

  it("treats owners differing only in case as separate owners", async () => {
    const shared = tx([
      { account: BOB_ATA, owner: BOB, pre: 1_000_000, post: 0 },
      { account: BOB_LOWER_ATA, owner: BOB_LOWER, pre: 2_000_000, post: 0 },
      { account: MEXC_ATA, owner: MEXC, pre: 0, post: 3_000_000 },
    ]);
    const world = {
      sigsByAccount: { [BOB_ATA]: [sig("x1", 100, 1)], [BOB_LOWER_ATA]: [sig("x1", 100, 1)] },
      txs: { x1: shared },
    };
    const chain = fakeChain(world);
    const upper = await follow(chain.call, baseTask({ owner: BOB, account: BOB_ATA, rootWallet: BOB, id: `trace|ref1|${BOB}|${MINT}` }));
    const lower = await follow(chain.call, baseTask({ owner: BOB_LOWER, account: BOB_LOWER_ATA, rootWallet: BOB, id: `trace|ref1|${BOB_LOWER}|${MINT}` }));
    expect(upper.hops.map((h) => [h.from, h.raw])).toEqual([[BOB, "1000000"]]);
    expect(lower.hops.map((h) => [h.from, h.raw])).toEqual([[BOB_LOWER, "2000000"]]);
  });

  it("resolves the first token account of the owner when the task has none", async () => {
    const world = {
      tokenAccounts: { [ALICE]: [ALICE_ATA] },
      sigsByAccount: { [ALICE_ATA]: [sig("s1", 100, 1)] },
      txs: { s1: aliceToMexc(3_000_000) },
    };
    const chain = fakeChain(world);
    const res = await follow(chain.call, baseTask({ account: null }));
    expect(chain.calls[0].method).toBe("getTokenAccountsByOwner");
    expect(chain.calls[0].params).toEqual([ALICE, { mint: MINT }, { encoding: "jsonParsed", commitment: "finalized" }]);
    expect(res.task).toMatchObject({ account: ALICE_ATA, status: "open" });
    expect(res.hops).toHaveLength(1);
  });

  it("returns status done with no hops when the owner has no token account", async () => {
    const chain = fakeChain({ tokenAccounts: {}, sigsByAccount: {}, txs: {} });
    const task = baseTask({ account: null });
    const res = await follow(chain.call, task);
    expect(res).toEqual({ task: { ...task, status: "done" }, hops: [], nextTasks: [] });
    expect(chain.calls.map((c) => c.method)).toEqual(["getTokenAccountsByOwner"]);
  });

  it("returns terminal tasks unchanged without any calls", async () => {
    for (const status of ["done", "untracked"]) {
      const chain = fakeChain({ sigsByAccount: {}, txs: {} });
      const task = baseTask({ status });
      expect(await follow(chain.call, task)).toEqual({ task, hops: [], nextTasks: [] });
      expect(chain.calls).toEqual([]);
    }
  });

  it("returns status error without rethrowing when the RPC fails", async () => {
    const task = baseTask();
    const res = await follow(async () => {
      throw new Error("upstream 500");
    }, task);
    expect(res).toEqual({ task: { ...task, status: "error" }, hops: [], nextTasks: [] });
  });

  it("skips a null getTransaction result and keeps going", async () => {
    const world = {
      sigsByAccount: { [ALICE_ATA]: [sig("s2", 200, 0), sig("s1", 100, 1)] },
      txs: { s2: aliceToMexc(1_000_000) },
    };
    const res = await follow(fakeChain(world).call, baseTask());
    expect(res.hops.map((h) => h.sig)).toEqual(["s2"]);
    expect(res.task.until).toBe("s2");
  });
});
