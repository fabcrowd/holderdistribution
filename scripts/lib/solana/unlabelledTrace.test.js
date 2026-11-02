import { describe, expect, it } from "vitest";
import { buildUnlabelledTrace } from "./unlabelledTrace.js";

const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 86400;
const DECIMALS = 9;
const UNIT = 10 ** DECIMALS;

// Synthetic base58-looking addresses. DEST_LOWER differs from DEST only by case.
const WALLET = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const DEST = "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w";
const DEST_LOWER = DEST.toLowerCase();
const DEST_PREFIX = DEST.slice(0, 20);
const CEX_HOT = "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ";
const DEX_POOL = "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w";
const ZBCN_MINT = "ZbCnMint1111111111111111111111111111111111";

const REGISTRY = { knownWallets: [{ address: WALLET, label: "Treasury desk" }] };

const received = (overrides = {}) => ({
  wallet: WALLET,
  kind: "unlabelled",
  venue: null,
  dest: DEST,
  raw: String(UNIT),
  t: NOW - DAY,
  sig: "SIG1",
  ...overrides,
});

const traceTask = (overrides = {}) => ({
  id: "trace-1",
  kind: "trace",
  ref: `SIG1|${WALLET}|${DEST}`,
  rootWallet: WALLET,
  owner: null,
  account: null,
  mint: ZBCN_MINT,
  decimals: DECIMALS,
  sinceSec: NOW - DAY,
  remaining: "0",
  depth: 0,
  until: NOW,
  status: "done",
  ...overrides,
});

const hop = (overrides = {}) => ({
  taskId: "trace-1",
  depth: 1,
  from: DEST,
  to: CEX_HOT,
  kind: "CEX",
  venue: "MEXC",
  mint: ZBCN_MINT,
  raw: String(0.4 * UNIT),
  t: NOW - DAY + HOUR,
  sig: "HOPSIG1",
  ...overrides,
});

function trace({ events = [received()], tasks = {}, hops = [], ...options } = {}) {
  return buildUnlabelledTrace({
    events,
    follow: { tasks, hops },
    registry: REGISTRY,
    nowSec: NOW,
    decimals: DECIMALS,
    ...options,
  });
}

describe("buildUnlabelledTrace", () => {
  it("returns null when there are no unlabelled events within 90 days", () => {
    expect(trace({ events: [] })).toBeNull();
    expect(trace({ events: [received({ t: NOW - 91 * DAY })] })).toBeNull();
    expect(trace({ events: [received({ kind: "CEX", venue: "MEXC" })] })).toBeNull();
  });

  it("sums same-destination events and reports the newest time", () => {
    const result = trace({
      events: [received({ raw: String(2 * UNIT), t: NOW - 2 * HOUR }), received({ raw: String(UNIT), t: NOW - HOUR, sig: "SIG2" })],
    });
    expect(result.destinations).toHaveLength(1);
    expect(result.destinations[0].received).toBe(3);
    expect(result.destinations[0].t).toBe(new Date((NOW - HOUR) * 1000).toISOString());
  });

  it("counts only first-hop outflows, so byKind plus unaccounted equals received (no double count)", () => {
    const tasks = { "trace-1": traceTask() };
    const hops = [hop({ raw: String(0.4 * UNIT) }), hop({ depth: 2, to: DEX_POOL, kind: "DEX", venue: "dex", raw: String(0.3 * UNIT), sig: "HOPSIG2" })];
    const result = trace({ events: [received({ raw: String(UNIT) })], tasks, hops });
    const [row] = result.destinations;
    const accounted = Object.values(row.byKind).reduce((s, v) => s + v, 0);
    expect(accounted + row.unaccounted).toBeCloseTo(row.received, 9);
    expect(row.byKind).toEqual({ CEX: expect.any(Number) });
    expect(row.byKind.CEX).toBeCloseTo(0.4, 9);
    expect(row.unaccounted).toBeCloseTo(0.6, 9);

    const totalAccounted = Object.values(result.totals.byKind).reduce((s, v) => s + v, 0);
    expect(totalAccounted).toBeCloseTo(result.totals.received, 9);
  });

  it("floors unaccounted at zero when onward hops exceed what arrived", () => {
    const tasks = { "trace-1": traceTask() };
    const [row] = trace({ tasks, hops: [hop({ raw: String(2 * UNIT) })] }).destinations;
    expect(row.unaccounted).toBe(0);
  });

  it("maps the status of the matching trace task, or untracked when none matches", () => {
    const tasks = { "trace-1": traceTask({ status: "busy" }) };
    expect(trace({ tasks }).destinations[0].status).toBe("busy");
    expect(trace({ tasks: {} }).destinations[0].status).toBe("untracked");
  });

  it("does not match a trace task belonging to a longer destination that shares a prefix", () => {
    const tasks = { longer: traceTask({ id: "longer", ref: `SIG1|${WALLET}|${DEST}`, status: "error" }) };
    const [row] = trace({ events: [received({ dest: DEST_PREFIX })], tasks }).destinations;
    expect(row.dest).toBe(DEST_PREFIX);
    expect(row.status).toBe("untracked");
  });

  it("keeps destinations that differ only in base58 case separate", () => {
    const result = trace({
      events: [received({ dest: DEST, raw: String(2 * UNIT), sig: "A" }), received({ dest: DEST_LOWER, raw: String(UNIT), sig: "B" })],
    });
    expect(result.destinations.map((d) => d.dest).sort()).toEqual([DEST, DEST_LOWER].sort());
    expect(result.destinations.map((d) => d.received)).toEqual([2, 1]);
  });

  it("caps destinations at the limit, largest received first", () => {
    const events = [1, 3, 2].map((units, i) => received({ dest: `DEST${i}`.padEnd(32, "x"), raw: String(units * UNIT), sig: `S${i}` }));
    const result = trace({ events, limit: 2 });
    expect(result.destinations.map((d) => d.received)).toEqual([3, 2]);
    expect(result.totals.received).toBe(6);
  });

  it("returns only the requested rows while totals still cover every destination", () => {
    const events = [1, 2, 3, 4, 5].map((units, i) => received({ dest: `DEST${i}`.padEnd(32, "x"), raw: String(units * UNIT), sig: `S${i}` }));
    const result = trace({ events, limit: 3 });

    expect(result.destinations.map((d) => d.received)).toEqual([5, 4, 3]);
    expect(result.totals.received).toBe(15);
    expect(result.totals.byKind.unaccounted).toBe(15);
  });

  it("values the destination and totals in USD only when a price is given", () => {
    const priced = trace({ priceUsd: 0.5 });
    expect(priced.destinations[0].receivedUsd).toBe(0.5);
    expect(priced.totals.receivedUsd).toBe(0.5);
    expect(trace().destinations[0].receivedUsd).toBeNull();
  });

  it("shows a depth-2 hop under the destination row it came from", () => {
    const tasks = {
      "trace-1": traceTask(),
      "trace-2": traceTask({ id: "trace-2", depth: 2 }),
    };
    const hops = [
      hop({ raw: String(0.4 * UNIT) }),
      hop({ taskId: "trace-2", depth: 2, from: CEX_HOT, to: DEX_POOL, kind: "DEX", venue: "dex", raw: String(0.2 * UNIT), sig: "HOPSIG2" }),
    ];
    const result = trace({ events: [received({ raw: String(UNIT) })], tasks, hops });

    expect(result.destinations).toHaveLength(1);
    const [row] = result.destinations;
    expect(row.dest).toBe(DEST);
    expect(row.onward.filter((h) => h.hop === 2)).toEqual([expect.objectContaining({ to: DEX_POOL, amount: 0.2 })]);
    expect(row.byKind).toEqual({ CEX: 0.4 });
    expect(row.unaccounted).toBeCloseTo(0.6, 9);
  });

  it("survives a JSON round trip unchanged", () => {
    const result = trace({ tasks: { "trace-1": traceTask() }, hops: [hop()], priceUsd: 0.25 });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
