import { describe, expect, it } from "vitest";
import { solanaOutflow, solanaProceedsFromTx, traceSolanaSale } from "./solanaProceeds.js";
import { detectBotCandidates } from "./botDetect.js";
import { summarizeProceeds } from "./proceeds.js";
import { WSOL_MINT } from "../solana/knownMints.js";

const ZBCN = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BOT = "BotWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".replace(/1/g, "2");
const POOL = "Poo2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CEX = "CexHotAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const bal = (i, mint, owner, amount) => ({ accountIndex: i, mint, owner, uiTokenAmount: { amount: String(amount) } });
const tx = (pre, post, keys = [BOT], lam = [[0, 0]]) => ({
  meta: { err: null, fee: 5000, preTokenBalances: pre, postTokenBalances: post, preBalances: lam.map((x) => x[0]), postBalances: lam.map((x) => x[1]) },
  transaction: { message: { accountKeys: keys } },
});
// Bot sells 1,000 ZBCN for 25 USDC on a pool.
const saleTx = tx(
  [bal(1, ZBCN, BOT, 1_000_000_000), bal(2, ZBCN, POOL, 0), bal(3, USDC, BOT, 0), bal(4, USDC, POOL, 100_000_000)],
  [bal(1, ZBCN, BOT, 0), bal(2, ZBCN, POOL, 1_000_000_000), bal(3, USDC, BOT, 25_000_000), bal(4, USDC, POOL, 75_000_000)],
);
// Bot forwards the 25 USDC to an exchange.
const hopTx = tx([bal(3, USDC, BOT, 25_000_000), bal(5, USDC, CEX, 0)], [bal(3, USDC, BOT, 0), bal(5, USDC, CEX, 25_000_000)]);
const assets = new Map([[USDC, { asset: "stable", symbol: "USDC", decimals: 6 }]]);

describe("Solana bot proceeds (parity with EVM traceSale)", () => {
  it("decodes the seller's proceeds legs, sold mint excluded", () => {
    expect(solanaProceedsFromTx(saleTx, BOT, assets, new Set([ZBCN]))).toEqual([{ contract: USDC, asset: "stable", symbol: "USDC", amount: 25 }]);
  });
  it("native SOL + wSOL fold into SOL", () => {
    const t = tx([bal(3, WSOL_MINT, BOT, 0)], [bal(3, WSOL_MINT, BOT, 1_000_000_000)], [BOT], [[2_000_000_000, 2_499_995_000]]);
    expect(solanaProceedsFromTx(t, BOT, assets).map((p) => [p.symbol, p.amount])).toEqual([["SOL", 1.5]]);
  });
  it("finds the next hop", () => {
    expect(solanaOutflow(hopTx, BOT, USDC)).toEqual({ to: CEX, raw: 25_000_000n });
    expect(solanaOutflow(saleTx, BOT, USDC)).toBeNull();
  });
  it("traces sale -> exchange with the same record + summary schema", async () => {
    const txs = { sale1: saleTx, hop1: hopTx };
    const call = async (m) => (m === "getSignaturesForAddress" ? [{ signature: "hop1", slot: 2, blockTime: 200 }] : null);
    const ix = { dev: new Map(), cex: new Map([[CEX, "Exchange X"]]), dex: new Map(), bridges: new Map(), custody: new Map(), staking: new Map(), relays: new Map(), bot: new Map([[BOT, "bot"]]) };
    const rec = await traceSolanaSale({ sale: { hash: "sale1", time: 100, date: "1970-01-01", wallet: BOT, amount: 1000, venue: "DEX", chain: "solana" }, call, ix, assets, devShare: 0.5, soldMints: new Set([ZBCN]), getTx: async (_c, sig) => txs[sig] });
    expect(rec.proceeds[0]).toMatchObject({ symbol: "USDC", amount: 25, hash: "sale1" });
    expect(rec.hops[0]).toMatchObject({ hop: 1, hash: "hop1", to: CEX, amount: 25 });
    expect(rec.stop?.kind).toBe("cex");
    expect(rec.devAttributed).toBe(12.5);
    const s = summarizeProceeds([rec], 0.5);
    expect(s).toMatchObject({ salesTraced: 1, tokenSold: 1000, tokenSoldDevShare: 500, byAsset: { USDC: { proceeds: 25, devAttributed: 12.5, sales: 1 } } });
    expect(s.destinations[0].sampleHashes).toEqual(["hop1"]);
  });
  it("empty-but-valid summary when nothing is traced", () => {
    expect(summarizeProceeds([], 0)).toEqual({ salesTraced: 0, tokenSold: 0, tokenSoldDevShare: 0, byAsset: {}, destinations: [] });
  });
});

describe("bot-cluster detection support", () => {
  const ev = (cp, amount, wallet = "D1", type = "transfer_out") => ({ chain: "solana", hash: `${cp}${amount}${wallet}`, time: amount, direction: "out", asset: "token", type, counterparty: cp, counterpartyLabel: null, wallet, amount });
  it("flags repeatedly funded unlabelled wallets, never venues", () => {
    const events = [ev("X", 10), ev("X", 11, "D2"), ev("X", 12), ev("Y", 500, "D1", "cex_deposit"), ev("Z", 1)];
    const c = detectBotCandidates(events);
    expect(c.map((x) => x.address)).toEqual(["X"]);
    expect(c[0]).toMatchObject({ fundings: 3, amount: 33, funders: ["D1", "D2"] });
  });
});

describe("bot-proceeds schema", () => {
  it("no mapped cluster is still a full, valid report", async () => {
    const { validateBotProceeds } = await import("../../trace-bot-proceeds.js");
    const doc = { version: 1, slug: "zebec-network", generated: "x", status: "no bot cluster mapped", botCluster: null, evidence: null, chains: [], summary: summarizeProceeds([], 0), detection: { candidates: [] } };
    expect(validateBotProceeds(doc)).toEqual([]);
    expect(validateBotProceeds({ version: 1, slug: "x", botCluster: null })).toHaveLength(1);
  });
});
