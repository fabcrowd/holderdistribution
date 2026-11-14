import { describe, expect, it } from "vitest";
import { venueRoles } from "../../generate-wallet-flows-hedera.js";
import { aggregateWalletOutflows, rawToUnits } from "../solana/walletFlowsSolana.js";
import { scanSenderFlows, senderStreams } from "./walletFlowScan.js";
import { assertStreamable, busyAccountReason } from "./walletFlowSenders.js";
import { emptyState, isResumable, labelEvents, mergeEvents, outflowTotals, scanSavingStateOnError, tinybarToHbar } from "./walletFlowsHedera.js";

const A = "0.0.100";
const B = "0.0.101";
const C = "0.0.300";
const X = "0.0.900001";
const Y = "0.0.900002";
const START = "1794268800.000000000";
const THROUGH = "1794441600.000000000";
const stamp = (n) => `${1794268800 + n}.000000001`;
const nanos = (s) => BigInt(s.split(".")[0]) * 1_000_000_000n + BigInt(s.split(".")[1].padEnd(9, "0"));
const idNum = (id) => BigInt(id.slice(4));

const tx = (n, legs, extra = {}) => ({
  consensus_timestamp: stamp(n),
  transaction_id: `${legs.find((l) => BigInt(l.amount) < 0n)?.account ?? A}-1-1`,
  charged_tx_fee: 0,
  result: "SUCCESS",
  nonce: 0,
  transfers: legs,
  ...extra,
});

/** Mirror double: account.id eq/gte/lte, timestamp gt/lte, asc, limit, links.next only while rows remain. */
function fakeMirror(transactions) {
  return {
    getJson: async (path) => {
      const q = new URLSearchParams(path.split("?")[1]);
      const ids = q.getAll("account.id");
      const limit = Number(q.get("limit"));
      let gt = 0n;
      let lte = 0n;
      for (const v of q.getAll("timestamp")) {
        const [op, x] = v.split(":");
        if (op === "gt") gt = nanos(x);
        if (op === "lte") lte = nanos(x);
      }
      const match = (t) =>
        t.transfers.some((l) =>
          ids.every((f) => {
            const [op, v] = f.includes(":") ? f.split(":") : ["eq", f];
            return op === "eq" ? l.account === v : op === "gte" ? idNum(l.account) >= idNum(v) : idNum(l.account) <= idNum(v);
          }),
        );
      const rows = transactions.filter((t) => nanos(t.consensus_timestamp) > gt && nanos(t.consensus_timestamp) <= lte && match(t)).sort((a, b) => (nanos(a.consensus_timestamp) < nanos(b.consensus_timestamp) ? -1 : 1));
      const page = rows.slice(0, limit);
      return { transactions: page, links: { next: rows.length > limit ? `/api/v1/transactions?next=${page.at(-1).consensus_timestamp}` : null } };
    },
  };
}
const scan =(client, senders, extra = {}) => scanSenderFlows({ client, senders, start: START, through: THROUGH, logger: { warn() {} }, ...extra });
const triples = (events) => events.map((e) => [e.w, e.d, e.raw]);

describe("sender stream guard (item 4)", () => {
  it("refuses consensus node accounts, the protocol accounts and the volume-excluded account", () => {
    for (const id of ["0.0.3", "0.0.20", "0.0.41", "0.0.98", "0.0.800", "0.0.801", "0.0.54"]) {
      expect(busyAccountReason(id), id).not.toBeNull();
      expect(() => senderStreams([A, id]), id).toThrow(new RegExp(`${id.replaceAll(".", "\\.")} is `));
    }
    expect(() => assertStreamable(["0.0.3"])).toThrow(/consensus node account/);
  });

  it("accepts the treasury ids the report traces, including 0.0.2, 0.0.42 and 0.0.44", () => {
    for (const id of ["0.0.2", "0.0.42", "0.0.44", "0.0.71", "0.0.99", "0.0.349", "0.0.400", "0.0.750"]) expect(busyAccountReason(id), id).toBeNull();
    expect(senderStreams(["0.0.42", "0.0.44", "0.0.45"]).map((s) => s.key)).toEqual(["0.0.42", "0.0.44..0.0.45"]);
  });

  it("scanSenderFlows throws before any request when a sender is a busy account", async () => {
    let requests = 0;
    await expect(scan({ getJson: async () => { requests += 1; return { transactions: [], links: { next: null } }; } }, ["0.0.5"])).rejects.toThrow(/consensus node/);
    expect(requests).toBe(0);
  });
});

describe("hard errors keep the last consistent state (item 1)", () => {
  const page1 = Array.from({ length: 100 }, (_, i) => tx(i + 1, [{ account: A, amount: -(10 + i) }, { account: X, amount: 10 + i }]));
  const window = { floor: START, through: THROUGH };

  /** Same wiring as the generator: state updated after every merged page. */
  async function run(client) {
    let state = { ...emptyState({ hash: "h", key: "hedera" }), cursors: {} };
    let saved = null;
    const onProgress = async ({ newEvents, cursors }) => {
      state = { ...mergeEvents(state, newEvents), cursors };
    };
    const outcome = await scanSavingStateOnError({
      scan: () => scan(client, [A], { onProgress }),
      snapshot: () => state,
      persist: async (s) => { saved = s; },
      window,
      logger: { error() {} },
    }).then(() => "ok", (error) => error);
    return { outcome, saved, state };
  }

  it("an out-of-order row on a later page throws, and the state of the page before it is saved", async () => {
    const bad = tx(50, [{ account: A, amount: -5 }, { account: X, amount: 5 }]);
    let call = 0;
    const client = { getJson: async () => (call++ === 0 ? { transactions: page1, links: { next: "/api/v1/transactions?next=1" } } : { transactions: [bad], links: { next: null } }) };
    const { outcome, saved } = await run(client);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toMatch(/out of order/);
    expect(saved.events).toHaveLength(100);
    expect(saved.cursors[A].until).toBe(stamp(100));
    expect(isResumable(saved, window)).toBe(true);
  });

  it("a row past the range end throws and the first page is still saved", async () => {
    const late = tx(1, [{ account: A, amount: -5 }, { account: X, amount: 5 }], { consensus_timestamp: "1794441601.000000000" });
    let call = 0;
    const client = { getJson: async () => (call++ === 0 ? { transactions: page1, links: { next: "/api/v1/transactions?next=1" } } : { transactions: [late], links: { next: null } }) };
    const { outcome, saved } = await run(client);
    expect(outcome.message).toMatch(/outside/);
    expect(saved.events).toHaveLength(100);
  });

  it("an error on the first page saves the (empty) state and rethrows; a failing save still rethrows the scan error", async () => {
    const client = { getJson: async () => ({ transactions: [tx(5, [{ account: A, amount: -1 }, { account: X, amount: 1 }]), tx(4, [{ account: A, amount: -1 }, { account: X, amount: 1 }])], links: { next: null } }) };
    const { outcome, saved } = await run(client);
    expect(outcome.message).toMatch(/out of order/);
    expect(saved.events).toEqual([]);
    const error = await scanSavingStateOnError({
      scan: async () => { throw new Error("boom"); },
      snapshot: () => emptyState({ hash: "h", key: "hedera" }),
      persist: async () => { throw new Error("disk full"); },
      window,
      logger: { error() {} },
    }).catch((e) => e);
    expect(error.message).toBe("boom");
  });

  it("a state with a cursor outside the window is not saved", async () => {
    let saved = false;
    const state = { ...emptyState({ hash: "h", key: "hedera" }), cursors: { [A]: { until: "1794441601.000000000" } } };
    expect(isResumable(state, window)).toBe(false);
    await scanSavingStateOnError({ scan: async () => { throw new Error("x"); }, snapshot: () => state, persist: async () => { saved = true; }, window, logger: { error() {} } }).catch(() => {});
    expect(saved).toBe(false);
  });
});

describe("transfers to network accounts are internal (item 3)", () => {
  const notTraced = [{ address: "0.0.98", label: "Hedera network fee account 0.0.98", reason: "r" }, { address: "0.0.54", name: "Admin 0.0.54", reason: "r" }];
  const roles = venueRoles({ senders: [A, B], notTraced, cexAccounts: [{ id: X, exchange: "Alpha" }], dexIds: ["0.0.1456985"] });
  const ev = (d, raw) => ({ w: A, d, raw, sig: stamp(1), t: 1794268801 });

  it("labels CEX, DEX, internal (sender and notTraced, with the registry label) and unlabelled, and they sum to the total", () => {
    const events = [ev(X, "5000"), ev("0.0.1456985", "300"), ev(B, "70"), ev("0.0.98", "20"), ev("0.0.54", "9"), ev("0.0.12345678", "1")];
    const labelled = labelEvents(events, roles);
    expect(labelled.map((e) => e.kind)).toEqual(["CEX", "DEX", "internal", "internal", "internal", "unlabelled"]);
    expect(labelled[3].venue).toBe("Hedera network fee account 0.0.98");
    expect(labelled[4].venue).toBe("Admin 0.0.54");
    const { total, byKind } = outflowTotals(labelled);
    expect(total).toBe(5400n);
    expect(byKind).toEqual({ CEX: 5000n, DEX: 300n, staking: 0n, internal: 99n, unlabelled: 1n });
    expect(byKind.CEX + byKind.DEX + byKind.internal + byKind.unlabelled).toBe(total);
  });

  it("an event with an unknown kind breaks the invariant loudly", () => {
    expect(() => outflowTotals([{ kind: "mystery", raw: "1", sig: "s" }])).toThrow(/unknown outflow kind/);
  });
});

describe("tinybar precision (item 5)", () => {
  const BIG = "140000000000000000";
  const events = [BIG, "1", "1", "1"].map((raw, i) => ({ w: A, d: i === 0 ? X : "0.0.12345678", raw, sig: stamp(i), t: 1794268800 + i }));
  const roles = venueRoles({ senders: [A], cexAccounts: [{ id: X, exchange: "Alpha" }], dexIds: [] });

  it("the BigInt totals keep every tinybar beyond 2^53 and the kinds sum to the total", () => {
    expect(Number(BIG)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const { total, byKind } = outflowTotals(labelEvents(events, roles));
    expect(total).toBe(140000000000000003n);
    expect(byKind.CEX).toBe(140000000000000000n);
    expect(byKind.unlabelled).toBe(3n);
    expect(byKind.CEX + byKind.unlabelled).toBe(total);
  });

  it("each part is converted once from its exact decimal: the double nearest the true HBAR value", () => {
    const flows = aggregateWalletOutflows(labelEvents(events, roles), 1794441600, 8);
    const kinds = flows.get(A)["90d"];
    expect(kinds.CEX).toBe(Number("1400000000.00000000"));
    expect(kinds.unlabelled).toBe(0.00000003);
    expect(rawToUnits("140000000000000003", 8)).toBe(Number("1400000000.00000003"));
    expect(tinybarToHbar(9007199254740993n)).toBe(Number("90071992.54740993"));
    expect(tinybarToHbar(0n)).toBe(0);
    expect(rawToUnits("-123456789", 8)).toBe(-1.23456789);
    expect(rawToUnits("5", 0)).toBe(5);
  });

  it("below 2^53 tinybar the result equals the old division bit for bit", () => {
    for (const raw of ["1", "99999999", "123456789012", "9007199254740991"]) expect(rawToUnits(raw, 8)).toBe(Number(raw) / 1e8);
  });
});

describe("record rules the wallet flows rely on (item 6)", () => {
  it("a sender that only pays the fee of someone else's transfer has no outflow", async () => {
    const t = tx(1, [{ account: A, amount: -1000 }, { account: "0.0.5000001", amount: -500 }, { account: X, amount: 500 }, { account: "0.0.802", amount: 1000 }], { charged_tx_fee: 1000, transaction_id: `${A}-1-1` });
    const res = await scan(fakeMirror([t]), [A]);
    expect(res.events).toEqual([]);
    expect(res.stats.owned).toBe(1);
  });

  it("a failed record produces no outflow, only its fee", async () => {
    const t = tx(1, [{ account: A, amount: -1000 }, { account: "0.0.802", amount: 1000 }], { charged_tx_fee: 1000, result: "INSUFFICIENT_PAYER_BALANCE" });
    const res = await scan(fakeMirror([t]), [A], { inbound: true });
    expect(res.events).toEqual([]);
    expect(res.stats.failedTransactions).toBe(1);
  });

  it("a staking-reward leg credited to a sender is neither inflow nor outflow, and a deposit netted with one keeps its exact amount", async () => {
    const reward = tx(1, [{ account: "0.0.800", amount: -777 }, { account: A, amount: 777 }], { staking_reward_transfers: [{ account: A, amount: 777 }] });
    const deposit = tx(2, [{ account: "0.0.800", amount: -777 }, { account: A, amount: 5777 }, { account: Y, amount: -5000 }], { staking_reward_transfers: [{ account: A, amount: 777 }] });
    const res = await scan(fakeMirror([reward, deposit]), [A], { inbound: true });
    expect(res.stats.rewardRecords).toBe(2);
    expect(res.events.map((e) => [e.w, e.d, e.raw, e.dir])).toEqual([[A, Y, "5000", "in"]]);
    const outboundOnly = await scan(fakeMirror([reward, deposit]), [A]);
    expect(outboundOnly.events).toEqual([]);
  });

  it("two senders and one recipient: each sender gets its exact amount", async () => {
    const t = tx(1, [{ account: A, amount: -300 }, { account: B, amount: -200 }, { account: X, amount: 500 }]);
    const res = await scan(fakeMirror([t]), [A, B]);
    expect(triples(res.events).sort()).toEqual([[A, X, "300"], [B, X, "200"]]);
  });

  it("a record touching two streams is counted once (events from both senders, stored once)", async () => {
    const t = tx(1, [{ account: A, amount: -300 }, { account: C, amount: -200 }, { account: X, amount: 500 }]);
    const res = await scan(fakeMirror([t]), [A, C]);
    expect(res.streams).toHaveLength(2);
    expect(res.stats.transactions).toBe(2);
    expect(res.stats.owned).toBe(1);
    expect(triples(res.events).sort()).toEqual([[A, X, "300"], [C, X, "200"]]);
  });
});
