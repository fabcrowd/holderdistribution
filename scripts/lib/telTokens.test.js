import { describe, expect, it } from "vitest";
import {
  ZERO_ADDRESS,
  rawToTel,
  resolveChainTokens,
  emptyV3State,
  applyV3Batch,
  combineChainBalances,
  v3StateToCheckpoint,
  v3StateFromCheckpoint,
} from "./telTokens.js";
import { scanV3Chain } from "./v3Scan.js";
import chains from "../../config/chains.json";

const TM = "0x2703e00cae30a7707e4d18c38f8cb6a4a40c2703";
const MV = "0x222213deb441c5a9f71df2942db431978a733333";
const ALICE = "0xaaaa000000000000000000000000000000000001";
const BOB = "0xbbbb000000000000000000000000000000000002";
const BRIDGE = "0xcccc000000000000000000000000000000000003";
const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a) => "0x" + a.slice(2).padStart(64, "0");
const log = (from, to, value, tx) => ({
  topics: [T, topic(from), topic(to)],
  data: "0x" + BigInt(value).toString(16).padStart(64, "0"),
  transactionHash: tx,
});
// raw amounts for N whole TEL
const L = (tel) => BigInt(Math.round(tel * 100)); // legacy: 2 decimals
const V = (tel) => BigInt(Math.round(tel * 100)) * 10n ** 16n; // v3: 18 decimals
const CFG = { escrow: [TM, MV], legacyDecimals: 2, v3Decimals: 18 };

describe("rawToTel", () => {
  it("normalises each token by its own decimals", () => {
    expect(rawToTel(123456n, 2)).toBe(1234.56);
    expect(rawToTel(1_234_560_000_000_000_000_000n, 18)).toBe(1234.56);
    expect(rawToTel(5n, 0)).toBe(5);
  });
  it("keeps full precision for 18-decimal balances at supply scale", () => {
    // 100B TEL at 18 decimals is 1e29 raw: a naive Number(raw)/1e18 is fine
    // here, but the fractional part must survive the whole/fraction split.
    expect(rawToTel(100_000_000_000n * 10n ** 18n + 5n * 10n ** 17n, 18)).toBe(100_000_000_000.5);
    expect(rawToTel(1n, 18)).toBe(1e-18);
  });
  it("handles negatives", () => {
    expect(rawToTel(-250n, 2)).toBe(-2.5);
  });
});

describe("resolveChainTokens (config/chains.json)", () => {
  it("reads per-token decimals and the v3 deployment block from config", () => {
    for (const key of ["ethereum", "polygon", "base"]) {
      const t = resolveChainTokens({ ...chains[key], key });
      expect(t.legacy.decimals).toBe(2);
      expect(t.v3.decimals).toBe(18);
      expect(t.v3.address).toBe("0x7e13b43065380acdec1c2d138c579cbbbafa0731");
      expect(t.v3.deployBlock).toBeGreaterThan(0);
      expect(t.escrow).toEqual([TM, MV]);
    }
  });
  it("takes the v3 decimals from config, not a constant", () => {
    const t = resolveChainTokens({
      key: "x",
      tokens: {
        legacy: { address: "0x" + "1".repeat(40), decimals: 6 },
        v3: { address: "0x" + "2".repeat(40), decimals: 9 },
      },
    });
    expect([t.legacy.decimals, t.v3.decimals]).toEqual([6, 9]);
  });
  it("stays legacy-only (and defaults to 2 decimals) when there is no tokens block", () => {
    const t = resolveChainTokens({ key: "old", tokenAddress: "0x" + "A".repeat(40) });
    expect(t.legacy).toEqual({ address: "0x" + "a".repeat(40), decimals: 2 });
    expect(t.v3).toBeNull();
    expect(t.escrow).toEqual([]);
  });
  it("rejects a v3 token with fewer decimals than legacy", () => {
    expect(() =>
      resolveChainTokens({
        key: "bad",
        tokens: { legacy: { address: "0x" + "1".repeat(40), decimals: 18 }, v3: { address: "0x" + "2".repeat(40), decimals: 2 } },
      }),
    ).toThrow(/unsupported/);
  });
  it("fails loudly on a malformed decimals value instead of producing NaN balances", () => {
    expect(() => resolveChainTokens({ key: "bad", tokenAddress: "0x" + "1".repeat(40), decimals: "abc" })).toThrow(/decimals/);
  });
});

describe("applyV3Batch: swap detection and double-count avoidance", () => {
  const run = (v3Logs, legacyLogs) => {
    const state = emptyV3State();
    applyV3Batch(state, v3Logs, legacyLogs, CFG);
    return state;
  };

  it("retires legacy that entered an upgrade contract in the same tx that minted v3", () => {
    const s = run(
      [log(ZERO_ADDRESS, ALICE, V(1000), "0xt1")],
      [log(ALICE, TM, L(1000), "0xt1")],
    );
    expect(s.raw.get(ALICE)).toBe(V(1000));
    expect(s.retired.get(TM)).toBe(L(1000));
  });

  it("does NOT retire legacy sent to the contract without a v3 mint (stranded, still counted)", () => {
    const s = run(
      [log(ZERO_ADDRESS, ALICE, V(1000), "0xt1")],
      [log(ALICE, TM, L(1000), "0xt1"), log(BOB, TM, L(224.38), "0xstray")],
    );
    expect(s.retired.get(TM)).toBe(L(1000));
  });

  it("ignores v3 mints that have no legacy leg (bridge mints)", () => {
    const s = run([log(ZERO_ADDRESS, BOB, V(5000), "0xbridge")], []);
    expect(s.raw.get(BOB)).toBe(V(5000));
    expect(s.retired.size).toBe(0);
  });

  it("never retires more than the v3 issued in that transaction", () => {
    const s = run(
      [log(ZERO_ADDRESS, ALICE, V(100), "0xt1")],
      [log(ALICE, TM, L(100), "0xt1"), log(ALICE, TM, L(40), "0xt1")],
    );
    expect(s.retired.get(TM)).toBe(L(100));
  });

  it("counts a Phase-2 vault release (v3 leaves the vault) as an issuance", () => {
    const s = run(
      [log(MV, ALICE, V(250), "0xp2")],
      [log(ALICE, MV, L(250), "0xp2")],
    );
    expect(s.retired.get(MV)).toBe(L(250));
    expect(s.raw.get(ALICE)).toBe(V(250));
    expect(s.raw.get(MV)).toBe(-V(250));
  });

  it("burns reduce balances and zero-address transfers are never credited", () => {
    const s = run(
      [log(ZERO_ADDRESS, ALICE, V(10), "0xm"), log(ALICE, ZERO_ADDRESS, V(4), "0xb")],
      [],
    );
    expect(s.raw.get(ALICE)).toBe(V(6));
    expect(s.raw.has(ZERO_ADDRESS)).toBe(false);
  });

  it("is order independent across batches (parallel chunk delivery)", () => {
    const a = [[log(ZERO_ADDRESS, ALICE, V(100), "0x1")], [log(ALICE, TM, L(100), "0x1")]];
    const b = [[log(ALICE, BOB, V(30), "0x2")], []];
    const s1 = emptyV3State();
    applyV3Batch(s1, ...a, CFG);
    applyV3Batch(s1, ...b, CFG);
    const s2 = emptyV3State();
    applyV3Batch(s2, ...b, CFG);
    applyV3Batch(s2, ...a, CFG);
    expect([...s1.raw].sort()).toEqual([...s2.raw].sort());
    expect([...s1.retired]).toEqual([...s2.retired]);
  });
});

describe("combineChainBalances: legacy (2 dec) + v3 (18 dec)", () => {
  it("adds both tokens in TEL units and nets out retired legacy on the upgrade contract", () => {
    const legacyRaw = new Map([
      [ALICE, L(500)], // never swapped
      [BOB, 0n], // swapped everything
      [TM, L(1000 + 224.38)], // 1000 swapped + 224.38 stranded
    ]);
    const v3Raw = new Map([[BOB, V(1000)], [ALICE, V(2.5)]]);
    const retired = new Map([[TM, L(1000)]]);
    const c = combineChainBalances({ legacyRaw, legacyDecimals: 2, v3Raw, v3Decimals: 18, retired });
    expect(c.balances.get(ALICE)).toBe(502.5);
    expect(c.balances.get(BOB)).toBe(1000);
    expect(c.balances.get(TM)).toBe(224.38); // only the stranded remainder is counted
    expect(c.v3ByAddress.get(ALICE)).toBe(2.5);
    expect(c.totals.legacy).toBe(1724.38);
    expect(c.totals.v3).toBe(1002.5);
    expect(c.totals.retiredLegacy).toBe(1000);
  });

  it("counts swapped TEL exactly once (the 103B -> 100B fix in miniature)", () => {
    // 1,000 TEL swapped: legacy moved Alice -> TokenMigration, v3 minted to Alice.
    const legacyRaw = new Map([[TM, L(1000)], [BOB, L(9000)]]);
    const v3Raw = new Map([[ALICE, V(1000)]]);
    const naive = combineChainBalances({ legacyRaw, legacyDecimals: 2, v3Raw, v3Decimals: 18 });
    const netted = combineChainBalances({ legacyRaw, legacyDecimals: 2, v3Raw, v3Decimals: 18, retired: new Map([[TM, L(1000)]]) });
    const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
    expect(sum(naive.balances)).toBe(11_000); // double counted
    expect(sum(netted.balances)).toBe(10_000);
  });

  it("is byte-for-byte the legacy-only result when v3 is absent", () => {
    const legacyRaw = new Map([[ALICE, 12345n], [BOB, 1n], [BRIDGE, 0n], [TM, -5n]]);
    const c = combineChainBalances({ legacyRaw, legacyDecimals: 2 });
    expect([...c.balances]).toEqual([[ALICE, 123.45], [BOB, 0.01]]);
    expect(c.totals).toEqual({ legacy: 123.46, v3: 0, retiredLegacy: 0 });
    expect(c.v3ByAddress.size).toBe(0);
  });

  it("applies the one-legacy-unit dust floor to the COMBINED balance", () => {
    const legacyRaw = new Map([[ALICE, 0n]]);
    const v3Raw = new Map([
      [ALICE, 10n ** 15n], // 0.001 TEL of v3: below 0.01 TEL, dropped
      [BOB, 10n ** 16n], // exactly 0.01 TEL: kept
    ]);
    const c = combineChainBalances({ legacyRaw, legacyDecimals: 2, v3Raw, v3Decimals: 18 });
    expect(c.balances.has(ALICE)).toBe(false);
    expect(c.balances.get(BOB)).toBe(0.01);
  });

  it("treats a negative raw legacy balance as zero without flagging it (scan artifact, as before v3)", () => {
    const c = combineChainBalances({
      legacyRaw: new Map([[ALICE, -L(5)], [BOB, L(1)]]),
      legacyDecimals: 2,
      v3Raw: new Map([[ALICE, V(3)]]),
      v3Decimals: 18,
    });
    expect(c.balances.get(ALICE)).toBe(3); // the v3 is not eaten by the negative legacy
    expect(c.negativeRetired).toEqual([]);
    expect(c.totals.legacy).toBe(1); // only positive balances make up supply
  });

  it("clamps (and reports) retired > held instead of producing a negative holder", () => {
    const c = combineChainBalances({
      legacyRaw: new Map([[TM, L(10)]]),
      legacyDecimals: 2,
      v3Raw: new Map([[ALICE, V(50)]]),
      v3Decimals: 18,
      retired: new Map([[TM, L(50)]]),
    });
    expect(c.balances.has(TM)).toBe(false);
    expect(c.negativeRetired).toEqual([TM]);
  });
});

describe("v3 checkpoint round trip", () => {
  it("serialises exactly and resumes from lastBlock + 1", async () => {
    const state = emptyV3State();
    applyV3Batch(state, [log(ZERO_ADDRESS, ALICE, V(7.25), "0x1")], [log(ALICE, TM, L(7.25), "0x1")], CFG);
    const cp = v3StateToCheckpoint(state, 150);
    expect(cp.rawBalances[ALICE]).toBe(V(7.25).toString());
    expect(cp.retired[TM]).toBe(L(7.25).toString());
    const back = v3StateFromCheckpoint(JSON.parse(JSON.stringify(cp)));
    expect(back.raw.get(ALICE)).toBe(V(7.25));
    expect(back.retired.get(TM)).toBe(L(7.25));

    const calls = [];
    const r = await scanV3Chain({
      deployBlock: 100,
      toBlock: 220,
      chunkSize: 50,
      checkpoint: cp,
      cfg: CFG,
      fetchV3: async (from, to) => {
        calls.push([from, to]);
        return from === 151 ? [log(ALICE, BOB, V(2), "0x2")] : [];
      },
      fetchEscrowLegacy: async () => [],
    });
    expect(calls[0][0]).toBe(151); // resumed after the checkpoint, not at the deploy block
    expect(calls[calls.length - 1][1]).toBe(220);
    expect(r.state.raw.get(BOB)).toBe(V(2));
    expect(r.state.raw.get(ALICE)).toBe(V(5.25));
  });

  it("starts at the v3 deployment block with no checkpoint (nothing earlier is fetched)", async () => {
    const calls = [];
    await scanV3Chain({
      deployBlock: 1_000,
      toBlock: 1_250,
      chunkSize: 100,
      concurrency: 2,
      cfg: CFG,
      fetchV3: async (from, to) => (calls.push([from, to]), []),
      fetchEscrowLegacy: async () => [],
    });
    expect(calls).toEqual([[1000, 1099], [1100, 1199], [1200, 1250]]);
  });

  it("refuses to scan without a deployment block rather than scanning from genesis", async () => {
    await expect(
      scanV3Chain({ deployBlock: NaN, toBlock: 10, chunkSize: 5, cfg: CFG, fetchV3: async () => [], fetchEscrowLegacy: async () => [] }),
    ).rejects.toThrow(/deployBlock/);
  });
});
