import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReport, venueRoles } from "../../generate-wallet-flows-hedera.js";
import { writeRegistry } from "../../init-forensics-registry.js";
import { deriveRegistry } from "../forensicsRegistry.js";
import { buildLedgerIndex, validateLedgerConfig, walletsForChain } from "../ledger/config.js";
import { classifyTransfer } from "../ledger/classify.js";
import { validateWalletFlowsReport } from "../walletFlows.js";
import { fetchSenderBalances } from "./walletFlowBalances.js";
import { ledgerTransfers, scanHederaLedger } from "./ledgerSource.js";
import * as kit from "./walletFlows.js";
import { hederaTreasuryAccounts } from "./treasury.js";
import { FLOW_CLASSIFIER_VERSION } from "./flowClassify.js";

const A = "0.0.100";
const B = "0.0.101";
const CEX = "0.0.900001";
const OUTSIDE = "0.0.800002";
const ANCHOR = 1794441600;
const stampAt = (s) => `${s}.000000001`;
const ev = (over) => ({ w: A, d: CEX, raw: "500000000", sig: stampAt(ANCHOR - 3600), t: ANCHOR - 3600, ...over });

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hedera-wf-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function hederaProject() {
  const exclusions = {
    labels: Object.fromEntries(
      [...hederaTreasuryAccounts()]
        .filter((a) => ["0.0.2", "0.0.54", "0.0.98", "0.0.800", "0.0.801", "0.0.400"].includes(a.address))
        .map((a) => [a.address, { category: "treasury", name: a.name }]),
    ),
  };
  exclusions.labels["0.0.5555555"] = { category: "retail", name: "not treasury" };
  fs.mkdirSync(path.join(root, "config/projects/hedera"), { recursive: true });
  fs.writeFileSync(path.join(root, "config/projects/hedera/exclusions.json"), JSON.stringify(exclusions));
  fs.writeFileSync(path.join(root, "config/projects/hedera/ledger.json"), JSON.stringify({ version: 1, developerWallets: [] }));
  return {
    slug: "hedera",
    root,
    config: {
      slug: "hedera",
      ticker: "HBAR",
      name: "Hedera",
      gated: { forensics: true },
      data: { dir: "public/data/hedera" },
      classification: { exclusions: "config/projects/hedera/exclusions.json" },
      chains: [{ key: "hedera", vm: "hedera", asset: { kind: "native", decimals: 8 }, contracts: { whbar: { address: "0.0.1456985", role: "dex" } } }],
    },
  };
}

describe("forensics registry for vm hedera", () => {
  it("lists the treasury accounts as known wallets and the network accounts under notTraced with the reason", async () => {
    const project = hederaProject();
    const result = await writeRegistry(project, { root });
    const registry = JSON.parse(fs.readFileSync(result.path, "utf8"));
    expect(registry.knownWallets.map((w) => w.address)).toEqual(["0.0.2", "0.0.400"]);
    expect(registry.knownWallets[0]).toMatchObject({ group: "treasury", entityClass: "treasury", confidence: "high", chains: ["hedera"], source: "config/projects/hedera/exclusions.json" });
    expect(registry.notTraced.map((w) => w.address)).toEqual(["0.0.54", "0.0.98", "0.0.800", "0.0.801"]);
    expect(registry.notTraced.find((w) => w.address === "0.0.98").reason).toContain("protocol rewards or fees");
    expect(registry.notTraced.find((w) => w.address === "0.0.54").reason).toContain("56,000 mirror pages");
    expect(registry.knownWallets.some((w) => w.address === "0.0.5555555")).toBe(false);
  });

  it("lists the same wallets in the ledger config, as go-live requires, and a second run adds nothing", async () => {
    const project = hederaProject();
    const result = await writeRegistry(project, { root });
    const ledger = JSON.parse(fs.readFileSync(path.join(root, "config/projects/hedera/ledger.json"), "utf8"));
    expect(result.ledgerWallets).toBe(2);
    expect(ledger.developerWallets.some((w) => w.address === "0.0.54")).toBe(false);
    expect(ledger.developerWallets.map((w) => w.address)).toEqual(["0.0.2", "0.0.400"]);
    const withStale = { ...ledger, developerWallets: [...ledger.developerWallets, { address: "0.0.54", label: "stale" }] };
    fs.writeFileSync(path.join(root, "config/projects/hedera/ledger.json"), JSON.stringify(withStale));
    expect((await writeRegistry(project, { root, force: true })).ledgerWallets).toBe(1);
    const again = await writeRegistry(project, { root, force: true });
    expect(again.ledgerWallets).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, "config/projects/hedera/ledger.json"), "utf8")).developerWallets).toHaveLength(2);
  });

  it("deriveRegistry stays unchanged without extra wallets (no notTraced key)", () => {
    const r = deriveRegistry({ slug: "x", chains: [{ key: "ethereum", contracts: { t: { address: "0x" + "1".repeat(40), role: "treasury" } } }] });
    expect(r.knownWallets).toHaveLength(1);
    expect("notTraced" in r).toBe(false);
  });

  it("refuses an exclusions treasury address that is not a Hedera id", () => {
    const project = hederaProject();
    fs.writeFileSync(path.join(root, "config/projects/hedera/exclusions.json"), JSON.stringify({ labels: { "0xabc": { category: "treasury", name: "x" } } }));
    expect(() => kit.hederaTreasurySplit(project, root)).toThrow(/not a Hedera account id/);
  });
});

describe("sender balances", () => {
  const page = (rows, next = null) => ({ balances: rows.map(([account, balance]) => ({ account, balance })), links: { next } });

  it("reads each contiguous range, follows links.next and reports 0 for an id with no row", async () => {
    const calls = [];
    const client = {
      getJson: async (p) => {
        calls.push(p);
        if (p.includes("page2")) return page([[B, "300000000"]]);
        if (p.includes("gte:0.0.100")) return page([[A, "150000000"]], "/api/v1/balances?page2");
        return page([]);
      },
    };
    const balances = await fetchSenderBalances(client, [A, B, "0.0.200"]);
    expect(balances.get(A)).toBe(1.5);
    expect(balances.get(B)).toBe(3);
    expect(balances.get("0.0.200")).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it("rejects when a page fails or is unreadable: no partial balance table", async () => {
    await expect(fetchSenderBalances({ getJson: async () => { throw new Error("HTTP 503"); } }, [A])).rejects.toThrow(/503/);
    await expect(fetchSenderBalances({ getJson: async () => ({ balances: [] }) }, [A])).rejects.toThrow(/unreadable/);
  });
});

describe("the report", () => {
  const registry = {
    knownWallets: [A, B, "0.0.102"].map((address) => ({ address, label: `Treasury ${address}`, group: "treasury", entityClass: "treasury", source: "s", confidence: "high", chains: ["hedera"] })),
    notTraced: [{ address: "0.0.98", label: "fee", reason: "payouts are protocol rewards" }],
  };
  const state = { through: stampAt(ANCHOR), throughDate: "2026-11-11", events: [ev({}), ev({ d: "0.0.1456985", raw: "200000000" }), ev({ d: B, raw: "100000000" }), ev({ d: OUTSIDE, raw: "50000000" }), ev({ w: B, d: OUTSIDE, raw: "70000000" })] };
  const roles = venueRoles({ senders: [A, B, "0.0.102"], cexAccounts: [{ id: CEX, exchange: "Alpha" }], dexIds: ["0.0.1456985"] });
  const recon = { totalSupply: 50e9, categories: { treasury: 5e9, retail: 45e9 } };
  const build = () => buildReport({
    kit, project: { slug: "hedera", config: { ticker: "HBAR", name: "Hedera" } }, chain: { key: "hedera", asset: { decimals: 8 } }, registry, state,
    balances: new Map([[A, 10], [B, 0], ["0.0.102", 0]]), roles, price: { priceUsd: 0.2, priceSource: "test" }, recon, reconRel: "public/data/hedera/supply-reconciliation.json", anchorSec: ANCHOR,
  });

  it("validates with 0.0.N ids and omits only registry accounts with no balance and no flows, saying so in the notes", () => {
    const report = build();
    expect(validateWalletFlowsReport(report, { addressKind: "hedera" })).toEqual([]);
    expect(validateWalletFlowsReport(report, { addressKind: "evm" }).length).toBeGreaterThan(0);
    expect(report.knownWallets.map((w) => w.address).sort()).toEqual([A, B]);
    expect(report.notes.join(" ")).toMatch(/1 registry treasury accounts hold no HBAR/);
    expect(report.notes.join(" ")).toMatch(/0\.0\.98.*protocol rewards/);
    expect(report.notTraced).toEqual(registry.notTraced);
    expect(report.knownWallets[0].balanceDetail).toEqual({ hedera: 10 });
  });

  it("outflows by venue sum to the total outflow of each wallet, and sell venues are exchanges plus DEX", () => {
    const row = build().knownWallets.find((w) => w.address === A);
    const byKind = row.outflows["90d"];
    expect(byKind).toEqual({ CEX: 5, DEX: 2, internal: 1, unlabelled: 1 });
    expect(Object.values(byKind).reduce((s, v) => s + v, 0)).toBe(9);
    expect(row.sellVenue["90d"]).toBe(7);
    expect(row.sampleTxs.every((u) => u.startsWith("https://hashscan.io/mainnet/transaction/"))).toBe(true);
  });

  it("windows are anchored at the settled end: an event after the anchor-24h is in 24h only when it is that recent", () => {
    const old = { ...state, events: [ev({ sig: stampAt(ANCHOR - 5 * 86400), t: ANCHOR - 5 * 86400 })] };
    const r = buildReport({ kit, project: { slug: "hedera", config: {} }, chain: { key: "hedera", asset: { decimals: 8 } }, registry, state: old, balances: new Map(), roles, price: { priceUsd: 0, priceSource: "none" }, recon, reconRel: "r", anchorSec: ANCHOR });
    const row = r.knownWallets.find((w) => w.address === A);
    expect(row.outflows["24h"]).toEqual({});
    expect(row.outflows["30d"]).toEqual({ CEX: 5 });
  });

  it("a venue-list change relabels the same stored events without a rescan", () => {
    const relabelled = buildReport({
      kit, project: { slug: "hedera", config: {} }, chain: { key: "hedera", asset: { decimals: 8 } }, registry, state,
      balances: new Map([[A, 10]]), roles: venueRoles({ senders: [A, B], cexAccounts: [{ id: OUTSIDE, exchange: "Beta" }], dexIds: [] }),
      price: { priceUsd: 0, priceSource: "none" }, recon, reconRel: "r", anchorSec: ANCHOR,
    });
    expect(relabelled.knownWallets.find((w) => w.address === A).outflows["90d"]).toEqual({ CEX: 1, internal: 1, unlabelled: 7 });
  });
});

describe("ledger", () => {
  const senders = [A, B];
  const cfg = {
    version: 1, slug: "hedera", chains: ["hedera"], windows: ["24h", "30d"],
    developerWallets: senders.map((a) => ({ address: a, label: `Treasury ${a}`, chains: ["hedera"] })),
    venues: { cex: { [CEX]: "Alpha" }, dex: { "0.0.1456985": "WHBAR" } }, relays: {}, stablecoins: { hedera: [] }, botCluster: null,
  };
  const ix = buildLedgerIndex(cfg);

  it("accepts Hedera developer wallets and no bot cluster", () => {
    expect(validateLedgerConfig(cfg, { projectSlug: "hedera" })).toEqual([]);
    expect(walletsForChain(cfg, "hedera", "hedera")).toHaveLength(2);
    expect(validateLedgerConfig({ ...cfg, developerWallets: [{ address: "0.0.x", label: "bad" }] }, { projectSlug: "hedera" })[0]).toMatch(/bad address/);
  });

  it("a transfer from a sender to an exchange account is cex_deposit; to WHBAR dex_sell; sender to sender internal; receipts are receive", () => {
    const events = [ev({}), ev({ d: "0.0.1456985" }), ev({ d: B }), ev({ d: A, w: B, dir: "in" }), ev({ d: OUTSIDE, w: A, dir: "in", raw: "100000000" })];
    const transfers = ledgerTransfers(events, { chain: "hedera", symbol: "HBAR", senders });
    expect(transfers).toHaveLength(4);
    const types = transfers.map((t) => classifyTransfer(t, ix, {})?.type);
    expect(types).toEqual(["cex_deposit", "dex_sell", "internal_shuffle", "receive"]);
    expect(transfers[0].amount).toBe(5);
    expect(new Set(transfers.map((t) => t.uniqueId)).size).toBe(4);
  });

  it("an unpaired remainder has no counterparty and no USD value is attached", () => {
    const [t] = ledgerTransfers([ev({ d: "unpaired" })], { chain: "hedera", symbol: "HBAR", senders });
    expect(t.to).toBeNull();
    expect(t.usd).toBeUndefined();
    expect(classifyTransfer(t, ix, {}).type).toBe("burn");
  });

  it("scanHederaLedger resumes from its cursors, reports partial when streams are behind, and rebuilds for another sender set", async () => {
    const through = stampAt(ANCHOR);
    const rows = Array.from({ length: 5 }, (_, i) => ({
      consensus_timestamp: stampAt(ANCHOR - 86400 + i), transaction_id: `${A}-1-1`, charged_tx_fee: 0, result: "SUCCESS", nonce: 0,
      transfers: [{ account: A, amount: -1000 - i }, { account: CEX, amount: 1000 + i }],
    }));
    const client = { getJson: async (p) => ({ transactions: p.includes("0.0.100") ? rows : [], links: { next: null } }) };
    const base = { client, chain: "hedera", symbol: "HBAR", senders: [A], classifierVersion: FLOW_CLASSIFIER_VERSION, through, nowSec: ANCHOR, historyDays: 90, logger: { warn() {} } };
    const first = await scanHederaLedger({ ...base, checkpoint: null });
    expect(first.complete).toBe(true);
    expect(first.transfers).toHaveLength(10 / 2);
    const again = await scanHederaLedger({ ...base, checkpoint: first.cursor });
    expect(again.transfers).toHaveLength(0);
    const partial = await scanHederaLedger({ ...base, checkpoint: null, deadlineMs: 0, now: () => 1 });
    expect(partial.complete).toBe(false);
    expect(partial.stats.streamsBehind).toBe(1);
    const other = await scanHederaLedger({ ...base, senders: [A, B], checkpoint: first.cursor });
    expect(other.rebuilt).toBe(true);
    expect(other.transfers).toHaveLength(5);
  });
});
