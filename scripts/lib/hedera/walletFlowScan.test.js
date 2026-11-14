import { describe, expect, it } from "vitest";
import { scanSenderFlows, senderStreams } from "./walletFlowScan.js";
import { emptyState, labelEvents, mergeEvents, planResume, pruneEvents, windowStart } from "./walletFlowsHedera.js";
import { scanHash } from "./walletFlowSenders.js";
import { FLOW_CLASSIFIER_VERSION } from "./flowClassify.js";

const A = "0.0.100";
const B = "0.0.101";
const C = "0.0.300";
const CEX = "0.0.900001";
const OUTSIDE = "0.0.800002";
const USER = "0.0.5000001";
const FEE = 1000;
const START = "1794268800.000000000";
const THROUGH = "1794441600.000000000";
const stamp = (n) => `${1794268800 + n}.000000001`;
const nanos = (s) => BigInt(s.split(".")[0]) * 1_000_000_000n + BigInt(s.split(".")[1].padEnd(9, "0"));

const tx = (n, legs, extra = {}) => ({
  consensus_timestamp: stamp(n),
  transaction_id: `${legs.find((l) => l.amount < 0).account}-1-1`,
  charged_tx_fee: 0,
  result: "SUCCESS",
  nonce: 0,
  transfers: legs,
  ...extra,
});
const send = (n, from, to, amount) =>
  tx(n, [{ account: from, amount: -(amount + FEE) }, { account: to, amount }, { account: "0.0.802", amount: FEE }], { charged_tx_fee: FEE });

const inIdRange = (id, f, t) => BigInt(id.slice(4)) >= BigInt(f.slice(4)) && BigInt(id.slice(4)) <= BigInt(t.slice(4));

/** A mirror double: account.id eq / gte / lte, timestamp gt / lte, asc, limit; links.next only while rows remain. */
function fakeMirror(transactions, { failOn = () => false, sparseFirst = false } = {}) {
  const calls = [];
  const client = {
    getJson: async (path) => {
      calls.push(path);
      if (failOn(path, calls.length)) throw new Error("mirror GET failed after 6 attempts: HTTP 503");
      const q = new URLSearchParams(path.split("?")[1]);
      const ids = q.getAll("account.id");
      const limit = Number(q.get("limit"));
      let gt = null;
      let lte = null;
      for (const v of q.getAll("timestamp")) {
        const [op, x] = v.split(":");
        if (op === "gt") gt = nanos(x);
        if (op === "lte") lte = nanos(x);
      }
      const match = (t) => {
        const legs = t.transfers.map((l) => l.account);
        return legs.some((id) =>
          ids.every((f) => {
            const [op, v] = f.includes(":") ? f.split(":") : ["eq", f];
            return op === "eq" ? id === v : op === "gte" ? BigInt(id.slice(4)) >= BigInt(v.slice(4)) : inIdRange(id, "0.0.0", v);
          }),
        );
      };
      const rows = transactions.filter((t) => nanos(t.consensus_timestamp) > gt && nanos(t.consensus_timestamp) <= lte && match(t)).sort((a, b) => (nanos(a.consensus_timestamp) < nanos(b.consensus_timestamp) ? -1 : 1));
      const page = rows.slice(0, limit);
      if (sparseFirst && calls.length === 1 && page.length > 0) {
        const bound = `${Number(String(gt).slice(0, 10)) + 1}.000000000`;
        return { transactions: [], links: { next: `/api/v1/transactions?${path.split("?")[1].replace(/timestamp=gt:[\d.]+/, `timestamp=gt:${bound}`)}` } };
      }
      return { transactions: page, links: { next: rows.length > limit ? `/api/v1/transactions?next=${page.at(-1).consensus_timestamp}` : null } };
    },
  };
  return { client, calls };
}

const scan = (client, senders, extra = {}) => scanSenderFlows({ client, senders, start: START, through: THROUGH, logger: { warn() {} }, ...extra });
const keySet = (events) => new Set(events.map((e) => `${e.sig}|${e.w}|${e.d}|${e.raw}`));

describe("senderStreams", () => {
  it("groups contiguous ids into one stream, whatever the order", () => {
    expect(senderStreams([B, C, A]).map((s) => s.key)).toEqual([`${A}..${B}`, C]);
  });
});

describe("scanSenderFlows", () => {
  it("stores transfers sent by a sender with the recipient, never the fee", async () => {
    const { client } = fakeMirror([send(1, A, CEX, 5000), send(2, A, OUTSIDE, 700)]);
    const res = await scan(client, [A]);
    expect(res.events.map((e) => [e.w, e.d, e.raw])).toEqual([[A, CEX, "5000"], [A, OUTSIDE, "700"]]);
    expect(res.events.every((e) => e.t > 0 && e.sig.includes("."))).toBe(true);
    expect(res.failed).toEqual([]);
  });

  it("failed transactions move nothing but fees, and staking-reward legs are removed", async () => {
    const failed = tx(1, [{ account: A, amount: -FEE }, { account: "0.0.3", amount: FEE }], { charged_tx_fee: FEE, result: "INSUFFICIENT_PAYER_BALANCE" });
    const reward = tx(2, [{ account: "0.0.800", amount: -777 }, { account: A, amount: 777 }], { staking_reward_transfers: [{ account: A, amount: 777 }] });
    const { client } = fakeMirror([failed, reward]);
    const res = await scan(client, [A]);
    expect(res.events).toEqual([]);
    expect(res.stats.failedTransactions).toBe(1);
  });

  it("follows links.next: a full page continues from its last row and nothing is dropped", async () => {
    const txs = Array.from({ length: 250 }, (_, i) => send(i + 1, A, OUTSIDE, 10 + i));
    const { client, calls } = fakeMirror(txs);
    const res = await scan(client, [A]);
    expect(res.events).toHaveLength(250);
    expect(calls.length).toBe(3);
  });

  it("an empty page that still has a next link is not the end of the range", async () => {
    const { client, calls } = fakeMirror([send(5, A, CEX, 5000)], { sparseFirst: true });
    const res = await scan(client, [A]);
    expect(res.events.map((e) => e.raw)).toEqual(["5000"]);
    expect(calls.length).toBe(2);
  });

  const emptyWithNext = (bound) => ({ getJson: async () => ({ transactions: [], links: { next: `/api/v1/transactions?account.id=0.0.100&limit=100&timestamp=lte:${THROUGH}&timestamp=gt:${bound}&order=asc` } }) });

  it("an empty page whose bound does not move past the cursor, or lies beyond the range end, fails the stream and keeps the cursor", async () => {
    for (const bound of [START, "1700000000.000000000", "1794441601.000000000"]) {
      const res = await scan(emptyWithNext(bound), [A]);
      expect(res.failed, bound).toHaveLength(1);
      expect(res.failed[0].message).toMatch(/cannot advance/);
      expect(res.cursors[A].until).toBe(START);
    }
  });

  it("a bound exactly at the range end is accepted and counted as an empty continuation page", async () => {
    const res = await scan(emptyWithNext(THROUGH), [A]);
    expect(res.failed).toEqual([]);
    expect(res.cursors[A].until).toBe(THROUGH);
    expect(res.stats.emptyContinuationPages).toBe(1);
  });

  it("a page that fails keeps the cursor, reports the stream and leaves the scan incomplete", async () => {
    const txs = Array.from({ length: 150 }, (_, i) => send(i + 1, A, OUTSIDE, 10 + i));
    const { client } = fakeMirror(txs, { failOn: (_p, n) => n === 2 });
    const res = await scan(client, [A]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].account).toBe(A);
    expect(res.cursors[A].until).toBe(stamp(100));
    expect(nanos(res.cursors[A].until) < nanos(THROUGH)).toBe(true);
  });

  it("a record touching senders of two streams is counted once, by the stream of the lowest id", async () => {
    const { client } = fakeMirror([send(1, A, C, 4000)]);
    const res = await scan(client, [A, C]);
    expect(res.events.map((e) => [e.w, e.d])).toEqual([[A, C]]);
  });

  it("the stored result does not depend on the order the senders are listed in", async () => {
    const txs = [send(1, A, C, 4000), send(2, C, OUTSIDE, 900), send(3, B, CEX, 50)];
    const x = await scan(fakeMirror(txs).client, [A, B, C]);
    const y = await scan(fakeMirror(txs).client, [C, B, A]);
    expect(keySet(x.events)).toEqual(keySet(y.events));
  });

  it("resumes across budgeted runs to exactly the events of one full run, and a re-delivered page is dropped", async () => {
    const txs = Array.from({ length: 230 }, (_, i) => send(i + 1, i % 2 ? A : C, i % 3 ? CEX : OUTSIDE, 10 + i));
    const full = await scan(fakeMirror(txs).client, [A, C]);
    let state = emptyState({ hash: "h", key: "hedera" });
    const progress = async ({ newEvents, cursors }) => {
      state = { ...mergeEvents(state, newEvents), cursors };
    };
    let calls = 0;
    const budget = { now: () => (calls++ >= 2 ? 10 : 0), deadlineMs: 5 };
    const first = await scan(fakeMirror(txs).client, [A, C], { ...budget, onProgress: progress });
    expect(first.timedOut).toBe(true);
    const second = await scan(fakeMirror(txs).client, [A, C], { cursors: state.cursors, onProgress: progress });
    expect(second.timedOut).toBe(false);
    const redelivered = mergeEvents(state, second.events);
    expect(redelivered.events).toHaveLength(state.events.length);
    expect(keySet(state.events)).toEqual(keySet(full.events));
  });

  it("senders [A] then [A, B] where a record moves HBAR from A to B equals a fresh scan of [A, B]", async () => {
    const txs = [send(1, A, B, 4000), send(2, B, CEX, 3000), send(3, A, CEX, 100)];
    const hashA = scanHash([A], FLOW_CLASSIFIER_VERSION);
    const hashAB = scanHash([A, B], FLOW_CLASSIFIER_VERSION);
    expect(hashA).not.toBe(hashAB);
    const onlyA = await scan(fakeMirror(txs).client, [A]);
    const stateA = { ...emptyState({ hash: hashA, key: "hedera" }), events: onlyA.events, cursors: onlyA.cursors };
    const plan = planResume({ state: stateA, hash: hashAB, key: "hedera", floor: START });
    expect(plan.rebuilt).toBe(true);
    expect(plan.state.events).toEqual([]);
    const rebuilt = await scan(fakeMirror(txs).client, [A, B], { cursors: plan.state.cursors });
    const fresh = await scan(fakeMirror(txs).client, [A, B]);
    expect(keySet(rebuilt.events)).toEqual(keySet(fresh.events));
    expect(keySet(fresh.events)).toEqual(new Set([`${stamp(1)}|${A}|${B}|4000`, `${stamp(2)}|${B}|${CEX}|3000`, `${stamp(3)}|${A}|${CEX}|100`]));
  });

  it("with inbound on, a sender's receipts are kept too", async () => {
    const { client } = fakeMirror([send(1, OUTSIDE, A, 900)]);
    const res = await scan(client, [A], { inbound: true });
    expect(res.events).toEqual([expect.objectContaining({ w: A, d: OUTSIDE, raw: "900", dir: "in" })]);
  });
});

describe("report-time labelling", () => {
  it("labels stored events with the current lists and outflows by venue add up to the total", async () => {
    const { client } = fakeMirror([send(1, A, CEX, 5000), send(2, A, "0.0.1456985", 300), send(3, A, B, 70), send(4, A, OUTSIDE, 20)]);
    const res = await scan(client, [A, B]);
    const roles = { wallets: new Set([A, B]), cex: new Map([[CEX, "Alpha"]]), dex: new Set(["0.0.1456985"]), staking: new Set() };
    const labelled = labelEvents(res.events, roles);
    expect(labelled.map((e) => e.kind)).toEqual(["CEX", "DEX", "internal", "unlabelled"]);
    const total = labelled.reduce((s, e) => s + BigInt(e.raw), 0n);
    expect(total).toBe(5390n);
    // a venue list change relabels without a rescan
    const relabelled = labelEvents(res.events, { ...roles, cex: new Map([[OUTSIDE, "Beta"]]) });
    expect(relabelled.map((e) => e.kind)).toEqual(["unlabelled", "DEX", "internal", "CEX"]);
  });
});

describe("state helpers", () => {
  it("prunes events older than 90 days before the anchor and computes the window start", () => {
    const anchor = 1794441600;
    const events = [{ t: anchor - 91 * 86400 }, { t: anchor - 89 * 86400 }];
    expect(pruneEvents(events, anchor)).toEqual([events[1]]);
    expect(windowStart("1794441600.000000000")).toBe("1786665600.000000000");
  });

  it("rebuilds when the version or chain key changed and moves cursors older than the floor up to it", () => {
    const state = { ...emptyState({ hash: "h", key: "hedera" }), cursors: { [A]: { until: "1700000000.000000000" } } };
    const kept = planResume({ state, hash: "h", key: "hedera", floor: START });
    expect(kept.rebuilt).toBe(false);
    expect(kept.state.cursors[A].until).toBe(START);
    expect(planResume({ state, hash: "h", key: "other", floor: START }).rebuilt).toBe(true);
    expect(planResume({ state: { ...state, version: 99 }, hash: "h", key: "hedera", floor: START }).rebuilt).toBe(true);
    expect(planResume({ state: null, hash: "h", key: "hedera", floor: START }).reason).toBe("no state");
  });
});
