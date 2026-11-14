import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHederaClock } from "./clock.js";
import { flowSetHash, hederaFlowAccounts, hederaFlowAsOf, hederaFlowChains, planFlowResume, resolveDayEnds } from "./flowConfig.js";
import { createMirrorClient } from "./mirror.js";
import { createMockMirror } from "./mockMirror.js";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hedera-flow-config-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const walletsFile = (wallets) => {
  const file = path.join(dir, "cex.json");
  fs.writeFileSync(file, JSON.stringify({ wallets }));
  return file;
};
const projectWith = (wallets) => ({ slug: "hbar", dataDir: "public/data/hbar", config: { classification: { cexWallets: walletsFile(wallets) } } });

describe("hederaFlowChains", () => {
  it("lists the hedera chains with their native decimals and ignores other vms", () => {
    const config = { chains: [{ key: "hedera", vm: "hedera", asset: { kind: "native", decimals: 8 } }, { key: "ethereum", vm: "evm" }] };
    expect(hederaFlowChains(config).map((c) => [c.key, c.decimals])).toEqual([["hedera", 8]]);
    expect(hederaFlowChains({ chains: [{ key: "ethereum", vm: "evm" }] })).toEqual([]);
  });

  it("refuses a hedera chain without a native asset", () => {
    expect(() => hederaFlowChains({ chains: [{ key: "hedera", vm: "hedera" }] })).toThrow(/native/);
  });
});

describe("hederaFlowAccounts", () => {
  it("keeps config order, canonical ids and the exchange label", () => {
    const accounts = hederaFlowAccounts(projectWith([{ address: "0.0.615421", label: "Bybit" }, { address: " 0.0.37073 ", walletName: "Upbit" }]));
    expect(accounts).toEqual([{ id: "0.0.615421", exchange: "Bybit" }, { id: "0.0.37073", exchange: "Upbit" }]);
  });

  it("stops on an address that is not a Hedera account id", () => {
    expect(() => hederaFlowAccounts(projectWith([{ address: "0x" + "a".repeat(40), label: "X" }]))).toThrow(/not a Hedera account id/);
  });

  it("stops when one account is listed under two exchanges, and accepts a repeat under one", () => {
    expect(() => hederaFlowAccounts(projectWith([{ address: "0.0.5", label: "A" }, { address: "0.0.5", label: "B" }]))).toThrow(/listed under A and B/);
    expect(hederaFlowAccounts(projectWith([{ address: "0.0.5", label: "A" }, { address: "0.0.5", label: "A" }]))).toHaveLength(1);
  });

  it("is empty when the project declares no list", () => {
    expect(hederaFlowAccounts({ slug: "x", config: {} })).toEqual([]);
  });
});

describe("hederaFlowAsOf", () => {
  it("claims the target day only for a complete scan", () => {
    expect(hederaFlowAsOf({ complete: true, throughDate: "2026-11-10", throughBlock: 102188882 }, "hedera")).toEqual({ date: "2026-11-10", blocks: { hedera: 102188882 }, settled: true });
  });

  it("claims no day for an incomplete, missing or block-less state", () => {
    const none = { date: null, blocks: {}, settled: false, incomplete: ["hedera"] };
    expect(hederaFlowAsOf({ complete: false, throughDate: "2026-11-10", throughBlock: 1 }, "hedera")).toEqual(none);
    expect(hederaFlowAsOf(undefined, "hedera")).toEqual(none);
    expect(hederaFlowAsOf({ complete: true, throughDate: "2026-11-10" }, "hedera")).toEqual(none);
  });
});

describe("flowSetHash and planFlowResume", () => {
  const set = [{ id: "0.0.100001", exchange: "Alpha" }, { id: "0.0.200001", exchange: "Beta" }];
  const prevOf = (accounts, extra = {}) => ({ since: "2026-11-10", setHash: flowSetHash(accounts), accounts: { "0.0.100001": { until: "5.1" } }, ...extra });
  const store = { schema: 1, chains: { hedera: { days: { d: {} } }, other: { days: { keep: {} } } } };
  const plan = (over) => planFlowResume({ prev: prevOf(set), store, since: "2026-11-10", accounts: set, key: "hedera", ...over });

  it("the hash ignores config order and changes with the id set or a label", () => {
    expect(flowSetHash([...set].reverse())).toBe(flowSetHash(set));
    expect(flowSetHash(set.slice(1))).not.toBe(flowSetHash(set));
    expect(flowSetHash([...set, { id: "0.0.300001", exchange: "Alpha" }])).not.toBe(flowSetHash(set));
    expect(flowSetHash([set[0], { ...set[1], exchange: "Alpha" }])).not.toBe(flowSetHash(set));
  });

  it("resumes an unchanged set (also reordered) and keeps the store", () => {
    expect(plan().reason).toBeNull();
    expect(plan().prev).toEqual(prevOf(set));
    expect(plan({ accounts: [...set].reverse() }).reason).toBeNull();
    expect(plan().store).toEqual(store);
  });

  it("starts over, naming why, and clears only this chain's day rows", () => {
    for (const [over, why] of [
      [{ accounts: set.slice(1) }, /account set/],
      [{ accounts: [set[0], { ...set[1], exchange: "Gamma" }] }, /account set/],
      [{ since: "2026-11-01" }, /floor changed/],
      [{ store: null }, /day store is missing/],
      [{ prev: prevOf(set, { setHash: undefined }) }, /no account-set stamp/],
    ]) {
      const out = plan(over);
      expect(out.reason).toMatch(why);
      expect(out.prev).toBeNull();
      expect(out.store.chains.hedera).toBeUndefined();
      if (over.store !== null) expect(out.store.chains.other).toEqual(store.chains.other);
    }
    expect(store.chains.hedera).toBeDefined(); // the input is never mutated
  });

  it("a first scan has nothing to reset and no reason", () => {
    const out = plan({ prev: null, store: null });
    expect(out).toMatchObject({ prev: null, reason: null });
    expect(out.store.chains).toEqual({});
  });
});

describe("hederaFlowAsOf with an account-set stamp", () => {
  it("claims no day when the scan was made for another set", () => {
    const state = { complete: true, throughDate: "2026-11-10", throughBlock: 5, setHash: "aaa" };
    expect(hederaFlowAsOf(state, "hedera", "aaa").settled).toBe(true);
    expect(hederaFlowAsOf(state, "hedera", "bbb")).toEqual({ date: null, blocks: {}, settled: false, incomplete: ["hedera"] });
    expect(hederaFlowAsOf(state, "hedera").settled).toBe(true);
  });
});

describe("resolveDayEnds", () => {
  const T0 = 1_794_200_000;
  const mirror = () => {
    const mock = createMockMirror({ blockCount: 200_000, blockTime: (n) => T0 + n * 2 });
    return createHederaClock(createMirrorClient({ baseUrl: "https://mirror.test/api/v1", fetch: mock.fetch, sleep: async () => {}, maxRps: 1e6 }));
  };
  const memoryIo = () => {
    const files = new Map();
    return { files, io: { read: (p) => files.get(p) ?? {}, write: (p, v) => files.set(p, v) } };
  };
  const firstBlock = (date) => (Date.parse(`${date}T00:00:00Z`) / 1000 - T0) / 2;

  it("places each day's end at the last consensus time of block cutoff[D+1]-1 and starts after the previous day's end", async () => {
    const { files, io } = memoryIo();
    const out = await resolveDayEnds({ slug: "hbar", dataDir: "public/data/hbar" }, { key: "hedera", clock: mirror(), firstDate: "2026-11-10", lastDate: "2026-11-11", io, root: "/x" });
    const block = (d) => firstBlock(d) - 1;
    expect(Object.keys(out.ends)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
    expect(out.ends["2026-11-10"].block).toBe(block("2026-11-11"));
    expect(out.ends["2026-11-11"].block).toBe(block("2026-11-12"));
    expect(out.startStamp).toBe(out.ends["2026-11-09"].stamp);
    expect(Number(out.ends["2026-11-10"].stamp)).toBeCloseTo(T0 + (block("2026-11-11") + 1) * 2, 3);
    // The cutoffs it had to resolve are saved for the settle step and the feeds.
    const saved = [...files.values()][0].cutoffs.hedera;
    expect(Object.keys(saved)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(saved["2026-11-10"]).toBe(firstBlock("2026-11-10"));
  });

  it("keeps known ends without asking the mirror again", async () => {
    const { io } = memoryIo();
    const known = { "2026-11-09": { stamp: "1.0", block: 1 }, "2026-11-10": { stamp: "2.0", block: 2 } };
    const out = await resolveDayEnds({ slug: "hbar", dataDir: "public/data/hbar" }, { key: "hedera", clock: mirror(), firstDate: "2026-11-10", lastDate: "2026-11-10", known, io, root: "/x" });
    expect(out.ends).toEqual(known);
    expect(out.startStamp).toBe("1.0");
  });
});
