import { describe, expect, it } from "vitest";
import { applyFlowEventsOnce, buildExchangeHistory, emptyFlowStore } from "../solana/flowFeeds.js";
import { createMirrorClient } from "./mirror.js";
import { createMockMirror } from "./mockMirror.js";
import { buildHederaTierDays, planFlowResume, UNATTRIBUTED_TIER } from "./flowConfig.js";
import { countRequests, dateOfStamp, FLOW_PAGE_SIZE, nanosOf, readPage, scanHederaFlows } from "./flowScan.js";

const A1 = "0.0.100001";
const A2 = "0.0.100002";
const B1 = "0.0.200001";
const ACCOUNTS = [
  { id: A1, exchange: "Alpha" },
  { id: A2, exchange: "Alpha" },
  { id: B1, exchange: "Beta" },
];
const FEE = 1000;
const START = "1794268800.500000000";
const DAY1_END = "1794355200.004361455";
const DAY2_END = "1794441600.238829104";
const THROUGH = DAY2_END;
const DAY_ENDS = [
  { date: "2026-11-10", stamp: DAY1_END },
  { date: "2026-11-11", stamp: DAY2_END },
];

const stampAt = (n, base = 1794268801) => `${base + n}.000000001`;
const deposit = (n, to, amount, user = "0.0.5000001") => ({
  consensus_timestamp: stampAt(n),
  transaction_id: `${user}-1-1`,
  charged_tx_fee: FEE,
  result: "SUCCESS",
  nonce: 0,
  transfers: [
    { account: user, amount: -(amount + FEE) },
    { account: to, amount },
    { account: "0.0.802", amount: FEE },
  ],
});
const transfer = (n, from, to, amount) => ({
  consensus_timestamp: stampAt(n),
  transaction_id: `${from}-1-1`,
  charged_tx_fee: FEE,
  result: "SUCCESS",
  nonce: 0,
  transfers: [
    { account: from, amount: -(amount + FEE) },
    { account: to, amount },
    { account: "0.0.802", amount: FEE },
  ],
});

const clientOf = (transactions, opts = {}) => {
  const mock = createMockMirror({ transactions, ...opts });
  return { mock, client: createMirrorClient({ baseUrl: "https://mirror.test/api/v1", fetch: mock.fetch, sleep: async () => {}, maxAttempts: opts.maxAttempts ?? 2, maxRps: 1e6 }) };
};

const run = async (client, extra = {}) => {
  const store = extra.store ?? emptyFlowStore();
  const out = await scanHederaFlows({
    client, accounts: ACCOUNTS, cursors: extra.cursors ?? {}, start: START, through: THROUGH, dayEnds: DAY_ENDS, logger: { warn() {} },
    onProgress: async ({ newEvents }) => { applyFlowEventsOnce(store, "hedera", newEvents); },
    ...extra.options,
  });
  return { ...out, store };
};

const dayTotals = (store, date) => store.chains.hedera.days[date]?.totals ?? {};

describe("scanHederaFlows", () => {
  it("buckets by the day-end boundaries: the end stamp belongs to its day, the next nanosecond to the next", async () => {
    const txs = [
      { ...deposit(1, A1, 100), consensus_timestamp: "1794355200.004361455" },
      { ...deposit(2, A1, 7), consensus_timestamp: "1794355200.004361456" },
    ];
    const { client } = clientOf(txs);
    const { store } = await run(client);
    expect(dayTotals(store, "2026-11-10")).toEqual({ cexIn: "100" });
    expect(dayTotals(store, "2026-11-11")).toEqual({ cexIn: "7" });
  });

  it("pages to a confirmed end (150 records over two full-size pages) and ends every cursor at `through`", async () => {
    const txs = Array.from({ length: 150 }, (_, i) => deposit(i + 1, A1, 10));
    const { client, mock } = clientOf(txs);
    const { store, cursors, stats } = await run(client);
    expect(dayTotals(store, "2026-11-10").cexIn).toBe("1500");
    expect(stats.pages).toBeGreaterThanOrEqual(3);
    expect(Object.values(cursors).every((c) => c.until === THROUGH)).toBe(true);
    expect(mock.calls.filter((c) => c.path === "/transactions").every((c) => c.params.get("limit") === String(FLOW_PAGE_SIZE))).toBe(true);
  });

  it("counts a record that touches several exchange accounts once, and classifies internal and cross-exchange moves", async () => {
    const txs = [
      transfer(1, A1, A2, 300), // internal to Alpha
      transfer(2, A1, B1, 500), // Alpha out, Beta in
      deposit(3, A2, 40),
    ];
    const { client } = clientOf(txs);
    const { store, stats } = await run(client);
    const day = store.chains.hedera.days["2026-11-10"];
    expect(day.totals).toEqual({ internal: "300", cexOut: "500", cexIn: "540" });
    expect(day.byExchange).toEqual({ Alpha: { cexOut: "500", cexIn: "40" }, Beta: { cexIn: "500" } });
    expect(stats.owned).toBe(3);
    expect(stats.transactions).toBeGreaterThan(stats.owned);
  });

  it("a failed record and a token-only record add no flow", async () => {
    const failed = { ...transfer(1, A1, "0.0.5000009", 0), result: "INVALID_ACCOUNT_ID", transfers: [{ account: A1, amount: -FEE }, { account: "0.0.802", amount: FEE }] };
    const tokenOnly = { ...failed, consensus_timestamp: stampAt(2), result: "SUCCESS", token_transfers: [{ token_id: "0.0.1", account: A1, amount: -3 }] };
    const { client } = clientOf([failed, tokenOnly]);
    const { store, stats } = await run(client);
    expect(store.chains.hedera?.days ?? {}).toEqual({});
    expect(stats.failedTransactions).toBe(1);
  });

  it("resumes from per-account cursors: a run stopped after every page and restarted equals one uninterrupted run", async () => {
    const txs = [
      ...Array.from({ length: 130 }, (_, i) => deposit(i + 1, A1, 10 + i)),
      ...Array.from({ length: 120 }, (_, i) => transfer(200 + i, A2, "0.0.5000003", 7 + i)),
      transfer(400, A1, B1, 5),
      deposit(401, B1, 9),
    ];
    const whole = await run(clientOf(txs).client);

    // Interrupt after each page: persist the checkpoint exactly as the script does (store first, then cursors).
    let store = emptyFlowStore();
    let cursors = {};
    for (let guard = 0; guard < 50; guard += 1) {
      let pages = 0;
      const out = await scanHederaFlows({
        client: clientOf(txs).client, accounts: ACCOUNTS, cursors, start: START, through: THROUGH, dayEnds: DAY_ENDS, logger: { warn() {} },
        onProgress: async ({ newEvents, cursors: next }) => {
          applyFlowEventsOnce(store, "hedera", newEvents);
          cursors = next;
          pages += 1;
          if (pages === 1) throw new Error("killed");
        },
      }).catch((e) => (e.message === "killed" ? null : Promise.reject(e)));
      if (out) break;
    }
    expect(store).toEqual(whole.store);
    expect(cursors).toEqual(whole.cursors);
  });

  it("a page re-delivered after a crash between the store write and the cursor write is not applied twice", async () => {
    const txs = Array.from({ length: 120 }, (_, i) => deposit(i + 1, A1, 10));
    const whole = await run(clientOf(txs).client);

    const store = emptyFlowStore();
    let delivered = 0;
    await scanHederaFlows({
      client: clientOf(txs).client, accounts: ACCOUNTS, cursors: {}, start: START, through: THROUGH, dayEnds: DAY_ENDS, logger: { warn() {} },
      onProgress: async ({ newEvents }) => {
        applyFlowEventsOnce(store, "hedera", newEvents); // the store is written ...
        delivered += 1;
        if (delivered === 1) throw new Error("crash before the cursor is saved"); // ... the cursor is not
      },
    }).catch(() => {});
    // The next run has the old cursors (none), so the same first page comes back.
    await scanHederaFlows({
      client: clientOf(txs).client, accounts: ACCOUNTS, cursors: {}, start: START, through: THROUGH, dayEnds: DAY_ENDS, logger: { warn() {} },
      onProgress: async ({ newEvents }) => { applyFlowEventsOnce(store, "hedera", newEvents); },
    });
    expect(store.chains.hedera.days).toEqual(whole.store.chains.hedera.days);
  });

  it("stops cleanly at the wall-clock deadline and leaves the unscanned accounts at their cursors", async () => {
    const txs = [deposit(1, A1, 10), deposit(2, B1, 20)];
    const { client } = clientOf(txs);
    const out = await scanHederaFlows({ client, accounts: ACCOUNTS, cursors: {}, start: START, through: THROUGH, dayEnds: DAY_ENDS, deadlineMs: 0, now: () => 1, logger: { warn() {} } });
    expect(out.timedOut).toBe(true);
    expect(Object.values(out.cursors).every((c) => c.until === START)).toBe(true);
    expect(out.events).toEqual([]);
  });

  it("a page that keeps failing leaves that account's cursor and is reported, never skipped", async () => {
    const txs = [deposit(1, A1, 10), deposit(2, B1, 20)];
    const { client } = clientOf(txs, { fail: (path, query) => (path === "/transactions" && query.includes(`account.id=${A1}`) ? 500 : null) });
    const out = await scanHederaFlows({ client, accounts: ACCOUNTS, cursors: {}, start: START, through: THROUGH, dayEnds: DAY_ENDS, logger: { warn() {} } });
    expect(out.failed).toEqual([{ account: A1, message: expect.stringMatching(/failed after 2 attempts/) }]);
    expect(out.cursors[A1].until).toBe(START);
    expect(out.cursors[B1].until).toBe(THROUGH);
    expect(out.events.map((e) => e.counterparty)).toEqual(["0.0.5000001"]);
  });

  it("refuses an out-of-order page", async () => {
    const bad = { getJson: async () => ({ transactions: [deposit(5, A1, 1), deposit(4, A1, 1)], links: { next: null } }) };
    await expect(scanHederaFlows({ client: bad, accounts: ACCOUNTS, cursors: {}, start: START, through: THROUGH, dayEnds: DAY_ENDS, logger: { warn() {} } })).rejects.toThrow(/out of order/);
  });

  it("feeds the existing history builder: rows are tinybar sums converted at the chain's decimals", async () => {
    const { client } = clientOf([deposit(1, A1, 150_000_000), transfer(2, A1, "0.0.5000004", 50_000_000)]);
    const { store } = await run(client);
    expect(buildExchangeHistory(store, { decimals: { hedera: 8 } })).toEqual([
      { date: "2026-11-10", chains: { hedera: { in: 1.5, out: 0.5, dexIn: 0, dexOut: 0 } }, in: 2, out: 1, net: 1, dexIn: 0, dexOut: 0, dexNet: 0 },
    ]);
  });
});

const pageOf = (rows, next) => ({ transactions: rows, links: { next } });
/** A client that answers /transactions with the scripted bodies in order and records each path. */
const scripted = (bodies) => {
  const paths = [];
  return { paths, client: { getJson: async (p) => { paths.push(p); const body = bodies[paths.length - 1]; if (body === undefined) throw new Error("no more scripted pages"); return body; } } };
};
const scanOne = (client, extra = {}) =>
  scanHederaFlows({ client, accounts: [{ id: A1, exchange: "Alpha" }], cursors: {}, start: START, through: THROUGH, dayEnds: DAY_ENDS, logger: { warn() {} }, ...extra });

describe("paging follows the mirror's links.next", () => {
  const NEXT = "/api/v1/transactions?timestamp=gt:1794268803.000000001&limit=100";

  it("readPage (exported, shared with the wallet-flow scan) returns { txs, more } from links.next alone, and throws on anything unreadable", () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => deposit(i + 1, A1, 1));
    expect(readPage(pageOf(rows(3), NEXT), "p")).toEqual({ txs: rows(3), more: true, until: stampAt(3) });
    const emptyNext = "/api/v1/transactions?account.id=0.0.16852&limit=100&timestamp=lte:1794900000&timestamp=gt:1791184000.000000000&order=asc";
    expect(readPage(pageOf([], emptyNext), "p")).toEqual({ txs: [], more: true, until: "1791184000.000000000" });
    expect(() => readPage(pageOf([], "/api/v1/transactions?limit=100&order=asc"), "p")).toThrow(/no timestamp=gt bound/);
    expect(() => readPage(pageOf([], "/api/v1/transactions?timestamp=gt:abc"), "p")).toThrow(/no timestamp=gt bound/);
    expect(readPage(pageOf(rows(3), null), "p").more).toBe(false);
    expect(readPage(pageOf([], null), "p")).toEqual({ txs: [], more: false, until: null });
    expect(readPage(pageOf(rows(FLOW_PAGE_SIZE), null), "p").more).toBe(false);
    expect(readPage(pageOf(rows(FLOW_PAGE_SIZE), NEXT), "p").more).toBe(true);
    for (const bad of [null, "text", { transactions: rows(1) }, { transactions: rows(1), links: {} }, { links: { next: null } }, pageOf(rows(1), 7)]) {
      expect(() => readPage(bad, "p")).toThrow(/unreadable|links\.next/);
    }
  });

  it("a short page with a non-null next continues from its last row", async () => {
    const first = [deposit(1, A1, 10), deposit(2, A1, 20), deposit(3, A1, 30)];
    const { client, paths } = scripted([pageOf(first, NEXT), pageOf([deposit(4, A1, 40)], null)]);
    const out = await scanOne(client);
    expect(paths).toHaveLength(2);
    expect(paths[1]).toContain(`timestamp=gt:${stampAt(3)}`);
    expect(out.events.map((e) => e.raw)).toEqual(["10", "20", "30", "40"]);
    expect(out.cursors[A1].until).toBe(THROUGH);
    expect(out.failed).toEqual([]);
  });

  it("a full page with a null next is the end of the range: no extra probe, no false incomplete", async () => {
    const rows = Array.from({ length: FLOW_PAGE_SIZE }, (_, i) => deposit(i + 1, A1, 1));
    const { client, paths } = scripted([pageOf(rows, null)]);
    const out = await scanOne(client);
    expect(paths).toHaveLength(1);
    expect(out.cursors[A1].until).toBe(THROUGH);
    expect(out.failed).toEqual([]);
    expect(out.events).toHaveLength(FLOW_PAGE_SIZE);
  });

  it("a short page and an empty page with a null next end the range", async () => {
    for (const rows of [[deposit(1, A1, 5)], []]) {
      const { client, paths } = scripted([pageOf(rows, null)]);
      const out = await scanOne(client);
      expect(paths).toHaveLength(1);
      expect(out.cursors[A1].until).toBe(THROUGH);
    }
  });

  it("an unreadable body, missing links or a bad next is a failure that keeps the cursor", async () => {
    const bad = [null, "text", { transactions: [deposit(1, A1, 1)] }, { transactions: [deposit(1, A1, 1)], links: {} }, { links: { next: null } }, pageOf([deposit(1, A1, 1)], 7)];
    for (const body of bad) {
      const out = await scanOne(scripted([body]).client);
      expect(out.failed).toEqual([{ account: A1, message: expect.stringMatching(/unreadable|links\.next/) }]);
      expect(out.cursors[A1].until).toBe(START);
      expect(out.events).toEqual([]);
    }
  });

  const emptyTo = (stamp) => pageOf([], `/api/v1/transactions?account.id=${A1}&limit=100&timestamp=lte:${THROUGH}&timestamp=gt:${stamp}&order=asc`);

  it("an empty page with a next advances to the parsed bound: no events, not at the end", async () => {
    const { client, paths } = scripted([emptyTo("1794300000.000000000")]);
    const out = await scanOne(client);
    expect(paths).toHaveLength(2);
    expect(paths[1]).toContain("timestamp=gt:1794300000.000000000&");
    expect(out.events).toEqual([]);
    expect(out.stats.emptyContinuationPages).toBe(1);
    expect(out.failed).toHaveLength(1); // the script ran out of pages: the cursor stays at the last bound, never `through`
    expect(out.cursors[A1].until).toBe("1794300000.000000000");
  });

  it("a chain of empty pages, then rows, then a null next ends at `through`", async () => {
    const { client, paths } = scripted([emptyTo("1794290000.000000000"), emptyTo("1794300000"), pageOf([deposit(40000, A1, 9)], NEXT), pageOf([], null)]);
    const out = await scanOne(client);
    expect(paths).toHaveLength(4);
    expect(out.stats.emptyContinuationPages).toBe(2);
    expect(out.events.map((e) => e.raw)).toEqual(["9"]);
    expect(out.cursors[A1].until).toBe(THROUGH);
    expect(out.failed).toEqual([]);
  });

  it("an empty page whose bound does not advance, or lies beyond `through`, is a failure that keeps the cursor", async () => {
    for (const stamp of [START, "1794268799.000000000", "1794441600.238829105", "1799999999"]) {
      const out = await scanOne(scripted([emptyTo(stamp)]).client);
      expect(out.failed).toEqual([{ account: A1, message: expect.stringMatching(/not inside/) }]);
      expect(out.cursors[A1].until).toBe(START);
    }
    const atEnd = await scanOne(scripted([emptyTo(THROUGH), pageOf([], null)]).client);
    expect(atEnd.failed).toEqual([]);
    expect(atEnd.cursors[A1].until).toBe(THROUGH);
  });

  it("no gap or overlap at a page boundary: rows a nanosecond apart are all counted once, a repeated boundary row is refused", async () => {
    const a = { ...deposit(1, A1, 10), consensus_timestamp: "1794268801.000000005" };
    const b = { ...deposit(2, A1, 20), consensus_timestamp: "1794268801.000000006" };
    const { client, paths } = scripted([pageOf([a], NEXT), pageOf([b], null)]);
    const out = await scanOne(client);
    expect(paths[1]).toContain("timestamp=gt:1794268801.000000005");
    expect(out.events.map((e) => e.raw)).toEqual(["10", "20"]);

    const repeat = scripted([pageOf([a], NEXT), pageOf([a, b], null)]);
    await expect(scanOne(repeat.client)).rejects.toThrow(/out of order/);
  });

  it("a page that fails after rows were read keeps the cursor of the last delivered page", async () => {
    const { client } = scripted([pageOf([deposit(1, A1, 10)], NEXT), null]);
    const out = await scanOne(client);
    expect(out.failed).toHaveLength(1);
    expect(out.cursors[A1].until).toBe(stampAt(1));
  });
});

const B = "0.0.200001";
const X = "0.0.100001";
const SINCE = "2026-11-10";

// Mirrors scripts/scan-hedera-flows.js: plan, scan, persist per page (store first, then the cursors).
async function scanLikeScript(disk, accounts, txs, { killAfterPages = null } = {}) {
  const plan = planFlowResume({ prev: disk.checkpoint, store: disk.store, since: SINCE, accounts, key: "hedera" });
  const store = structuredClone(plan.store);
  let cursors = Object.fromEntries(accounts.map((a) => [a.id, { until: plan.prev?.accounts?.[a.id]?.until ?? START }]));
  let pages = 0;
  const { client, mock } = clientOf(txs);
  const base = () => ({ since: SINCE, setHash: plan.setHash, complete: false });
  const out = await scanHederaFlows({
    client, accounts, cursors, start: START, through: THROUGH, dayEnds: DAY_ENDS, logger: { warn() {} },
    onProgress: async ({ newEvents, cursors: next }) => {
      applyFlowEventsOnce(store, "hedera", newEvents);
      cursors = next;
      disk.store = structuredClone(store);
      disk.checkpoint = { ...base(), accounts: structuredClone(next) };
      pages += 1;
      if (killAfterPages !== null && pages >= killAfterPages) throw new Error("killed");
    },
  }).catch((e) => (e.message === "killed" ? null : Promise.reject(e)));
  if (out) {
    disk.store = structuredClone(store);
    disk.checkpoint = { ...base(), accounts: structuredClone(out.cursors), complete: true };
  }
  return { plan, requests: mock.calls.filter((c) => c.path === "/transactions").length, finished: out !== null };
}
const fresh = async (accounts, txs) => {
  const disk = { store: null, checkpoint: null };
  await scanLikeScript(disk, accounts, txs);
  return disk;
};
const daysOf = (disk) => disk.store.chains.hedera?.days ?? {};

describe("a changed exchange-account set rebuilds the stored flows", () => {
  const AX = { id: X, exchange: "Alpha" };
  const BB = { id: B, exchange: "Beta" };
  const txs = [
    transfer(1, B, X, 400), // between the two exchanges
    deposit(2, B, 70),
    deposit(3, X, 30),
    transfer(4, X, "0.0.5000003", 11),
    deposit(5, "0.0.5000009", 3), // touches no exchange account
  ];

  it("adding an account that shares records equals a fresh scan of the new set", async () => {
    const disk = { store: null, checkpoint: null };
    await scanLikeScript(disk, [BB], txs);
    expect(daysOf(disk)["2026-11-10"].totals).toEqual({ cexOut: "400", cexIn: "70" }); // B only: X is not an exchange yet
    const run = await scanLikeScript(disk, [AX, BB], txs);
    expect(run.plan.reason).toMatch(/account set/);
    expect(daysOf(disk)).toEqual(daysOf(await fresh([AX, BB], txs)));
  });

  it("removing an account drops its flows and equals a fresh scan of the remaining set", async () => {
    const disk = { store: null, checkpoint: null };
    await scanLikeScript(disk, [AX, BB], txs);
    expect(daysOf(disk)["2026-11-10"].byExchange.Alpha).toBeDefined();
    const run = await scanLikeScript(disk, [BB], txs);
    expect(run.plan.reason).toMatch(/account set/);
    expect(daysOf(disk)["2026-11-10"].byExchange.Alpha).toBeUndefined();
    expect(daysOf(disk)).toEqual(daysOf(await fresh([BB], txs)));
  });

  it("relabeling an account (what is internal) equals a fresh scan under the new labels", async () => {
    const disk = { store: null, checkpoint: null };
    await scanLikeScript(disk, [AX, BB], txs);
    const merged = [AX, { id: B, exchange: "Alpha" }];
    const run = await scanLikeScript(disk, merged, txs);
    expect(run.plan.reason).toMatch(/account set/);
    expect(daysOf(disk)["2026-11-10"].totals.internal).toBe("400");
    expect(daysOf(disk)).toEqual(daysOf(await fresh(merged, txs)));
  });

  it("reordering the same accounts alone does not rebuild: no reason, no mirror requests, same store", async () => {
    const disk = { store: null, checkpoint: null };
    await scanLikeScript(disk, [AX, BB], txs);
    const before = structuredClone(disk.store);
    const run = await scanLikeScript(disk, [BB, AX], txs);
    expect(run.plan.reason).toBeNull();
    expect(run.requests).toBe(0);
    expect(disk.store).toEqual(before);
    // and the result is order independent from scratch too
    expect(daysOf(await fresh([BB, AX], txs))).toEqual(daysOf(await fresh([AX, BB], txs)));
  });

  it("an interrupted rebuild resumes without starting over and converges to the fresh result", async () => {
    const many = [...Array.from({ length: 230 }, (_, i) => deposit(i + 1, B, 10 + i)), ...txs.map((t, i) => ({ ...t, consensus_timestamp: stampAt(300 + i) }))];
    const disk = { store: null, checkpoint: null };
    await scanLikeScript(disk, [BB], many);
    const first = await scanLikeScript(disk, [AX, BB], many, { killAfterPages: 1 });
    expect(first.plan.reason).toMatch(/account set/);
    expect(first.finished).toBe(false);
    expect(disk.checkpoint.complete).toBe(false);
    for (let guard = 0; guard < 20; guard += 1) {
      const next = await scanLikeScript(disk, [AX, BB], many, { killAfterPages: 1 });
      expect(next.plan.reason).toBeNull(); // resumed, not restarted
      if (next.finished) break;
    }
    expect(disk.checkpoint.complete).toBe(true);
    expect(daysOf(disk)).toEqual(daysOf(await fresh([AX, BB], many)));
  });

  it("a checkpoint without a set stamp (older scan) rebuilds once", async () => {
    const disk = { store: null, checkpoint: null };
    await scanLikeScript(disk, [AX, BB], txs);
    delete disk.checkpoint.setHash;
    const run = await scanLikeScript(disk, [AX, BB], txs);
    expect(run.plan.reason).toMatch(/no account-set stamp/);
    expect(daysOf(disk)).toEqual(daysOf(await fresh([AX, BB], txs)));
  });
});

describe("tier feed keeps every flow: tiers plus unattributed equal the exchange history", () => {
  const T1 = "0.0.7000001";
  const UNKNOWN = "0.0.7000002";
  const HBAR = 100_000_000;
  const dayTwo = (n, tx) => ({ ...tx, consensus_timestamp: `${1794355201 + n}.000000001` });

  it("holds for every day, including days before the first snapshot, untiered counterparties and unpaired remainders", async () => {
    const txs = [
      deposit(1, A1, 5 * HBAR, T1), // day 1, before the first snapshot
      dayTwo(1, deposit(1, A1, 3 * HBAR, T1)),
      dayTwo(2, deposit(2, A1, 2 * HBAR, UNKNOWN)),
      dayTwo(3, transfer(3, A1, T1, 4 * HBAR)),
      dayTwo(4, transfer(4, A1, UNKNOWN, 1 * HBAR)),
      dayTwo(5, transfer(5, A1, B1, 6 * HBAR)), // another exchange
      { ...dayTwo(6, deposit(6, A1, 1)), charged_tx_fee: 0, transfers: [{ account: A1, amount: 7 * HBAR }] }, // an unpaired remainder
    ];
    const { client } = clientOf(txs);
    const { store } = await run(client);
    const history = buildExchangeHistory(store, { decimals: { hedera: 8 } });
    const tierAt = (date) => (date >= "2026-11-11" ? new Map([[T1, "T1"]]) : new Map());
    const days = buildHederaTierDays(store, { decimals: { hedera: 8 }, tierAt });

    expect(history.map((h) => h.date)).toEqual(["2026-11-10", "2026-11-11"]);
    for (const h of history) {
      const buckets = Object.values(Object.fromEntries(days.get(h.date) ? Object.entries(days.get(h.date)) : []));
      expect(buckets.reduce((s, b) => s + b.cex, 0)).toBeCloseTo(h.in, 6);
      expect(buckets.reduce((s, b) => s + b.inflows.cex, 0)).toBeCloseTo(h.out, 6);
    }
    expect(days.get("2026-11-10")[UNATTRIBUTED_TIER].cex).toBeCloseTo(5, 6); // before the first snapshot: kept
    const d2 = days.get("2026-11-11");
    expect(d2.T1.cex).toBeCloseTo(3, 6);
    expect(d2.T1.inflows.cex).toBeCloseTo(4, 6);
    expect(d2[UNATTRIBUTED_TIER].cex).toBeCloseTo(2 + 6 + 7, 6); // untiered sender, the other exchange, unpaired remainder
    expect(d2[UNATTRIBUTED_TIER].inflows.cex).toBeCloseTo(1 + 6, 6);
  });
});

describe("helpers", () => {
  it("dateOfStamp rejects a stamp after the last day end", () => {
    const ends = DAY_ENDS.map((d) => ({ date: d.date, end: nanosOf(d.stamp) }));
    expect(dateOfStamp(ends, DAY1_END)).toBe("2026-11-10");
    expect(() => dateOfStamp(ends, "1794441600.238829105")).toThrow(/after the last day end/);
  });

  it("countRequests counts every request start", async () => {
    const { client } = clientOf([]);
    const counted = countRequests(client);
    await counted.client.getJson("/transactions?limit=1");
    await counted.client.getPage("/transactions?limit=1");
    expect(counted.requests()).toBe(2);
  });
});
