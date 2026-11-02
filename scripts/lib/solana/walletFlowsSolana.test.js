import { describe, expect, it } from "vitest";
import {
  aggregateWalletOutflows,
  buildSolanaWalletRows,
  classifyFrom,
  classifyWalletTransfers,
  distributionFromRecon,
  pruneEvents,
  sampleTxs,
  solanaSellTotals,
  toWalletEvents,
} from "./walletFlowsSolana.js";

const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 86400;

// Synthetic base58-looking addresses. WALLET_LOWER differs from WALLET only by case.
const WALLET = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const WALLET_LOWER = WALLET.toLowerCase();
const CEX_HOT = "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ";
const DEX_POOL = "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w";
const STAKE_VAULT = "HJqK7re4GDSm4roQQS2iSLt5p7Gyb9MHBy9dHJw9obUp";
const OTHER_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const UNKNOWN = "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w";

const roles = () => ({
  wallets: new Set([WALLET, WALLET_LOWER, OTHER_WALLET]),
  cex: new Map([[CEX_HOT, "MEXC"]]),
  dex: new Set([DEX_POOL]),
  staking: new Set([STAKE_VAULT]),
});

const event = (overrides) => ({
  wallet: WALLET,
  kind: "CEX",
  venue: "MEXC",
  dest: CEX_HOT,
  raw: "1000000",
  t: NOW,
  sig: "sig-default",
  ...overrides,
});

describe("classifyWalletTransfers", () => {
  it("labels each destination: CEX, DEX, staking, internal, unlabelled", () => {
    const transfers = [
      { from: WALLET, to: CEX_HOT, raw: 1n },
      { from: WALLET, to: DEX_POOL, raw: 2n },
      { from: WALLET, to: STAKE_VAULT, raw: 3n },
      { from: WALLET, to: OTHER_WALLET, raw: 4n },
      { from: WALLET, to: UNKNOWN, raw: 5n },
    ];
    const out = classifyWalletTransfers(transfers, roles());
    expect(out.map((o) => [o.kind, o.venue])).toEqual([
      ["CEX", "MEXC"],
      ["DEX", "dex"],
      ["staking", null],
      ["internal", null],
      ["unlabelled", null],
    ]);
    expect(out[0]).toEqual({ wallet: WALLET, dest: CEX_HOT, kind: "CEX", venue: "MEXC", raw: 1n });
  });

  it("gives CEX precedence when the destination is both a CEX and a registry wallet", () => {
    const r = roles();
    r.wallets.add(CEX_HOT);
    const [row] = classifyWalletTransfers([{ from: WALLET, to: CEX_HOT, raw: 9n }], r);
    expect(row.kind).toBe("CEX");
  });

  it("ignores mint and burn legs (from or to null)", () => {
    const transfers = [
      { from: null, to: WALLET, raw: 10n },
      { from: WALLET, to: null, raw: 11n },
    ];
    expect(classifyWalletTransfers(transfers, roles())).toEqual([]);
  });

  it("ignores transfers whose sender is not a registry wallet", () => {
    const transfers = [{ from: UNKNOWN, to: CEX_HOT, raw: 12n }];
    expect(classifyWalletTransfers(transfers, roles())).toEqual([]);
  });

  it("keeps case-differing addresses as separate wallets", () => {
    const transfers = [
      { from: WALLET, to: CEX_HOT, raw: 1n },
      { from: WALLET_LOWER, to: CEX_HOT, raw: 2n },
    ];
    const out = classifyWalletTransfers(transfers, roles());
    expect(out.map((o) => o.wallet)).toEqual([WALLET, WALLET_LOWER]);
  });
});

describe("classifyFrom", () => {
  it("keeps transfers from the given sender whatever the registry says and labels each destination", () => {
    const transfers = [
      { from: UNKNOWN, to: CEX_HOT, raw: 7n },
      { from: UNKNOWN, to: DEX_POOL, raw: 8n },
      { from: WALLET, to: CEX_HOT, raw: 1n },
      { from: null, to: UNKNOWN, raw: 2n },
      { from: UNKNOWN, to: null, raw: 3n },
      { from: WALLET_LOWER, to: CEX_HOT, raw: 4n },
    ];
    expect(classifyFrom(transfers, UNKNOWN, roles())).toEqual([
      { wallet: UNKNOWN, dest: CEX_HOT, kind: "CEX", venue: "MEXC", raw: 7n },
      { wallet: UNKNOWN, dest: DEX_POOL, kind: "DEX", venue: "dex", raw: 8n },
    ]);
  });

  it("matches the sender exactly, so a case-differing address is not included", () => {
    const out = classifyFrom([{ from: WALLET_LOWER, to: CEX_HOT, raw: 4n }], WALLET, roles());
    expect(out).toEqual([]);
  });
});

describe("toWalletEvents", () => {
  it("adds signature, blockTime and a string raw amount", () => {
    const classified = classifyWalletTransfers([{ from: WALLET, to: CEX_HOT, raw: 1500000n }], roles());
    const [ev] = toWalletEvents(classified, { signature: "abc", blockTime: NOW });
    expect(ev).toEqual({ wallet: WALLET, kind: "CEX", venue: "MEXC", dest: CEX_HOT, raw: "1500000", t: NOW, sig: "abc" });
    expect(JSON.parse(JSON.stringify(ev))).toEqual(ev);
  });
});

describe("pruneEvents", () => {
  it("drops events older than 90 days and keeps the boundary second", () => {
    const boundary = NOW - 90 * DAY;
    const events = [event({ t: boundary - 1, sig: "old" }), event({ t: boundary, sig: "edge" })];
    expect(pruneEvents(events, NOW).map((e) => e.sig)).toEqual(["edge"]);
  });
});

describe("aggregateWalletOutflows", () => {
  it("counts an event at exactly now minus 72h in the 72h window", () => {
    const events = [event({ t: NOW - 72 * HOUR })];
    const agg = aggregateWalletOutflows(events, NOW, 6);
    expect(agg.get(WALLET)["72h"]).toEqual({ CEX: 1 });
    expect(agg.get(WALLET)["30d"]).toEqual({ CEX: 1 });
  });

  it("excludes an event one second older than 72h from 72h but keeps it in 30d", () => {
    const events = [event({ t: NOW - 72 * HOUR - 1 })];
    const agg = aggregateWalletOutflows(events, NOW, 6);
    expect(agg.get(WALLET)["72h"]).toEqual({});
    expect(agg.get(WALLET)["30d"]).toEqual({ CEX: 1 });
    expect(agg.get(WALLET)["90d"]).toEqual({ CEX: 1 });
  });

  it("converts a string raw amount with decimals 6 (1500000 -> 1.5)", () => {
    const agg = aggregateWalletOutflows([event({ raw: "1500000" })], NOW, 6);
    expect(agg.get(WALLET)["72h"]).toEqual({ CEX: 1.5 });
  });

  it("sums per kind and keeps wallets separate when addresses differ only in case", () => {
    const events = [
      event({ raw: "1000000", sig: "a" }),
      event({ raw: "2000000", sig: "b" }),
      event({ kind: "DEX", venue: "dex", dest: DEX_POOL, raw: "500000", sig: "c" }),
      event({ wallet: WALLET_LOWER, raw: "4000000", sig: "d" }),
    ];
    const agg = aggregateWalletOutflows(events, NOW, 6);
    expect(agg.get(WALLET)["72h"]).toEqual({ CEX: 3, DEX: 0.5 });
    expect(agg.get(WALLET_LOWER)["72h"]).toEqual({ CEX: 4 });
  });

  it("omits wallets with no events", () => {
    const agg = aggregateWalletOutflows([event()], NOW, 6);
    expect(agg.has(OTHER_WALLET)).toBe(false);
  });

  it("keeps precision for large raw amounts by summing BigInt before dividing", () => {
    const big = "123456789012345678901234";
    const agg = aggregateWalletOutflows([event({ raw: big }), event({ raw: "1", sig: "b" })], NOW, 18);
    expect(agg.get(WALLET)["72h"].CEX).toBeCloseTo(123456.789012345678901234 + 0.000000000000000001, 6);
  });
});

describe("sampleTxs", () => {
  it("returns sell-venue sigs largest first and excludes internal and unlabelled", () => {
    const events = [
      event({ raw: "1000000", sig: "small" }),
      event({ raw: "9000000", sig: "big" }),
      event({ kind: "DEX", venue: "dex", raw: "5000000", sig: "mid" }),
      event({ kind: "internal", venue: null, raw: "99000000", sig: "internal" }),
      event({ kind: "unlabelled", venue: null, raw: "99000000", sig: "unlabelled" }),
    ];
    const samples = sampleTxs(events, NOW);
    expect(samples.get(WALLET)).toEqual([
      "https://solscan.io/tx/big",
      "https://solscan.io/tx/mid",
      "https://solscan.io/tx/small",
    ]);
  });

  it("ignores sell events older than 90 days and caps the list at limit", () => {
    const events = [
      event({ raw: "1", sig: "old", t: NOW - 90 * DAY - 1 }),
      event({ raw: "3", sig: "x" }),
      event({ raw: "2", sig: "y" }),
      event({ raw: "1", sig: "z" }),
    ];
    expect(sampleTxs(events, NOW, 2).get(WALLET)).toEqual(["https://solscan.io/tx/x", "https://solscan.io/tx/y"]);
  });

  it("omits wallets with no sell-venue events", () => {
    const events = [event({ kind: "internal", venue: null, sig: "i" })];
    expect(sampleTxs(events, NOW).has(WALLET)).toBe(false);
  });
});

describe("buildSolanaWalletRows", () => {
  const registry = {
    knownWallets: [
      { address: WALLET, label: "Seller", group: "g", entityClass: "seller", source: "s", confidence: "medium", chains: ["solana"] },
      { address: WALLET_LOWER, label: "Seller lower", group: "g", entityClass: "seller", source: "s", confidence: "medium" },
      { address: OTHER_WALLET, label: "Escrow", group: "g", entityClass: "escrow", source: "s", confidence: "confirmed" },
      { address: STAKE_VAULT, label: "Quiet", group: "g", entityClass: "treasury", source: "s", confidence: "confirmed" },
    ],
  };
  const events = [
    event({ raw: "2000000", sig: "a" }),
    event({ kind: "DEX", venue: "dex", dest: DEX_POOL, raw: "1000000", sig: "c" }),
    event({ wallet: OTHER_WALLET, raw: "10000000", sig: "b" }),
    event({ wallet: WALLET_LOWER, raw: "4000000", sig: "d" }),
  ];
  const flows = aggregateWalletOutflows(events, NOW, 6);
  const samples = sampleTxs(events, NOW);
  const balances = new Map([
    [WALLET, 1234.4],
    [WALLET_LOWER, 0],
  ]);
  const rows = buildSolanaWalletRows(registry, flows, balances, 0.5, samples);
  const rowFor = (address) => rows.find((r) => r.address === address);

  it("returns exactly the EVM row keys", () => {
    const keys = [
      "address", "balance", "balanceDetail", "balanceUsd", "chains", "confidence", "entityClass", "group", "label",
      "outflows", "sampleTxs", "sellVenue", "sellVenueUsd90d", "source", "verdict",
    ];
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(keys);
  });

  it("computes balances, windows, USD values and sample links for a seller", () => {
    expect(rowFor(WALLET)).toMatchObject({
      balance: 1234,
      balanceDetail: { solana: 1234 },
      balanceUsd: 617,
      sellVenue: { "72h": 3, "30d": 3, "90d": 3 },
      sellVenueUsd90d: 2,
      outflows: { "72h": { CEX: 2, DEX: 1 }, "30d": { CEX: 2, DEX: 1 }, "90d": { CEX: 2, DEX: 1 } },
      sampleTxs: ["https://solscan.io/tx/a", "https://solscan.io/tx/c"],
      chains: ["solana"],
      verdict: "selling / sending to sell venues",
    });
  });

  it("gives a wallet with no flows the inactive verdict and empty windows", () => {
    expect(rowFor(STAKE_VAULT)).toMatchObject({
      balance: 0,
      balanceDetail: {},
      sellVenue: { "72h": 0, "30d": 0, "90d": 0 },
      outflows: { "72h": {}, "30d": {}, "90d": {} },
      sampleTxs: [],
      verdict: "inactive (no outflows in window)",
    });
  });

  it("keeps case-differing base58 addresses as separate rows, unchanged", () => {
    expect(rowFor(WALLET).address).toBe(WALLET);
    expect(rowFor(WALLET_LOWER).address).toBe(WALLET_LOWER);
    expect(rowFor(WALLET_LOWER).balanceDetail).toEqual({});
  });

  it("sorts by 90d sell volume, then balance", () => {
    expect(rows.map((r) => r.address)).toEqual([OTHER_WALLET, WALLET_LOWER, WALLET, STAKE_VAULT]);
  });

  it("leaves sampleTxs empty when no samples are passed", () => {
    const bare = buildSolanaWalletRows(registry, flows, balances, 0.5);
    expect(bare.every((r) => Array.isArray(r.sampleTxs) && r.sampleTxs.length === 0)).toBe(true);
  });
});

describe("distributionFromRecon", () => {
  const recon = {
    totalSupply: 1000,
    categories: { treasury: 100, council: 200, holdings: 50, escrow: 30, staking: 20, cex: 100, dex: 40, retail: 440, mystery: 20 },
  };

  it("maps categories onto the classes, with staking and unknown categories placed", () => {
    const d = distributionFromRecon(recon);
    const by = Object.fromEntries(d.classes.map((c) => [c.key, c.tel]));
    expect(by).toEqual({ treasury: 100, association: 200, holdings: 50, escrow: 30, staking: 20, cex: 100, dex: 40, bots: 0, other: 20, retail: 440 });
    expect(d.movedFromRetail).toEqual([]);
  });

  it("sums the classes to counted and gives shares of counted", () => {
    const d = distributionFromRecon(recon);
    expect(d.totalSupply).toBe(1000);
    expect(d.counted).toBe(1000);
    expect(d.classes.reduce((s, c) => s + c.tel, 0)).toBe(d.counted);
    expect(d.classes.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 9);
    expect(d.classes.find((c) => c.key === "treasury").share).toBeCloseTo(0.1, 9);
  });

  it("uses neutral labels and keeps each class group", () => {
    const d = distributionFromRecon(recon);
    for (const c of d.classes) expect(c.label).not.toMatch(/Telcoin/);
    expect(d.classes.find((c) => c.key === "treasury")).toMatchObject({ label: "Treasury", group: "telcoin" });
    expect(d.classes.find((c) => c.key === "staking").label).toBe("Staking");
  });

  it("merges extraClassMap over the default map", () => {
    const d = distributionFromRecon(recon, { extraClassMap: { mystery: "cex" } });
    const by = Object.fromEntries(d.classes.map((c) => [c.key, c.tel]));
    expect(by.cex).toBe(120);
    expect(by.other).toBe(0);
  });

  it("gives zero shares when nothing is counted", () => {
    const d = distributionFromRecon({ totalSupply: 1000, categories: {} });
    expect(d.counted).toBe(0);
    expect(d.classes.every((c) => c.share === 0)).toBe(true);
  });
});

describe("solanaSellTotals", () => {
  it("matches telcoinSellTotals: skips escrow rows and sums sell venues", () => {
    const events = [
      event({ raw: "2000000", sig: "a" }),
      event({ kind: "DEX", venue: "dex", dest: DEX_POOL, raw: "1000000", sig: "c" }),
      event({ wallet: OTHER_WALLET, raw: "10000000", sig: "b" }),
      event({ wallet: WALLET_LOWER, raw: "4000000", sig: "d" }),
    ];
    const registry = {
      knownWallets: [
        { address: WALLET, label: "Seller", group: "g", entityClass: "seller", source: "s", confidence: "medium" },
        { address: WALLET_LOWER, label: "Seller lower", group: "g", entityClass: "seller", source: "s", confidence: "medium" },
        { address: OTHER_WALLET, label: "Escrow", group: "g", entityClass: "escrow", source: "s", confidence: "confirmed" },
      ],
    };
    const rows = buildSolanaWalletRows(registry, aggregateWalletOutflows(events, NOW, 6), new Map(), 0.5, sampleTxs(events, NOW));
    const totals = solanaSellTotals(rows, 0.5);
    expect(totals["72h"]).toEqual({ total: 7, usd: 4, byVenue: { CEX: 6, DEX: 1 } });
  });
});
