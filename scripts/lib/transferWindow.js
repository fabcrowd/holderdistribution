/**
 * Per-run store of ERC-20 Transfer logs for one block window.
 *
 * Several feed generators scan the same token over overlapping block ranges.
 * A window file lets them read the logs once and slice them, instead of each
 * one paying for its own eth_getLogs calls. The file is NDJSON (one log per
 * line) with a sidecar meta file that records the covered range and a config
 * hash, so a window built for other tokens or topics is never served.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const SHARED_WINDOW_MAX_BLOCKS = 200000;

const META_VERSION = 1;

/** File name (under the project work dir) of a chain's window; the meta file adds `.meta.json`. */
export const transferWindowName = (chain) => `transfer-window-${chain}.ndjson`;

const toHexBlock = (hex) => parseInt(hex, 16);
const logIndexOf = (log) => (log.logIndex === undefined ? 0 : parseInt(log.logIndex, 16));

const lowerSorted = (values) => values.map((v) => String(v).toLowerCase()).sort();

/** SHA-256 over chain, sorted lowercase token list and topics. Token order does not matter. */
export function windowConfigHash(chain, tokens, topics = [TRANSFER_TOPIC0]) {
  const payload = JSON.stringify({
    chain: String(chain).toLowerCase(),
    tokens: lowerSorted([].concat(tokens)),
    topics,
  });
  return createHash("sha256").update(payload).digest("hex");
}

const compareLogs = (a, b) =>
  toHexBlock(a.blockNumber) - toHexBlock(b.blockNumber) || logIndexOf(a) - logIndexOf(b);

const assertBlockRange = (fromBlock, toBlock) => {
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) {
    throw new Error(`transfer window needs integer blocks, got ${fromBlock}..${toBlock}`);
  }
  if (fromBlock > toBlock) {
    throw new Error(`transfer window fromBlock ${fromBlock} is after toBlock ${toBlock}`);
  }
};

const writeAtomic = async (target, text) => {
  const tmp = `${target}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, target);
};

/** Writes the logs (NDJSON) first, then the meta file, each via a temp file and rename. */
export async function writeWindow(
  file,
  { chain, tokens, topics = [TRANSFER_TOPIC0], fromBlock, toBlock, logs },
) {
  assertBlockRange(fromBlock, toBlock);
  const sorted = [...logs].sort(compareLogs);
  const tokenList = lowerSorted([].concat(tokens));
  const meta = {
    version: META_VERSION,
    chain,
    tokens: tokenList,
    topics,
    fromBlock,
    toBlock,
    count: sorted.length,
    configHash: windowConfigHash(chain, tokens, topics),
  };

  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, sorted.map((log) => `${JSON.stringify(log)}\n`).join(""));
  await writeAtomic(`${file}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

const readTextOrNull = async (target) => {
  try {
    return await readFile(target, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
};

const parseMeta = (text) => {
  try {
    const meta = JSON.parse(text);
    return meta && meta.version === META_VERSION ? meta : null;
  } catch {
    return null;
  }
};

const parseLogLines = (text) => {
  const lines = text.split("\n").filter((line) => line.length > 0);
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    return null;
  }
};

/** `{ meta, logs }` for a readable, self-consistent window; null when missing or corrupt. */
export async function readWindow(file) {
  const metaText = await readTextOrNull(`${file}.meta.json`);
  const logsText = await readTextOrNull(file);
  if (metaText === null || logsText === null) return null;

  const meta = parseMeta(metaText);
  const logs = parseLogLines(logsText);
  if (!meta || !logs || logs.length !== meta.count) return null;
  return { meta, logs };
}

/**
 * Logs inside [fromBlock, toBlock] in stored order, or null when the window
 * does not fully cover the range or was built for a different config hash.
 */
export function sliceWindow(window, fromBlock, toBlock, configHash) {
  if (!window) return null;
  const { meta, logs } = window;
  if (configHash !== undefined && configHash !== meta.configHash) return null;
  if (fromBlock > toBlock) return null;
  if (fromBlock < meta.fromBlock || toBlock > meta.toBlock) return null;

  return logs.filter((log) => {
    const block = toHexBlock(log.blockNumber);
    return block >= fromBlock && block <= toBlock;
  });
}
