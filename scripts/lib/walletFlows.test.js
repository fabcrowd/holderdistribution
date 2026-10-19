import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  aggregateOutflows,
  buildDistribution,
  buildKnownWalletRows,
  buildVenueIndex,
  classifyOutflow,
  discoverLargeSellers,
  telcoinSellTotals,
  validateWalletFlowsReport,
} from "./walletFlows.js";

const A = (n) => "0x" + String(n).padStart(40, "0");
const HUB = A(1);
const RELAY = A(2);
const TREASURY = A(3);
const STAKING = A(4);
const BOT1 = A(5);
const BOT2 = A(6);
const CEX = A(7);
const POOL = A(8);
const UPGRADE = A(9);
const RANDO = A(10);
const ARB = A(11);

const registry = {
  knownWallets: [
    { address: HUB, label: "Hub", group: "g", entityClass: "association", source: "s", confidence: "medium" },
    { address: RELAY, label: "Relay", group: "relay", entityClass: "relay", relayTo: "CEX", relayLabel: "KuCoin", source: "s", confidence: "medium" },
    { address: TREASURY, label: "Treasury", group: "g", entityClass: "treasury", source: "s", confidence: "confirmed" },
    { address: STAKING, label: "Staking", group: "g", entityClass: "staking", source: "s", confidence: "confirmed" },
  ],
  botCluster: { label: "Bot", chain: "polygon", addresses: [BOT1, BOT2] },
  watchedSellers: [{ address: RANDO, label: "Whale" }],
};
const index = buildVenueIndex({
  registry,
  cexWallets: [{ address: CEX, label: "KuCoin" }],
  dexAddresses: [POOL],
  recon: { items: [{ address: TREASURY, category: "treasury" }] },
  upgradeContracts: [UPGRADE],
});
const startBlocks = { polygon: { "72h": 900, "30d": 500, "90d": 100 } };
const tr = (from, to, tel, block, extra = {}) => ({ chain: "polygon", from, to, tel, block, tx: "0x" + block.toString(16).padStart(64, "0"), ...extra });

describe("classifyOutflow", () => {
  it("classifies relays, venues, upgrades, internal and payouts", () => {
    expect(classifyOutflow(HUB, RELAY, index)).toBe("CEX");
    expect(classifyOutflow(HUB, CEX, index)).toBe("CEX");
    expect(classifyOutflow(HUB, POOL, index)).toBe("DEX");
    expect(classifyOutflow(HUB, BOT1, index)).toBe("bot-cluster");
    expect(classifyOutflow(HUB, UPGRADE, index)).toBe("upgrade");
    expect(classifyOutflow(HUB, TREASURY, index)).toBe("internal");
    expect(classifyOutflow(STAKING, RANDO, index)).toBe("reward/unstake payout");
    expect(classifyOutflow(HUB, RANDO, index)).toBe("unlabelled");
    expect(classifyOutflow(HUB, RANDO, index, { swapped: true })).toBe("DEX");
  });
});

describe("aggregateOutflows + rows + totals", () => {
  const transfers = [
    tr(HUB, RELAY, 100, 950), // 72h CEX via relay
    tr(RELAY, CEX, 100, 951), // relay onward hop (must not double count in totals)
    tr(HUB, BOT1, 300, 600), // 30d bot
    tr(HUB, POOL, 50, 200), // 90d only DEX
    tr(HUB, TREASURY, 999, 300), // internal
    tr(BOT1, POOL, 40, 950), // bot DEX sale in 72h
    tr(BOT1, BOT2, 10, 950), // bot shuffle, ignored
  ];
  const { byWallet, bot } = aggregateOutflows(transfers, index, startBlocks);
  const rows = buildKnownWalletRows(registry, byWallet, new Map([[HUB, { polygon_v3: 20 }]]), 0.01);
  const hub = rows.find((r) => r.address === HUB);

  it("splits windows by block", () => {
    expect(hub.sellVenue).toEqual({ "72h": 100, "30d": 400, "90d": 450 });
    expect(hub.outflows["90d"].internal).toBe(999);
    expect(hub.verdict).toBe("selling / sending to sell venues");
    expect(hub.balance).toBe(20);
    expect(bot.out["72h"].DEX).toBe(40);
    expect(bot.out["72h"]["bot-cluster"]).toBeUndefined();
  });

  it("totals skip relay hops", () => {
    const t = telcoinSellTotals(rows, 0.01);
    expect(t["90d"].total).toBe(450);
    expect(t["72h"]).toMatchObject({ total: 100, usd: 1 });
  });
});

describe("buildDistribution", () => {
  it("moves only un-itemised tracked balances out of retail and conserves the total", () => {
    const recon = { totalSupply: 1000, categories: { retail: 600, treasury: 100, cex: 200, dex: 50, escrow: 40, council: 10 }, items: [{ address: TREASURY }] };
    const d = buildDistribution(recon, [
      { address: TREASURY, entityClass: "treasury", balance: 100 }, // itemised → not moved
      { address: STAKING, entityClass: "staking", balance: 70 },
      { address: BOT1, entityClass: "bots", balance: 30 },
      { address: RELAY, entityClass: "relay", balance: 5 },
    ]);
    const by = Object.fromEntries(d.classes.map((c) => [c.key, c.tel]));
    expect(by).toMatchObject({ retail: 495, staking: 70, bots: 30, cex: 205, treasury: 100, association: 10 });
    expect(d.counted).toBe(1000);
    expect(d.classes.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 9);
  });
});

describe("discoverLargeSellers", () => {
  it("groups the bot, drops round-trip arbs and ranks by net", () => {
    const t = [
      tr(BOT1, POOL, 6e6, 950),
      tr(BOT2, POOL, 6e6, 951),
      tr(RANDO, CEX, 8e6, 952),
      tr(ARB, POOL, 9e6, 953),
      tr(POOL, ARB, 9e6, 954),
      tr(RANDO, UPGRADE, 50e6, 955),
    ];
    const rows = discoverLargeSellers(t, index, { minTel: 5e6, priceUsd: 0.001 });
    expect(rows.map((r) => r.entity)).toEqual(["Bot", "Whale"]);
    expect(rows[0]).toMatchObject({ rank: 1, tel: 12e6, addresses: [BOT1, BOT2] });
    expect(rows[1]).toMatchObject({ destination: "KuCoin", usd: 8000 });
  });
});

describe("committed wallet-flows report", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const report = JSON.parse(fs.readFileSync(path.join(root, "data/forensics/wallet-flows.json"), "utf8"));

  it("is valid", () => {
    expect(validateWalletFlowsReport(report)).toEqual([]);
  });

  it("is NOT in public/ (would ship unauthenticated)", () => {
    const pub = path.join(root, "public");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
    expect(walk(pub).some((f) => /wallet-flows/i.test(f))).toBe(false);
  });

  it("is only imported from src/ by the DEV-only loader", () => {
    const src = path.join(root, "src");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const offenders = walk(src)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))
      .filter((f) => /(from\s+|import\(\s*)["'][^"']*data\/forensics\//.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual(["src/lib/loadForensicsDev.ts"]);
  });
});
