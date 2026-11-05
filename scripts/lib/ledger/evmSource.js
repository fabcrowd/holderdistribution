/**
 * EVM side of the developer-wallet ledger: Alchemy alchemy_getAssetTransfers
 * per wallet and direction (from / to), restricted to the project token(s) and
 * the ledger stablecoins, plus receipts (Swap topics) for transfers whose
 * recipient is unlabelled. Etherscan v2 (free tier) is the cross-check only;
 * its rows are never merged into the ledger (see etherscanMultiKey.js header).
 *
 * Keyless alternative (logsAssetTransfers): the same rows from eth_getLogs on
 * any RPC (public nodes first, per config/nightly-jobs.json `providers`), shaped
 * exactly like Alchemy's response (uniqueId `<hash>:log:<logIndex>`, raw hex
 * value, ISO block timestamp), so normalizeAlchemyTransfer and every downstream
 * row are byte-identical whichever source served the scan.
 *
 * Network calls are injected (`rpc`, `assetTransfers`) so tests run offline.
 */
import { callGetAssetTransfers } from "../alchemyTransfers.js";
import { SWAP_TOPICS } from "../walletFlows.js";

const MAX_COUNT_HEX = "0x3e8"; // 1000, Alchemy's per-page maximum
const hex = (n) => "0x" + Number(n).toString(16);

/** Paid Alchemy URLs from <PREFIX>_RPC_n (getAllRpcUrls); alchemy_getAssetTransfers exists only there. */
export const alchemyOnly = (urls) => urls.filter((u) => /alchemy\.com|alchemyapi\.io/i.test(u));

/**
 * token map for one chain: contract -> { asset: "token"|"stable", symbol, decimals }.
 * `chainCfg` is projectChains()[chain] (tokens.legacy / tokens.v3).
 */
export function evmAssetMap(chainCfg, stablecoins = [], ticker = "TOKEN") {
  const m = new Map();
  for (const [slot, t] of Object.entries(chainCfg?.tokens ?? {})) {
    if (t?.address) m.set(t.address.toLowerCase(), { asset: "token", symbol: slot === "legacy" && chainCfg.tokens.v3 ? `${ticker} (legacy)` : ticker, decimals: t.decimals });
  }
  if (!m.size && chainCfg?.tokenAddress) m.set(chainCfg.tokenAddress.toLowerCase(), { asset: "token", symbol: ticker, decimals: chainCfg.decimals });
  for (const s of stablecoins) m.set(s.address.toLowerCase(), { asset: "stable", symbol: s.symbol, decimals: s.decimals });
  return m;
}

/** Alchemy transfer -> ledger transfer (null when the contract is not tracked). */
export function normalizeAlchemyTransfer(t, chain, assets) {
  const contract = t?.rawContract?.address?.toLowerCase();
  const a = contract ? assets.get(contract) : null;
  if (!a || typeof t?.rawContract?.value !== "string" || !t.hash) return null;
  let raw;
  try {
    raw = BigInt(t.rawContract.value);
  } catch {
    return null;
  }
  const ts = t?.metadata?.blockTimestamp ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : null;
  return {
    chain,
    hash: t.hash,
    uniqueId: t.uniqueId ?? `${t.hash}:${contract}:${t.from}:${t.to}:${t.rawContract.value}`,
    blockNumber: parseInt(t.blockNum, 16),
    time: ts,
    from: t.from?.toLowerCase() ?? null,
    to: t.to?.toLowerCase() ?? null,
    contract,
    asset: a.asset,
    symbol: a.symbol,
    amount: Number(raw) / 10 ** a.decimals,
  };
}

/** Every transfer of `contracts` from or to `address` in [fromBlock, toBlock], paginated. */
export async function fetchWalletTransfers({ url, address, direction, contracts, fromBlock, toBlock, assetTransfers = callGetAssetTransfers }) {
  const rows = [];
  let pageKey;
  do {
    const res = await assetTransfers(url, {
      fromBlock: hex(fromBlock),
      toBlock: typeof toBlock === "number" ? hex(toBlock) : toBlock,
      [direction === "from" ? "fromAddress" : "toAddress"]: address,
      contractAddresses: contracts,
      category: ["erc20"],
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: MAX_COUNT_HEX,
      order: "asc",
      ...(pageKey ? { pageKey } : {}),
    });
    rows.push(...(res?.transfers ?? []));
    pageKey = res?.pageKey;
  } while (pageKey);
  return rows;
}

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const addrFromTopic = (t) => "0x" + String(t).slice(-40).toLowerCase();

/**
 * alchemy_getAssetTransfers stand-in over eth_getLogs (ERC-20 Transfer events).
 * Same call signature as callGetAssetTransfers(url, params); returns every row in
 * one page (no pageKey). `getLogs(url, filter)` is rpc.js getLogs (bisects ranges
 * a public node refuses); block timestamps come from eth_getBlockByNumber,
 * cached per block across calls.
 */
export function logsAssetTransfers({ rpc, getLogs, blockTimes = new Map() }) {
  const blockTime = async (url, n) => {
    if (!blockTimes.has(n)) {
      const b = await rpc(url, "eth_getBlockByNumber", ["0x" + n.toString(16), false]);
      blockTimes.set(n, parseInt(b?.timestamp ?? "0x0", 16));
    }
    return blockTimes.get(n);
  };
  return async function assetTransfers(url, params) {
    let toBlock = params.toBlock;
    if (typeof toBlock !== "string" || !toBlock.startsWith("0x")) toBlock = await rpc(url, "eth_blockNumber", []);
    const topics = [TRANSFER_TOPIC, params.fromAddress ? topicAddr(params.fromAddress) : null, params.toAddress ? topicAddr(params.toAddress) : null];
    while (topics.length && topics.at(-1) === null) topics.pop();
    const logs = await getLogs(url, { fromBlock: params.fromBlock, toBlock, address: params.contractAddresses, topics });
    const rows = [];
    for (const l of logs) {
      if (!Array.isArray(l?.topics) || l.topics.length < 3 || String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
      let value;
      try {
        value = BigInt(l.data && l.data !== "0x" ? l.data : "0x0");
      } catch {
        continue;
      }
      if (params.excludeZeroValue && value === 0n) continue;
      const block = parseInt(l.blockNumber, 16);
      const ts = await blockTime(url, block);
      rows.push({
        blockNum: "0x" + block.toString(16),
        uniqueId: `${l.transactionHash}:log:${parseInt(l.logIndex, 16)}`,
        hash: l.transactionHash,
        from: addrFromTopic(l.topics[1]),
        to: addrFromTopic(l.topics[2]),
        category: "erc20",
        rawContract: { address: String(l.address).toLowerCase(), value: "0x" + value.toString(16) },
        metadata: { blockTimestamp: new Date(ts * 1000).toISOString() },
        _logIndex: parseInt(l.logIndex, 16),
      });
    }
    rows.sort((a, b) => parseInt(a.blockNum, 16) - parseInt(b.blockNum, 16) || a._logIndex - b._logIndex);
    for (const r of rows) delete r._logIndex;
    return { transfers: rows };
  };
}

/**
 * Ledger EVM providers in job order. HD_JOB_PROVIDERS (config/nightly-jobs.json
 * via rpcMetrics.resolveJobEnv) opts a run into "public"; without it the scan
 * stays on Alchemy, exactly as before.
 */
export function ledgerEvmProviderOrder(env = {}) {
  const order = String(env.HD_JOB_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter((p) => p === "public" || p === "alchemy");
  return order.length ? order : ["alchemy"];
}

/** True when the receipt has a DEX Swap event (walletFlows SWAP_TOPICS). */
export async function receiptHasSwap(rpc, url, hash) {
  const rec = await rpc(url, "eth_getTransactionReceipt", [hash]);
  return (rec?.logs ?? []).some((l) => SWAP_TOPICS.has(String(l?.topics?.[0] ?? "").toLowerCase()));
}

/** First block with timestamp >= target (binary search, ~log2(head) calls). */
export async function blockAtOrAfter(rpc, url, targetSec, head) {
  const ts = async (n) => parseInt((await rpc(url, "eth_getBlockByNumber", [hex(n), false]))?.timestamp ?? "0x0", 16);
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await ts(mid)) < targetSec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Incremental scan of one EVM chain.
 * @returns {{ transfers: object[], botTransfers: object[], cursor: {lastBlock:number, headTime:string}, stats: object }}
 */
export async function scanEvmChain({
  chain,
  url,
  rpc,
  assets,
  wallets,
  botAddresses = [],
  checkpoint = null,
  nowSec,
  historyDays,
  isLabelled,
  assetTransfers = callGetAssetTransfers,
  logger = console,
  maxReceipts = 2000,
}) {
  const head = parseInt(await rpc(url, "eth_blockNumber", []), 16);
  const fromBlock = Number.isInteger(checkpoint?.lastBlock)
    ? checkpoint.lastBlock + 1
    : await blockAtOrAfter(rpc, url, nowSec - historyDays * 86400, head);
  const contracts = [...assets.keys()];
  const seen = new Set();
  const transfers = [];
  const push = (list, t) => {
    if (!t || seen.has(t.uniqueId)) return;
    seen.add(t.uniqueId);
    list.push(t);
  };
  if (fromBlock > head) return { transfers, botTransfers: [], cursor: { lastBlock: head }, stats: { fromBlock, head, wallets: wallets.length, receipts: 0 } };

  for (const w of wallets) {
    for (const direction of ["from", "to"]) {
      const raw = await fetchWalletTransfers({ url, address: w.address.toLowerCase(), direction, contracts, fromBlock, toBlock: head, assetTransfers });
      for (const r of raw) push(transfers, normalizeAlchemyTransfer(r, chain, assets));
    }
  }
  const botTransfers = [];
  const tokenContracts = contracts.filter((c) => assets.get(c).asset === "token");
  for (const b of botAddresses) {
    const raw = await fetchWalletTransfers({ url, address: b.toLowerCase(), direction: "from", contracts: tokenContracts, fromBlock, toBlock: head, assetTransfers });
    for (const r of raw) push(botTransfers, normalizeAlchemyTransfer(r, chain, assets));
  }

  // Receipts only where the destination is unlabelled (labelled venues need none).
  let receipts = 0;
  for (const t of [...transfers, ...botTransfers]) {
    if (t.asset !== "token" || isLabelled(t.to) || receipts >= maxReceipts) continue;
    if (!wallets.some((w) => w.address.toLowerCase() === t.from) && !botAddresses.some((b) => b.toLowerCase() === t.from)) continue;
    try {
      t.swap = await receiptHasSwap(rpc, url, t.hash);
      receipts++;
    } catch (err) {
      logger.warn?.(`${chain}: receipt ${t.hash} failed (${String(err?.message ?? err).slice(0, 80)})`);
    }
  }
  return {
    transfers,
    botTransfers,
    cursor: { lastBlock: head, headTime: new Date(nowSec * 1000).toISOString() },
    stats: { fromBlock, head, wallets: wallets.length, transfers: transfers.length, botTransfers: botTransfers.length, receipts },
  };
}

/**
 * Etherscan v2 cross-check: count one wallet's token transfers over the same
 * block range and compare with the Alchemy count. Returns a summary row; a
 * mismatch is reported, never "fixed".
 */
export function crossCheckRow({ chain, address, alchemyCount, etherscanCount }) {
  return { chain, address, alchemyCount, etherscanCount, match: alchemyCount === etherscanCount };
}
