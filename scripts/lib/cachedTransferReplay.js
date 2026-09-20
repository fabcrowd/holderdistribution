/**
 * Per-date balances for a small set of addresses, replayed from the transfer
 * caches rebuild-history-from-logs.js already wrote.
 *
 * WHY THIS EXISTS. Several backfills need "what did these N addresses hold on
 * each date?" — treasury/Association safes, DEX pools. Answering it from
 * tel-holders.json's `wallets[]` is unsafe: that array is exact for the
 * addresses it contains but silently omits others, and an omitted address is
 * indistinguishable from a zero balance (it renders as a cliff to zero — the
 * artifact class lessons.md keeps documenting). Replaying Transfer logs derives
 * every balance from chain data, so a missing address is impossible.
 *
 * It also needs no credentials. data/rebuild-transfers-<chain>.ndjson covers
 * genesis->head and public/data/date-blocks.json is fully resolved, so a
 * backfill that would otherwise wait on ETHERSCAN_API_KEY or ENV_PASSPHRASE can
 * run wherever those caches exist. They are gitignored (Polygon alone is
 * 1.2 GB), so CI will not have them — callers must handle their absence rather
 * than emit a partial series.
 */
import fs from "node:fs";
import readline from "node:readline";
import { partitionLogsByBoundary, createReplayLedger } from "./historicalReplay.js";

/** Chains whose transfer cache is missing, so a caller can refuse to write. */
export const missingCaches = (chains, transfersPathFor) =>
  chains.filter((chain) => !fs.existsSync(transfersPathFor(chain)));

/**
 * Streams one chain's NDJSON, keeping only transfers touching `addresses`.
 *
 * The regex pre-filter matters: parsing all ~10M lines to discard 99.9% of them
 * dominates runtime otherwise. It can match a substring in an unrelated field,
 * so membership is re-checked properly after parsing.
 */
const collectChainTransfers = async (file, addresses) => {
  const probe = new RegExp([...addresses].join("|"));
  const kept = [];
  let scanned = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    scanned++;
    if (!line || !probe.test(line)) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const from = row.from ? String(row.from).toLowerCase() : null;
    const to = row.to ? String(row.to).toLowerCase() : null;
    if (!(from && addresses.has(from)) && !(to && addresses.has(to))) continue;
    kept.push({ from, to, value: BigInt(row.value), blockNumber: row.blockNumber });
  }
  return { kept, scanned };
};

/**
 * @param {Set<string>} addresses lowercased
 * @param {Record<string, Record<string, number>>} dateBlocks chain -> date -> block
 * @param {(chain: string) => string} transfersPathFor
 * @returns {Promise<Map<string, Map<string, number>>>} date -> address -> balance,
 *   summed across chains. Every requested address is present on every date
 *   (0 when it held nothing), so callers never confuse absent with empty.
 */
export const replayAddressBalances = async ({
  addresses,
  dateBlocks,
  transfersPathFor,
  decimals = 2,
  log = () => {},
}) => {
  const perDate = new Map();

  for (const chain of Object.keys(dateBlocks)) {
    const boundaries = Object.entries(dateBlocks[chain])
      .map(([date, block]) => ({ date, block }))
      .sort((a, b) => a.block - b.block);

    const { kept, scanned } = await collectChainTransfers(transfersPathFor(chain), addresses);
    log(`  ${chain}: scanned ${scanned.toLocaleString()} transfers, kept ${kept.length.toLocaleString()}`);

    const ledger = createReplayLedger({ decimals, minRaw: 0n });
    for (const { logs, boundary } of partitionLogsByBoundary(kept, boundaries)) {
      ledger.apply(logs);
      if (!boundary) continue;
      const snap = ledger.snapshot();
      const forDate = perDate.get(boundary.date) ?? new Map();
      for (const address of addresses) {
        forDate.set(address, (forDate.get(address) ?? 0) + (snap.get(address) ?? 0));
      }
      perDate.set(boundary.date, forDate);
    }
  }

  return perDate;
};
