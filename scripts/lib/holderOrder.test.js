import { describe, expect, it } from "vitest";
import { hydrateChainHolders, resyncSnapshot, serializeSnapshot, serializeVerified } from "./snapshotFormat.js";
import { buildShards } from "./snapshotShards.js";
import {
  canonicalCheckpointChains,
  canonicalKeyOrder,
  compareAddress,
  compareHolders,
  sortHolders,
  sortWallets,
  walletComparator,
} from "./holderOrder.js";

// Deterministic Fisher-Yates so a failing shuffle is reproducible.
const shuffled = (items, seed) => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const holderRows = [
  { address: "0.0.9", balance: 5 },
  { address: "0.0.10", balance: 5 },
  { address: "0.0.2", balance: 5 },
  { address: "0.0.77", balance: 9 },
  { address: "0.0.3", balance: 1e-8 },
  { address: "0.0.30", balance: 1e-8 },
];

describe("compareAddress", () => {
  it("is plain code-unit order, not numeric and not case-folded", () => {
    expect(compareAddress("0.0.10", "0.0.9")).toBe(-1);
    expect(compareAddress("0xB", "0xa")).toBe(-1);
    expect(compareAddress("a", "a")).toBe(0);
    expect(compareAddress("b", "a")).toBe(1);
  });
});

describe("compareHolders / walletComparator", () => {
  it("orders account-number addresses by balance descending, then account number, whatever the input order", () => {
    const expected = ["0.0.77", "0.0.2", "0.0.9", "0.0.10", "0.0.3", "0.0.30"];
    for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
      expect(sortHolders(shuffled(holderRows, seed)).map((row) => row.address)).toEqual(expected);
    }
  });

  it("orders wallets by total_telcoin_balance the same way", () => {
    const wallets = holderRows.map((row) => ({ address: row.address, x_balance: row.balance, total_telcoin_balance: row.balance }));
    const sorted = sortWallets(shuffled(wallets, 11), "total_telcoin_balance");
    expect(sorted.map((row) => row.address)).toEqual(["0.0.77", "0.0.2", "0.0.9", "0.0.10", "0.0.3", "0.0.30"]);
  });

  it("orders every other address family by code-unit address, ties included", () => {
    const rows = [
      { address: "0xb", balance: 5 },
      { address: "0xB", balance: 5 },
      { address: "0xa", balance: 5 },
      { address: "0x10", balance: 5 },
      { address: "0xff", balance: 8 },
    ];
    for (const seed of [1, 2, 3]) {
      expect(sortHolders(shuffled(rows, seed)).map((row) => row.address)).toEqual(["0xff", "0x10", "0xB", "0xa", "0xb"]);
    }
    const mixed = [{ address: "0.0.10", balance: 1 }, { address: "0.0.9", balance: 1 }, { address: "0xa", balance: 1 }];
    expect(sortHolders(mixed).map((row) => row.address)).toEqual(["0.0.10", "0.0.9", "0xa"]);
  });

  it("is a total order: antisymmetric, transitive, zero only for the same row", () => {
    const rows = [...holderRows, { address: "0.0.9", balance: 5 }];
    for (const a of rows) {
      for (const b of rows) {
        expect(compareHolders(a, b) + compareHolders(b, a)).toBe(0);
        if (compareHolders(a, b) === 0) expect(a).toEqual(b);
        for (const c of rows) {
          if (compareHolders(a, b) <= 0 && compareHolders(b, c) <= 0) expect(compareHolders(a, c)).toBeLessThanOrEqual(0);
        }
      }
    }
    expect(walletComparator("total_telcoin_balance")({ address: "a", total_telcoin_balance: 1 }, { address: "b", total_telcoin_balance: 1 })).toBe(-1);
  });

  it("compares balances as numbers, so string balances never sort as text", () => {
    const rows = [{ address: "a", balance: "9" }, { address: "b", balance: "10" }, { address: "c", balance: 9.5 }];
    expect(sortHolders(rows).map((row) => row.address)).toEqual(["b", "c", "a"]);
  });

  it("sorts NaN and missing balances last, then by address, and stays total", () => {
    const rows = [
      { address: "0xd", balance: NaN },
      { address: "0xb" },
      { address: "0xa", balance: -1 },
      { address: "0xc", balance: 0 },
      { address: "0xe", balance: undefined },
    ];
    const expected = ["0xc", "0xa", "0xb", "0xd", "0xe"];
    for (const seed of [1, 2, 3, 4]) expect(sortHolders(shuffled(rows, seed)).map((row) => row.address)).toEqual(expected);
    for (const a of rows) for (const b of rows) expect(compareHolders(a, b) + compareHolders(b, a)).toBe(0);
  });

  it("never changes a balance or drops a row", () => {
    const sorted = sortHolders(shuffled(holderRows, 3));
    expect(sorted).toHaveLength(holderRows.length);
    expect(new Map(sorted.map((row) => [row.address, row.balance]))).toEqual(new Map(holderRows.map((row) => [row.address, row.balance])));
  });
});

describe("canonicalKeyOrder", () => {
  it("writes keys in code-unit ascending order and keeps every value", () => {
    const out = canonicalKeyOrder({ "0xb": "2", "0xa": "1", "0x10": "3" });
    expect(Object.keys(out)).toEqual(["0x10", "0xa", "0xb"]);
    expect(out).toEqual({ "0xa": "1", "0xb": "2", "0x10": "3" });
  });
});

describe("canonicalCheckpointChains", () => {
  const chains = {
    ethereum: {
      lastBlock: 10,
      rawBalances: { "0xb": "2", "0xa": "1" },
      v3: { lastBlock: 9, rawBalances: { "0xd": "4", "0xc": "3" }, retired: { "0xf": "6", "0xe": "5" } },
      v3Staking: { "0xmod": { lastBlock: 8, rawBalances: { "0xz": "9", "0xy": "8" } } },
    },
    hedera: { vm: "hedera", holders: 3 },
  };

  it("sorts every per-address map, keeps field order and values, and does not mutate", () => {
    const before = JSON.stringify(chains);
    const out = canonicalCheckpointChains(chains);
    expect(JSON.stringify(chains)).toBe(before);
    expect(Object.keys(out.ethereum)).toEqual(["lastBlock", "rawBalances", "v3", "v3Staking"]);
    expect(Object.keys(out.ethereum.rawBalances)).toEqual(["0xa", "0xb"]);
    expect(Object.keys(out.ethereum.v3.rawBalances)).toEqual(["0xc", "0xd"]);
    expect(Object.keys(out.ethereum.v3.retired)).toEqual(["0xe", "0xf"]);
    expect(Object.keys(out.ethereum.v3Staking["0xmod"].rawBalances)).toEqual(["0xy", "0xz"]);
    expect(out.hedera).toEqual(chains.hedera);
    expect(out.ethereum.rawBalances).toEqual(chains.ethereum.rawBalances);
  });

  it("serializes to identical bytes for any insertion order of the same balances", () => {
    const entries = Object.entries(chains.ethereum.rawBalances);
    const bytes = new Set();
    for (const seed of [1, 2, 3, 4]) {
      const swapped = { ...chains, ethereum: { ...chains.ethereum, rawBalances: Object.fromEntries(shuffled(entries, seed)) } };
      bytes.add(JSON.stringify(canonicalCheckpointChains(swapped)));
    }
    expect(bytes.size).toBe(1);
  });
});

describe("snapshot writers: shuffled scan order gives identical bytes", () => {
  const build = (ids, seed) => {
    const rows = ids.map((id) => ({ address: `0.0.${id}`, balance: id % 4 === 0 ? 100 : 7 }));
    const wallets = sortWallets(shuffled(rows, seed).map((row) => ({ address: row.address, hedera_balance: row.balance, total_telcoin_balance: row.balance })), "total_telcoin_balance");
    const holders = sortHolders(shuffled(rows, seed + 100));
    return {
      generatedAt: "2026-11-22T00:00:00.000Z",
      chains: { hedera: { key: "hedera", metrics: { holderCount: holders.length, totalBalance: 0 }, holders } },
      wallets,
      chainOrder: ["hedera"],
    };
  };
  const ids = [9, 10, 2, 100, 33, 1000001, 8, 12, 1000000, 77, 5, 4];

  it("slim-v1 bytes do not depend on the insertion order", () => {
    const texts = new Set([1, 2, 3, 4, 5].map((seed) => serializeSnapshot(build(ids, seed))));
    expect(texts.size).toBe(1);
  });

  it("legacy (two chains) bytes do not depend on the insertion order", () => {
    const legacy = (seed) => {
      const snap = build(ids, seed);
      snap.chains.other = { key: "other", metrics: { holderCount: 0, totalBalance: 0 }, holders: [] };
      return serializeSnapshot(snap);
    };
    expect(new Set([1, 2, 3].map(legacy)).size).toBe(1);
  });

  it("sharded-v1 head and shards do not depend on the insertion order", () => {
    const outputs = new Set(
      [1, 2, 3, 4].map((seed) => {
        const built = buildShards(build(ids, seed));
        return built.headText + built.shards.map((shard) => `${shard.file}:${shard.data.toString("utf8")}`).join("|");
      }),
    );
    expect(outputs.size).toBe(1);
  });
});

describe("first night: a slim file written in scan order (ties not by address) is still accepted", () => {
  // Ties in scan order: c before a before b at balance 5, e before d at balance 2 (not address order).
  const addr = (suffix) => `0x${suffix.padStart(40, "0")}`;
  const oldOrder = [
    [addr("f"), 9],
    [addr("c"), 5],
    [addr("a"), 5],
    [addr("b"), 5],
    [addr("e"), 2],
    [addr("d"), 2],
    [addr("1"), 1],
  ];
  const holders = oldOrder.map(([address, balance]) => ({ address, balance }));
  const old = {
    generatedAt: "2026-11-21T00:00:00.000Z",
    chains: { ethereum: { key: "ethereum", metrics: { holderCount: holders.length, totalBalance: 0 }, holders } },
    wallets: oldOrder.map(([address, balance]) => ({ address, ethereum_balance: balance, total_telcoin_balance: balance })),
    chainOrder: ["ethereum"],
  };
  const quiet = { warn() {}, log() {} };

  it("reads, resyncs, writes and re-reads with the same holders, none added or dropped, no round-trip refusal", () => {
    const readBack = hydrateChainHolders(JSON.parse(serializeSnapshot(old)));
    expect(readBack.chains.ethereum.holders).toEqual(holders);

    const { snapshot, added, removed } = resyncSnapshot(readBack, new Set(), 1000);
    expect([added, removed]).toEqual([0, 0]);
    const text = serializeVerified(snapshot, "synthetic.json", quiet); // throws if holders do not survive the round trip
    const again = hydrateChainHolders(JSON.parse(text));
    const key = (h) => `${h.address}|${h.balance}`;
    expect(again.chains.ethereum.holders.map(key).sort()).toEqual(holders.map(key).sort());
    expect(again.wallets).toEqual(old.wallets);
  });
});
