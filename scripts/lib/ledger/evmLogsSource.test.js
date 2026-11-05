/**
 * Provider parity: the keyless eth_getLogs source (logsAssetTransfers) must give
 * byte-identical ledger rows to alchemy_getAssetTransfers for the same chain data.
 */
import { describe, expect, it } from "vitest";
import { evmAssetMap, ledgerEvmProviderOrder, logsAssetTransfers, normalizeAlchemyTransfer, scanEvmChain, TRANSFER_TOPIC } from "./evmSource.js";

const TOKEN = "0x467bccd9d29f223bce8043b84e8c8b282827790f";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const DEV = "0x" + "d".repeat(40);
const CEX = "0x" + "c".repeat(40);
const RANDO = "0x" + "e".repeat(40);
const pad = (a) => "0x" + a.slice(2).padStart(64, "0");
const hx = (n) => "0x" + n.toString(16);
const TS = (b) => 1_760_000_000 + b * 2;

// One canonical chain: Transfer logs.
const LOGS = [
  { address: TOKEN, from: DEV, to: CEX, value: 12345n, block: 60, logIndex: 3 },
  { address: TOKEN, from: DEV, to: RANDO, value: 100n, block: 61, logIndex: 0 },
  { address: USDC, from: RANDO, to: DEV, value: 2_500_000n, block: 61, logIndex: 1 },
  { address: TOKEN, from: DEV, to: CEX, value: 0n, block: 62, logIndex: 0 },
  { address: TOKEN, from: CEX, to: RANDO, value: 5n, block: 63, logIndex: 0 },
].map((l) => ({ ...l, hash: "0x" + String(l.block).padStart(64, "0") }));

const rawLog = (l) => ({ address: l.address, topics: [TRANSFER_TOPIC, pad(l.from), pad(l.to)], data: "0x" + l.value.toString(16).padStart(64, "0"), blockNumber: hx(l.block), transactionHash: l.hash, logIndex: hx(l.logIndex) });

// What Alchemy returns for the same logs (uniqueId "<hash>:log:<idx>", excludeZeroValue).
async function alchemyFake(_u, p) {
  const from = parseInt(p.fromBlock, 16);
  const to = parseInt(p.toBlock, 16);
  const rows = LOGS.filter((l) => l.block >= from && l.block <= to && p.contractAddresses.includes(l.address) && l.value > 0n && (!p.fromAddress || l.from === p.fromAddress) && (!p.toAddress || l.to === p.toAddress));
  return { transfers: rows.map((l) => ({ blockNum: hx(l.block), uniqueId: `${l.hash}:log:${l.logIndex}`, hash: l.hash, from: l.from, to: l.to, category: "erc20", rawContract: { address: l.address, value: hx(Number(l.value)) }, metadata: { blockTimestamp: new Date(TS(l.block) * 1000).toISOString() } })) };
}

// A public node: eth_getLogs with topic filters, eth_getBlockByNumber timestamps.
function publicNode() {
  const calls = [];
  const rpc = async (_u, m, p) => {
    calls.push(m);
    if (m === "eth_blockNumber") return hx(100);
    if (m === "eth_getBlockByNumber") return { timestamp: hx(TS(parseInt(p[0], 16))) };
    if (m === "eth_getTransactionReceipt") return { logs: [{ topics: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"] }] };
    throw new Error(m);
  };
  const getLogs = async (_u, f) => {
    calls.push("eth_getLogs");
    const from = parseInt(f.fromBlock, 16);
    const to = parseInt(f.toBlock, 16);
    const addrs = (Array.isArray(f.address) ? f.address : [f.address]).map((a) => a.toLowerCase());
    return LOGS.filter((l) => l.block >= from && l.block <= to && addrs.includes(l.address) && (!f.topics[1] || pad(l.from) === f.topics[1]) && (!f.topics[2] || pad(l.to) === f.topics[2])).reverse().map(rawLog);
  };
  return { rpc, getLogs, calls };
}

const assets = evmAssetMap({ tokens: { legacy: { address: TOKEN, decimals: 2 } } }, [{ address: USDC, symbol: "USDC", decimals: 6 }], "TEL");
const wallets = [{ address: DEV }];
const base = { chain: "polygon", url: "u", assets, wallets, botAddresses: [CEX], checkpoint: { lastBlock: 50 }, nowSec: TS(100), historyDays: 90, isLabelled: (a) => a === CEX };

describe("ledger EVM source: public eth_getLogs == alchemy_getAssetTransfers", () => {
  it("normalizes to identical rows", async () => {
    const { rpc, getLogs } = publicNode();
    const viaLogs = logsAssetTransfers({ rpc, getLogs });
    for (const dir of ["fromAddress", "toAddress"]) {
      const p = { fromBlock: hx(51), toBlock: hx(100), [dir]: DEV, contractAddresses: [TOKEN, USDC], excludeZeroValue: true };
      const a = (await alchemyFake("u", p)).transfers.map((t) => normalizeAlchemyTransfer(t, "polygon", assets));
      const b = (await viaLogs("u", p)).transfers.map((t) => normalizeAlchemyTransfer(t, "polygon", assets));
      expect(b).toEqual(a);
    }
  });

  it("a full incremental scan gives the same transfers, bot transfers, cursor and swap flags", async () => {
    const n1 = publicNode();
    const viaAlchemy = await scanEvmChain({ ...base, rpc: n1.rpc, assetTransfers: alchemyFake });
    const n2 = publicNode();
    const viaPublic = await scanEvmChain({ ...base, rpc: n2.rpc, assetTransfers: logsAssetTransfers({ rpc: n2.rpc, getLogs: n2.getLogs }) });
    expect(viaPublic).toEqual(viaAlchemy);
    expect(viaPublic.transfers.length).toBe(3);
    expect(viaPublic.botTransfers.length).toBe(1);
    expect(n2.calls).not.toContain("alchemy_getAssetTransfers");
  });

  it("provider order: opt-in via HD_JOB_PROVIDERS, Alchemy when unset (unchanged default)", () => {
    expect(ledgerEvmProviderOrder({})).toEqual(["alchemy"]);
    expect(ledgerEvmProviderOrder({ HD_JOB_PROVIDERS: "public,etherscan,helius,alchemy" })).toEqual(["public", "alchemy"]);
  });
});
