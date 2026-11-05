import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { botDevShare, buildLedgerIndex, loadLedgerConfig, loadTxTypes, validateLedgerConfig, walletsForChain } from "./config.js";
import { classifyBotTransfer, classifyTransfer } from "./classify.js";
import { buildLedgerReport, dailySeries, validateLedgerReport } from "./aggregate.js";
import { evmAssetMap, fetchWalletTransfers, normalizeAlchemyTransfer, scanEvmChain } from "./evmSource.js";
import { solanaTransfersFromTx } from "./solanaSource.js";
import { evidenceBlock, proceedsFromReceipt, stopFor, summarizeProceeds, traceSale, TRANSFER_TOPIC } from "./proceeds.js";
import { detectPatterns } from "../patterns.js";
import { resolveProject } from "../projects.js";

const root = path.resolve(__dirname, "../../..");
const types = loadTxTypes(root).types;
const A = (n) => "0x" + String(n).padStart(40, "0");
const DEV1 = A(1);
const DEV2 = A(2);
const CEX = A(3);
const POOL = A(4);
const RELAY = A(5);
const BOT = A(6);
const RANDO = A(7);
const BRIDGE = A(8);
const VAULT = A(9);
const STAKE = A(10);
const TOKEN = A(100);
const USDC = A(101);

const cfg = {
  version: 1,
  slug: "demo",
  windows: ["24h", "72h", "30d", "90d"],
  historyDays: 90,
  chains: ["polygon"],
  developerWallets: [
    { address: DEV1, label: "Treasury", chains: ["polygon"] },
    { address: DEV2, label: "Hub", chains: [] },
  ],
  stablecoins: { polygon: [{ address: USDC, symbol: "USDC", decimals: 6 }] },
  venues: { cex: { [CEX]: "KuCoin" }, dex: { [POOL]: "Pool" }, bridges: { [BRIDGE]: "Bridge" }, custody: { [VAULT]: "BitGo" }, staking: { [STAKE]: "Staking" } },
  relays: { [RELAY]: { endpoint: CEX, label: "KuCoin", kind: "cex" } },
  botCluster: {
    label: "Bot",
    chain: "polygon",
    addresses: [BOT],
    attribution: "pro-rata",
    funding: [
      { source: "developer", label: "Hub", amount: 611_434_638 },
      { source: "external", label: "KuCoin", amount: 1_158_380_277 },
    ],
    evidence: ["funded by hub"],
  },
  trace: { maxHops: 2 },
};
const ix = buildLedgerIndex(cfg);
const NOW = Date.parse("2026-11-03T12:00:00Z") / 1000;
const tr = (from, to, amount, ageSec, extra = {}) => ({ chain: "polygon", hash: "0x" + (ageSec + amount).toString(16).padStart(64, "0"), time: NOW - ageSec, from, to, amount, asset: "token", symbol: "TEL", ...extra });

describe("ledger config", () => {
  it("validates the committed project ledgers", () => {
    for (const slug of ["tel", "zebec-network"]) {
      const c = loadLedgerConfig(slug, root);
      expect(validateLedgerConfig(c, { projectSlug: slug }), slug).toEqual([]);
    }
  });

  it("TEL dev share is the Settlement hub's funding over all bot funding (~34.5%)", () => {
    const share = botDevShare(loadLedgerConfig("tel", root).botCluster);
    expect(share).toBeCloseTo(611_434_638 / (611_434_638 + 1_158_380_277), 6);
    expect(share).toBeGreaterThan(0.34);
    expect(share).toBeLessThan(0.35);
  });

  it("keeps BitGo/Anchorage as custody, not developer wallets", () => {
    const c = loadLedgerConfig("tel", root);
    const labels = Object.values(c.venues.custody).join(" ");
    expect(labels).toMatch(/BitGo/);
    expect(labels).toMatch(/Anchorage/);
    expect(c.developerWallets.some((w) => /BitGo|Anchorage/.test(w.label))).toBe(false);
  });

  it("rejects bad configs", () => {
    expect(validateLedgerConfig({ ...cfg, botCluster: { ...cfg.botCluster, funding: [{ source: "external", amount: 1, label: "x" }] } })).toContain("botCluster.funding needs at least one developer source");
    expect(validateLedgerConfig({ ...cfg, windows: ["7d"] })).toContain("unknown window 7d");
    expect(validateLedgerConfig({ ...cfg, developerWallets: [{ address: "nope", label: "x" }] })[0]).toMatch(/bad address/);
    expect(validateLedgerConfig(cfg, { projectSlug: "other" })).toContain("slug demo does not match project other");
  });

  it("indexes the project's CEX / DEX lists and contract roles", () => {
    const zcfg = loadLedgerConfig("zebec-network", root);
    const zix = buildLedgerIndex(zcfg, { project: resolveProject("zebec-network", root), root });
    expect(zix.dex.has("FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w")).toBe(true);
    expect(zix.staking.has("zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv")).toBe(true);
    // treasury role is a developer wallet, never a venue
    expect(zix.dev.has("EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW")).toBe(true);
    const tix = buildLedgerIndex(loadLedgerConfig("tel", root), { project: resolveProject("tel", root), root });
    expect(tix.cex.size).toBeGreaterThan(10);
    expect(tix.dex.has("0xa5cabfc725dfa129f618d527e93702d10412f039")).toBe(true);
  });

  it("walletsForChain honours chains[] and VM", () => {
    expect(walletsForChain(cfg, "polygon", "evm").map((w) => w.address)).toEqual([DEV1, DEV2]);
    expect(walletsForChain(cfg, "ethereum", "evm").map((w) => w.address)).toEqual([DEV2]);
    expect(walletsForChain(cfg, "solana", "solana")).toEqual([]);
  });
});

describe("classifyTransfer", () => {
  const c = (...a) => classifyTransfer(tr(...a), ix, types);
  it("labels every type with a reason and the hash", () => {
    expect(c(DEV1, DEV2, 5, 10)).toMatchObject({ type: "internal_shuffle", internal: true, headline: false, direction: "internal" });
    expect(c(DEV1, CEX, 5, 10)).toMatchObject({ type: "cex_deposit", headline: true, counterpartyLabel: "KuCoin" });
    expect(c(DEV1, RELAY, 5, 10)).toMatchObject({ type: "cex_deposit", counterpartyLabel: "KuCoin (via relay)" });
    expect(c(DEV1, POOL, 5, 10)).toMatchObject({ type: "dex_sell", headline: true });
    expect(c(DEV1, RANDO, 5, 10, { swap: true })).toMatchObject({ type: "dex_sell" });
    expect(c(DEV1, RANDO, 5, 10)).toMatchObject({ type: "transfer_out", headline: false });
    expect(c(DEV1, BOT, 5, 10)).toMatchObject({ type: "bot_funding" });
    expect(c(DEV1, BRIDGE, 5, 10)).toMatchObject({ type: "bridge" });
    expect(c(DEV1, VAULT, 5, 10)).toMatchObject({ type: "custody" });
    expect(c(DEV1, STAKE, 5, 10)).toMatchObject({ type: "staking" });
    expect(c(DEV1, "0x0000000000000000000000000000000000000000", 5, 10)).toMatchObject({ type: "burn" });
    expect(c(RANDO, DEV1, 5, 10)).toMatchObject({ type: "receive", direction: "in", wallet: DEV1 });
    expect(c(RANDO, CEX, 5, 10)).toBeNull();
    const e = c(DEV1, CEX, 5, 10);
    expect(e.hash).toMatch(/^0x/);
    expect(e.reason).toMatch(/exchange/);
    for (const t of ["internal_shuffle", "cex_deposit", "dex_sell", "transfer_out", "bot_funding", "bridge", "custody", "staking", "burn", "receive"]) expect(types[t], t).toBeTruthy();
  });

  it("handles stablecoins", () => {
    const s = (from, to) => classifyTransfer(tr(from, to, 100, 10, { asset: "stable", symbol: "USDC" }), ix, types);
    expect(s(DEV1, RANDO).type).toBe("stable_out");
    expect(s(RANDO, DEV1).type).toBe("stable_in");
    expect(s(DEV1, DEV2)).toMatchObject({ type: "stable_internal", internal: true });
  });

  it("bot transfers: sales only", () => {
    expect(classifyBotTransfer(tr(BOT, POOL, 100, 10), ix)).toMatchObject({ venue: "Pool" });
    expect(classifyBotTransfer(tr(BOT, RANDO, 100, 10, { swap: true }), ix)).toMatchObject({ venue: "DEX (swap in receipt)" });
    expect(classifyBotTransfer(tr(BOT, BOT, 100, 10), ix)).toBeNull();
    expect(classifyBotTransfer(tr(BOT, RANDO, 100, 10), ix)).toBeNull();
  });
});

describe("buildLedgerReport", () => {
  const H = 3600;
  const D = 86400;
  const ev = [
    classifyTransfer(tr(DEV1, POOL, 100, 2 * H), ix, types), // 24h DEX
    classifyTransfer(tr(DEV1, CEX, 1000, 2 * D), ix, types), // 72h CEX
    classifyTransfer(tr(DEV1, DEV2, 5000, 3 * H), ix, types), // internal, never headline
    classifyTransfer(tr(DEV2, RANDO, 300, 10 * D, { asset: "stable", symbol: "USDC" }), ix, types),
    classifyTransfer(tr(DEV2, CEX, 10, 60 * D), ix, types), // 90d only
  ];
  const bot = [classifyBotTransfer(tr(BOT, POOL, 1000, 5 * H), ix)];
  const r = buildLedgerReport({ cfg, events: ev, botSales: bot, nowSec: NOW, txTypes: { types }, devShare: ix.botShare, project: { ticker: "TEL" } });

  it("headline = DEX + CEX + pro-rata bot share; internal excluded", () => {
    expect(r.byWindow["24h"].devSold).toEqual({ dex: 100, cex: 0, botDevShare: Math.round(1000 * ix.botShare), total: Math.round(100 + 1000 * ix.botShare) });
    expect(r.byWindow["72h"].devSold.cex).toBe(1000);
    expect(r.byWindow["90d"].devSold.cex).toBe(1010);
    expect(r.byWindow["24h"].internal).toEqual({ count: 1, amount: 5000 });
    expect(r.byWindow["30d"].payments.stableOut).toBe(300);
    expect(r.headlines["24h"][0]).toMatch(/Developer wallets sold/);
    expect(r.headlines["24h"].join(" ")).toMatch(/internal shuffles? .* not counted/);
    expect(r.defaultWindow).toBe("30d");
    expect(validateLedgerReport(r)).toEqual([]);
  });

  it("daily series has one row per day and sums the headline", () => {
    const d = dailySeries(ev, bot, { nowSec: NOW, days: 90, devShare: ix.botShare });
    expect(d).toHaveLength(90);
    expect(d[d.length - 1].date).toBe("2026-11-03");
    expect(d.reduce((s, x) => s + x.internal, 0)).toBe(5000);
    expect(r.daily.reduce((s, x) => s + x.devSold, 0)).toBeCloseTo(1110 + 1000 * ix.botShare, -1);
  });

  it("per-wallet windows", () => {
    const w = r.developerWallets.find((x) => x.address === DEV1);
    expect(w.windows["72h"].sold).toBe(1100);
    expect(w.windows["24h"].internal).toBe(1);
  });

  it("validator catches missing hashes and unknown types", () => {
    expect(validateLedgerReport({ ...r, events: [{ type: "nope", reason: "x" }] })).toEqual(["event without hash (nope)", "event type nope not in txTypes"]);
  });
});

describe("patterns", () => {
  it("finds recurring payments, cadence and fixed-size bot sales", () => {
    const D = 86400;
    const evs = [0, 7, 14, 21].map((d) => classifyTransfer(tr(DEV1, CEX, 1_000_000 + d, d * D + 3600), ix, types));
    const bots = Array.from({ length: 20 }, (_, i) => ({ hash: `0x${i}`, amount: 100_000 + i * 1000, time: NOW - i * 60 }));
    const p = detectPatterns(evs, { botSales: bots, ticker: "TEL" });
    const kinds = p.map((x) => x.kind);
    expect(kinds).toContain("recurring_payment");
    expect(kinds).toContain("regular_cadence");
    expect(kinds).toContain("fixed_size");
    expect(p.find((x) => x.kind === "regular_cadence").intervalDays).toBe(7);
    for (const x of p) expect(x.sampleHashes.length).toBeGreaterThan(0);
  });

  it("ignores internal shuffles", () => {
    const evs = [0, 1, 2, 3, 4].map((d) => classifyTransfer(tr(DEV1, DEV2, 10, d * 86400), ix, types));
    expect(detectPatterns(evs)).toEqual([]);
  });
});

describe("EVM source", () => {
  const chainCfg = { tokens: { legacy: { address: TOKEN, decimals: 2 } } };
  const assets = evmAssetMap(chainCfg, cfg.stablecoins.polygon, "TEL");
  const alch = (from, to, contract, value, block) => ({ hash: "0x" + block.toString(16).padStart(64, "0"), uniqueId: `${block}:${from}:${to}`, blockNum: "0x" + block.toString(16), from, to, rawContract: { address: contract, value: "0x" + value.toString(16) }, metadata: { blockTimestamp: new Date((NOW - 100) * 1000).toISOString() } });

  it("normalizes amounts with the tracked decimals", () => {
    expect(normalizeAlchemyTransfer(alch(DEV1, CEX, TOKEN, 12345, 10), "polygon", assets)).toMatchObject({ amount: 123.45, asset: "token", blockNumber: 10 });
    expect(normalizeAlchemyTransfer(alch(DEV1, CEX, USDC, 2_500_000, 10), "polygon", assets)).toMatchObject({ amount: 2.5, asset: "stable", symbol: "USDC" });
    expect(normalizeAlchemyTransfer(alch(DEV1, CEX, A(999), 1, 10), "polygon", assets)).toBeNull();
  });

  it("paginates with pageKey", async () => {
    const calls = [];
    const fake = async (_u, p) => {
      calls.push(p);
      return p.pageKey ? { transfers: [2] } : { transfers: [1], pageKey: "k" };
    };
    expect(await fetchWalletTransfers({ url: "u", address: DEV1, direction: "from", contracts: [TOKEN], fromBlock: 1, toBlock: 2, assetTransfers: fake })).toEqual([1, 2]);
    expect(calls[0].fromAddress).toBe(DEV1);
    expect(calls[1].pageKey).toBe("k");
  });

  it("scans incrementally from the checkpoint and checks receipts only for unlabelled recipients", async () => {
    const receipts = [];
    const rpc = async (_u, m, p) => {
      if (m === "eth_blockNumber") return "0x64";
      if (m === "eth_getTransactionReceipt") {
        receipts.push(p[0]);
        return { logs: [{ topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"] }] };
      }
      throw new Error(m);
    };
    const seenFrom = [];
    const fake = async (_u, p) => {
      seenFrom.push(p.fromBlock);
      if (p.fromAddress === DEV1) return { transfers: [alch(DEV1, CEX, TOKEN, 100, 60), alch(DEV1, RANDO, TOKEN, 100, 61)] };
      return { transfers: [] };
    };
    const res = await scanEvmChain({ chain: "polygon", url: "u", rpc, assets, wallets: [cfg.developerWallets[0]], checkpoint: { lastBlock: 50 }, nowSec: NOW, historyDays: 90, isLabelled: (a) => a === CEX, assetTransfers: fake });
    expect(seenFrom.every((b) => b === "0x33")).toBe(true);
    expect(res.cursor.lastBlock).toBe(100);
    expect(receipts).toHaveLength(1);
    expect(res.transfers.find((t) => t.to === RANDO).swap).toBe(true);
  });
});

describe("Solana source", () => {
  it("pairs token deltas and flags swaps", () => {
    const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
    const STABLE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const W = "EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW";
    const P = "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w";
    const bal = (i, owner, mint, amount) => ({ accountIndex: i, owner, mint, uiTokenAmount: { amount: String(amount), decimals: 6 } });
    const tx = {
      meta: {
        err: null,
        preTokenBalances: [bal(1, W, MINT, 5_000_000), bal(2, P, MINT, 0), bal(3, W, STABLE, 0), bal(4, P, STABLE, 9_000_000)],
        postTokenBalances: [bal(1, W, MINT, 0), bal(2, P, MINT, 5_000_000), bal(3, W, STABLE, 1_000_000), bal(4, P, STABLE, 8_000_000)],
      },
      transaction: { message: { accountKeys: ["a", "b", "c", "d", "e"] } },
    };
    const assets = new Map([[MINT, { asset: "token", symbol: "ZBCN", decimals: 6 }], [STABLE, { asset: "stable", symbol: "USDC", decimals: 6 }]]);
    const out = solanaTransfersFromTx(tx, { signature: "sig", blockTime: NOW, chain: "solana", assets, watched: new Set([W]) });
    const sold = out.find((t) => t.asset === "token");
    expect(sold).toMatchObject({ from: W, to: P, amount: 5, swap: true, hash: "sig" });
    expect(out.find((t) => t.asset === "stable")).toMatchObject({ from: P, to: W, amount: 1 });
  });
});

describe("bot proceeds", () => {
  const pad = (a) => "0x" + "0".repeat(24) + a.slice(2);
  const receipt = {
    logs: [
      { address: TOKEN, topics: [TRANSFER_TOPIC, pad(BOT), pad(POOL)], data: "0x64" },
      { address: USDC, topics: [TRANSFER_TOPIC, pad(POOL), pad(BOT)], data: "0x" + (5_000_000).toString(16) },
    ],
  };
  const assets = new Map([[USDC, { asset: "stable", symbol: "USDC", decimals: 6 }]]);

  it("reads proceeds from the sale receipt", () => {
    expect(proceedsFromReceipt(receipt, BOT, assets, new Set([TOKEN]))).toEqual([{ contract: USDC, symbol: "USDC", asset: "stable", amount: 5, raw: "5000000", from: POOL }]);
  });

  it("stops at known wallets", () => {
    expect(stopFor(CEX, ix)).toEqual({ kind: "cex", label: "KuCoin" });
    expect(stopFor(DEV1, ix)).toEqual({ kind: "developer", label: "Treasury" });
    expect(stopFor(RANDO, ix)).toBeNull();
  });

  it("traces sale -> proceeds -> hop 1 -> hop 2 with a hash on every link", async () => {
    const rpc = async () => receipt;
    const hopTx = (from, to, block) => ({ hash: "0xh" + block, blockNum: "0x" + block.toString(16), from, to, rawContract: { address: USDC, value: "0x" + (5_000_000).toString(16) }, metadata: { blockTimestamp: new Date(NOW * 1000).toISOString() } });
    const fake = async (_u, p) => ({ transfers: p.fromAddress === BOT ? [hopTx(BOT, RANDO, 11)] : p.fromAddress === RANDO ? [hopTx(RANDO, CEX, 12)] : [] });
    const sale = { ...classifyBotTransfer(tr(BOT, POOL, 1000, 10), ix), blockNumber: 10 };
    const rec = await traceSale({ sale, url: "u", rpc, assetTransfers: fake, ix, assets, maxHops: 2, devShare: 0.25, soldContracts: new Set([TOKEN]) });
    expect(rec.proceeds[0].hash).toBe(sale.hash);
    expect(rec.hops.map((h) => [h.hash, h.kind])).toEqual([["0xh11", "unlabelled"], ["0xh12", "cex"]]);
    expect(rec.stop).toEqual({ kind: "cex", label: "KuCoin" });
    expect(rec.devAttributed).toBe(1.25);
    const s = summarizeProceeds([rec], 0.25);
    expect(s.byAsset.USDC).toEqual({ proceeds: 5, devAttributed: 1.25, sales: 1 });
    expect(s.destinations[0]).toMatchObject({ kind: "cex", amount: 5, devAttributed: 1.25 });
  });

  it("evidence block counts only developer funding", () => {
    const e = evidenceBlock(cfg.botCluster, ix.botShare);
    expect(e.funding.map((f) => f.counted)).toEqual([true, false]);
    expect(e.summary).toMatch(/34\.5%/);
  });
});

describe("tx type catalog", () => {
  it("every type has label, meaning and how it is identified", () => {
    const doc = JSON.parse(fs.readFileSync(path.join(root, "config/ledger-tx-types.json"), "utf8"));
    for (const [id, t] of Object.entries(doc.types)) {
      expect(t.label, id).toBeTruthy();
      expect(t.meaning, id).toBeTruthy();
      expect(t.identifiedBy, id).toBeTruthy();
    }
    expect(Object.entries(doc.types).filter(([, t]) => t.headline).map(([id]) => id).sort()).toEqual(["bot_sell_dev_share", "cex_deposit", "dex_sell"]);
  });
});
