import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildChainStatus } from "./chainStatus.js";
import { buildReconciliation } from "./reconcileSupply.js";
import { createNonRetailChecker, loadNonRetailSet, normalizeAddress } from "./nonRetailSet.js";
import { buildOverlapStats, buildSnapshotData, buildViewData } from "./holdersView.js";
import { projectNonRetailPaths, resolveProject } from "./projects.js";
import { reconcileHistoryEntry } from "./holderHistoryReconcile.js";

const SOL_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOL_B = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const SOL_LOCK = "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG";
const EVM_A = "0xaaaa000000000000000000000000000000000000";
const EVM_LOCK = "0x1111000000000000000000000000000000000000";

describe("chain-status.json with a Solana chain", () => {
  it("EVM entries stay { lastBlock }; Solana carries vm + scannedAt (slot as lastBlock)", () => {
    const status = buildChainStatus(
      {
        generatedAt: "2026-10-25T12:00:00.000Z",
        chains: {
          ethereum: { lastBlock: 100, rawBalances: {} },
          solana: { vm: "solana", lastBlock: 300_000_000, lastSlot: 300_000_000, scannedAt: "2026-10-25T11:59:00.000Z" },
        },
      },
      ["ethereum", "solana"],
    );
    expect(status.chains).toEqual({
      ethereum: { lastBlock: 100 },
      solana: { lastBlock: 300_000_000, vm: "solana", scannedAt: "2026-10-25T11:59:00.000Z" },
    });
  });
});

describe("non-retail sets with base58 addresses", () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-nr-"));
    fs.writeFileSync(path.join(tmp, "ex.json"), JSON.stringify({ addresses: [SOL_A, EVM_A.toUpperCase().replace("0X", "0x"), "junk"] }));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("keeps base58 case, lowercases hex, adds project role addresses", async () => {
    expect(normalizeAddress(SOL_A)).toBe(SOL_A);
    const { set } = await loadNonRetailSet({ exclusionsPath: path.join(tmp, "ex.json"), cexPath: null, dexPath: null, extraAddresses: [SOL_LOCK] });
    expect([...set].sort()).toEqual([EVM_A, SOL_LOCK, SOL_A].sort());
    const isNonRetail = createNonRetailChecker(set);
    expect(isNonRetail(SOL_A)).toBe(true);
    expect(isNonRetail(SOL_A.toLowerCase())).toBe(false); // a different (invalid) key
  });

  it("TEL's non-retail paths are unchanged (no role extras)", () => {
    expect(Object.keys(projectNonRetailPaths(resolveProject("tel")))).toEqual(["exclusionsPath", "cexPath", "dexPath"]);
  });
});

describe("feeds: combined merges EVM + Solana chains", () => {
  const snapshot = {
    generatedAt: "2026-10-25T12:00:00.000Z",
    chainOrder: ["ethereum", "solana"],
    totals: { totalSupply: 1000 },
    chains: {
      ethereum: { holders: [{ address: EVM_A, balance: 600 }, { address: EVM_LOCK, balance: 100 }] },
      solana: { holders: [{ address: SOL_A, balance: 200 }, { address: SOL_B, balance: 100 }] },
    },
  };
  const isNonRetail = (a) => a === EVM_LOCK;

  it("views.solana and combined use the same shapes; dedup only within a format", () => {
    const current = buildSnapshotData(snapshot, null, isNonRetail);
    expect(current.chainOrder).toEqual(["ethereum", "solana"]);
    expect(current.chains.solana.metrics.holderCount).toBe(2);
    expect(current.combined.holderCount).toBe(3);
    const sol = buildViewData("solana", current, null);
    const combined = buildViewData("combined", current, null);
    expect(Object.keys(sol).sort()).toEqual(Object.keys(combined).sort());
    expect(buildOverlapStats(snapshot.chains, snapshot.chainOrder)).toMatchObject({ uniqueCount: 4, multiChainCount: 0 });
  });
});

describe("supply reconciliation for a bridge-netting snapshot", () => {
  it("counts native/burn-mint chains, drops origin locks backing lock-mint mirrors", () => {
    const snap = {
      chainOrder: ["ethereum", "polygon", "solana"],
      totals: {
        method: "bridge-netting",
        totalSupply: 1100,
        originChain: "ethereum",
        bridgeModes: { ethereum: "origin", polygon: "lock-mint", solana: "native" },
        lockAddresses: [EVM_LOCK],
        tokens: { legacy: { ethereum: 1000, polygon: 300, solana: 100 }, v3: {}, retiredLegacy: {}, strandedInUpgrade: {} },
      },
      wallets: [
        { address: EVM_LOCK, ethereum_balance: 300, polygon_balance: 0, solana_balance: 0 },
        { address: EVM_A, ethereum_balance: 700, polygon_balance: 300, solana_balance: 0 },
        { address: SOL_A, ethereum_balance: 0, polygon_balance: 0, solana_balance: 100 },
      ],
    };
    const r = buildReconciliation(snap, { labels: {} }, { wallets: [] }, { totalSupply: 1100, coingeckoCirculating: null });
    expect(r.bridgeLocked).toBe(300);
    expect(r.mirrored).toBe(300);
    expect(r.mirrorResidual).toBe(0);
    expect(r.counted).toBe(1100);
    expect(r.residual).toBe(0);
    expect(r.derivedOriginTotal).toBe(1100);
    expect(r.categories.retail).toBe(1100);
  });
});

describe("holders-history row for a Solana-only snapshot", () => {
  it("history entry keeps chains.solana with matching holder counts through reconcileHistoryEntry", () => {
    const snapshot = {
      generatedAt: "2026-10-25T12:00:00.000Z",
      chainOrder: ["solana"],
      totals: { totalSupply: 300 },
      chains: { solana: { holders: [{ address: SOL_A, balance: 200 }, { address: SOL_B, balance: 100 }] } },
    };
    const current = buildSnapshotData(snapshot, null, () => false);
    const sol = buildViewData("solana", current, null);
    const combined = buildViewData("combined", current, null);
    const entry = reconcileHistoryEntry({
      date: "2026-10-25",
      combined: { holderCount: current.combined.holderCount, totalBalance: current.combined.totalBalance },
      distribution: combined.distribution,
      chains: {
        solana: {
          holderCount: current.chains.solana.metrics.holderCount,
          totalBalance: current.chains.solana.metrics.totalBalance,
          distribution: sol.distribution,
        },
      },
    });
    expect(Object.keys(entry.chains)).toEqual(["solana"]);
    expect(entry.chains.solana.holderCount).toBe(2);
    expect(entry.combined.holderCount).toBe(entry.chains.solana.holderCount);
    const sum = (d) => (d ?? []).reduce((s, r) => s + (Number(r.count) || 0), 0);
    if (Array.isArray(entry.chains.solana.distribution)) expect(sum(entry.chains.solana.distribution)).toBe(2);
    if (Array.isArray(entry.distribution)) expect(sum(entry.distribution)).toBe(2);
  });
});
