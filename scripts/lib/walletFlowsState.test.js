import { describe, it, expect } from "vitest";
import { STATE_LOGIC_VERSION, STATE_VERSION, buildState, configHash, mergeEvents, planChainScan, stateLogic, tokenConfigFingerprint } from "./walletFlowsState.js";

const ev = (block, logIndex = 0, extra = {}) => ({ chain: "ethereum", from: "0xa", to: "0xb", tel: 1, tx: `0x${block}`, block, logIndex, ...extra });
const CHAIN_EVENTS = Array.from({ length: 200 }, (_, i) => ev(i * 10 + 5, i % 3));

/** Fake chain: getLogs(from, to) over CHAIN_EVENTS, recording the requested ranges. */
const makeScanner = () => {
  const calls = [];
  return { calls, scan: (from, to) => (calls.push([from, to]), CHAIN_EVENTS.filter((e) => e.block >= from && e.block <= to)) };
};

/** One generator run for a single chain against `head`; returns the new state and the window input. */
function run({ state, hash = "h", head, start90, scanner }) {
  const plan = planChainScan({ state, chain: "ethereum", hash, start90, head, overlap: 5 });
  const fresh = scanner.scan(plan.from, head);
  const events = mergeEvents(plan.events, fresh, { from: plan.from, start90 });
  return { plan, events, state: buildState({ hash, chains: { ethereum: { cursor: head, events } } }) };
}

describe("planChainScan", () => {
  const hash = "h";
  const good = buildState({ hash, chains: { ethereum: { cursor: 1000, events: [ev(900)] } } });

  it("scans fully without state", () => {
    expect(planChainScan({ state: null, chain: "ethereum", hash, start90: 100, head: 1100 })).toMatchObject({ full: true, from: 100 });
  });
  it("scans incrementally from just behind the cursor", () => {
    expect(planChainScan({ state: good, chain: "ethereum", hash, start90: 100, head: 1100, overlap: 5 })).toMatchObject({ full: false, from: 996 });
  });
  it("rescans fully when the version, config hash or chain entry changes", () => {
    const args = { chain: "ethereum", start90: 100, head: 1100 };
    expect(planChainScan({ ...args, hash, state: { ...good, version: STATE_VERSION + 1 } }).full).toBe(true);
    expect(planChainScan({ ...args, hash: "other", state: good }).full).toBe(true);
    expect(planChainScan({ ...args, hash, state: good, chain: "base" }).full).toBe(true);
  });
  it("rescans fully when the cursor is older than the 90d start", () => {
    expect(planChainScan({ state: good, chain: "ethereum", hash, start90: 1001, head: 1100 })).toMatchObject({ full: true, from: 1001 });
  });
});

describe("configHash", () => {
  it("ignores key order and changes with the registry", () => {
    expect(configHash({ a: 1, b: { c: 2, d: 3 } })).toBe(configHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(configHash({ registry: { knownWallets: [{ address: "0x1" }] } })).not.toBe(
      configHash({ registry: { knownWallets: [{ address: "0x1" }, { address: "0x2" }] } }),
    );
  });
});

describe("incremental runs", () => {
  it("two windows equal one full scan", () => {
    const first = run({ state: null, head: 1000, start90: 0, scanner: makeScanner() });
    const second = run({ state: first.state, head: 2000, start90: 0, scanner: makeScanner() });
    const full = run({ state: null, head: 2000, start90: 0, scanner: makeScanner() });
    expect(second.plan.full).toBe(false);
    expect(second.events).toEqual(full.events);
  });

  it("fetches only (cursor, head] plus the overlap", () => {
    const first = run({ state: null, head: 1000, start90: 0, scanner: makeScanner() });
    const scanner = makeScanner();
    run({ state: first.state, head: 1100, start90: 0, scanner });
    expect(scanner.calls).toEqual([[996, 1100]]);
  });

  it("prunes events older than the 90d start", () => {
    const first = run({ state: null, head: 1000, start90: 0, scanner: makeScanner() });
    const second = run({ state: first.state, head: 1500, start90: 600, scanner: makeScanner() });
    expect(second.events.every((e) => e.block >= 600)).toBe(true);
    expect(second.events).toEqual(run({ state: null, head: 1500, start90: 600, scanner: makeScanner() }).events);
  });

  it("a registry/config hash change forces a full rescan", () => {
    const first = run({ state: null, head: 1000, start90: 0, scanner: makeScanner() });
    const scanner = makeScanner();
    const second = run({ state: first.state, hash: "registry-changed", head: 1100, start90: 0, scanner });
    expect(second.plan.full).toBe(true);
    expect(scanner.calls).toEqual([[0, 1100]]);
  });

  it("keeps events at exactly start90 and drops start90 - 1", () => {
    const merged = mergeEvents([ev(99), ev(100)], [ev(150)], { from: 140, start90: 100 });
    expect(merged.map((e) => e.block)).toEqual([100, 150]);
  });

  it("a cursor ahead of head forces a full rescan", () => {
    const state = buildState({ hash: "h", chains: { ethereum: { cursor: 5000, events: [] } } });
    expect(planChainScan({ state, chain: "ethereum", hash: "h", start90: 0, head: 1000 })).toMatchObject({ full: true, from: 0 });
  });
});

describe("buildState", () => {
  it("keeps previous entries for chains not scanned this run, only under the same config", () => {
    const previous = buildState({ hash: "h", chains: { base: { cursor: 1, events: [] }, ethereum: { cursor: 1, events: [] } } });
    const next = buildState({ hash: "h", chains: { ethereum: { cursor: 9, events: [] } }, previous });
    expect(next.chains.base.cursor).toBe(1);
    expect(next.chains.ethereum.cursor).toBe(9);
    expect(buildState({ hash: "h", chains: { ethereum: { cursor: 9, events: [] } }, previous, validChains: ["ethereum"] }).chains.base).toBeUndefined();
    expect(buildState({ hash: "other", chains: { ethereum: { cursor: 9, events: [] } }, previous }).chains.base).toBeUndefined();
  });
});

describe("tokenConfigFingerprint", () => {
  it("does not throw on a chain without a legacy address and reflects token changes", () => {
    const a = { ethereum: { tokens: { legacy: { address: "0x1", decimals: 2 } } }, other: {} };
    expect(() => tokenConfigFingerprint(a)).not.toThrow();
    const b = { ...a, other: { tokenAddress: "0x2" } };
    expect(configHash(tokenConfigFingerprint(b))).not.toBe(configHash(tokenConfigFingerprint(a)));
  });
});

describe("stateLogic", () => {
  it("changing SWAP_TOPICS, the candidate threshold or the logic version changes the hash", () => {
    const base = { swapTopics: new Map([["0x1", "a"]]), minCandidateTel: 1e6 };
    const h = (logic) => configHash({ logic: stateLogic(logic) });
    expect(h({ ...base, swapTopics: new Map([["0x1", "a"], ["0x2", "b"]]) })).not.toBe(h(base));
    expect(h({ ...base, minCandidateTel: 5e5 })).not.toBe(h(base));
    expect(stateLogic(base).version).toBe(STATE_LOGIC_VERSION);
  });
});

describe("mergeEvents", () => {
  it("dedupes overlap by tx + logIndex and replaces re-read blocks", () => {
    const stored = [ev(10), ev(20, 0, { swapped: true }), ev(30, 1)];
    const fresh = [ev(20, 0), ev(30, 1), ev(30, 2)];
    const merged = mergeEvents(stored, fresh, { from: 20, start90: 0 });
    expect(merged.map((e) => `${e.block}:${e.logIndex}`)).toEqual(["10:0", "20:0", "30:1", "30:2"]);
    expect(merged.find((e) => e.block === 20).swapped).toBe(true);
  });
  it("drops a stored event a reorg removed from the re-read range", () => {
    expect(mergeEvents([ev(25)], [], { from: 20, start90: 0 })).toEqual([]);
  });
});
