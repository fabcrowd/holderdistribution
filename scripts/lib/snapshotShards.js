/**
 * "sharded-v1" snapshot layout: a small head JSON plus plain-text shard files that git can delta
 * night to night. Pure (no fs): builds shard Buffers from a snapshot and assembles one back,
 * verifying every shard against the head's manifest.
 *
 * Shard file `wallets-<NNN>.tsv` holds the accounts with number in [lo, hi), one per line in
 * ascending account number, after a header line `#sharded-v1 ids=[lo,hi) col=<column>`.
 * Readers concatenate shards in range order and stable-sort by balance descending, which
 * reproduces the canonical wallets[] order (total descending, ties ascending account number).
 */

import { createHash } from "node:crypto";
import {
  SNAPSHOT_LAYOUT_SLIM,
  SNAPSHOT_WARN_BYTES,
  slimChain,
  snapshotLayout,
} from "./snapshotFormat.js";

export const SNAPSHOT_LAYOUT_SHARDED = "sharded-v1";
export const SHARD_ID_WIDTH = 1_000_000;
export const SHARD_ORDER = "total-desc-id-asc";

const SHARD_TRIGGER_ENV = "HD_SNAPSHOT_SHARD_BYTES";
const SHARD_FILE_PATTERN = /^wallets-\d{3,}\.tsv$/;
const ADDRESS_PATTERN = /^0\.0\.(0|[1-9]\d*)$/;
const ADDRESS_PREFIX = "0.0.";
const TOTAL_KEY = "total_telcoin_balance";
const BALANCE_SUFFIX = "_balance";
const ROW_SEPARATOR_BYTES = 2; // ",\n" between wallet rows in the slim text

export const shardTriggerBytes = () => {
  const raw = process.env[SHARD_TRIGGER_ENV];
  const parsed = Number(raw);
  return raw && Number.isInteger(parsed) && parsed > 0 ? parsed : SNAPSHOT_WARN_BYTES;
};

/** `x/tel-holders.json` -> `x/tel-holders.d`. Pure string operation (works on `rev:path` style paths). */
export const shardDirFor = (headPath) => `${headPath.replace(/\.json$/, "")}.d`;

const slimShell = (snapshot) => {
  const { layout: _layout, wallets: _wallets, ...rest } = snapshot;
  const chains = {};
  for (const [key, chain] of Object.entries(rest.chains)) chains[key] = slimChain(snapshot, key, chain);
  return { ...rest, chains };
};

/** Estimated byte size of the slim-v1 text, within a few percent, without building the string. */
export const estimateSlimBytes = (snapshot) => {
  const headLength = JSON.stringify({ layout: SNAPSHOT_LAYOUT_SLIM, ...slimShell(snapshot), wallets: [] }, null, 2).length;
  let rows = 0;
  for (const wallet of snapshot.wallets ?? []) rows += JSON.stringify(wallet).length + ROW_SEPARATOR_BYTES;
  return headLength + rows;
};

const accountNumberOf = (address) => Number(address.slice(ADDRESS_PREFIX.length));

const hasExactKeys = (wallet, keys) => {
  const own = Object.keys(wallet ?? {});
  return own.length === keys.length && keys.every((key, i) => own[i] === key);
};

const walletProblem = (wallet, index, column) => {
  if (!hasExactKeys(wallet, ["address", column, TOTAL_KEY])) return `wallet ${index} does not have exactly the keys address, ${column}, ${TOTAL_KEY}`;
  if (typeof wallet.address !== "string" || !ADDRESS_PATTERN.test(wallet.address)) return `wallet ${index} address is not 0.0.<n>`;
  if (!Number.isSafeInteger(accountNumberOf(wallet.address))) return `wallet ${index} account number is not a safe integer`;
  const balance = wallet[column];
  if (!Number.isFinite(balance) || !Number.isFinite(wallet[TOTAL_KEY])) return `wallet ${index} balance is not finite`;
  if (balance !== wallet[TOTAL_KEY]) return `wallet ${index} ${column} differs from ${TOTAL_KEY}`;
  return null;
};

const inCanonicalOrder = (prev, next) => {
  if (prev[TOTAL_KEY] !== next[TOTAL_KEY]) return prev[TOTAL_KEY] > next[TOTAL_KEY];
  return accountNumberOf(prev.address) < accountNumberOf(next.address);
};

/** null when the snapshot can be written sharded, else a short reason. */
export const shardProblem = (snapshot) => {
  if (snapshotLayout(snapshot) !== SNAPSHOT_LAYOUT_SLIM) return "not a single-chain snapshot";
  if (!Array.isArray(snapshot.wallets)) return "wallets[] is missing";
  const column = `${Object.keys(snapshot.chains)[0]}${BALANCE_SUFFIX}`;
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < snapshot.wallets.length; i += 1) {
    const wallet = snapshot.wallets[i];
    const problem = walletProblem(wallet, i, column);
    if (problem) return problem;
    if (seen.has(wallet.address)) return `duplicate address ${wallet.address}`;
    seen.add(wallet.address);
    if (prev && !inCanonicalOrder(prev, wallet)) return `wallets[] is not in canonical order at index ${i}`;
    prev = wallet;
  }
  return null;
};

const sha256Of = (buffer) => createHash("sha256").update(buffer).digest("hex");

const shardFileName = (index) => `wallets-${String(index).padStart(3, "0")}.tsv`;

const shardHeader = (lo, hi, column) => `#${SNAPSHOT_LAYOUT_SHARDED} ids=[${lo},${hi}) col=${column}`;

const rowText = (id, balance) => {
  const text = String(balance);
  if (!Number.isFinite(balance) || !Object.is(Number(text), balance)) {
    throw new Error(`Account 0.0.${id}: balance ${text} does not round-trip through String/Number`);
  }
  return `${id}\t${text}\n`;
};

const groupByRange = (wallets) => {
  const ranges = new Map();
  for (const wallet of wallets) {
    const id = accountNumberOf(wallet.address);
    const index = Math.floor(id / SHARD_ID_WIDTH);
    if (!ranges.has(index)) ranges.set(index, []);
    ranges.get(index).push({ id, balance: wallet[TOTAL_KEY] });
  }
  return [...ranges.entries()].sort((a, b) => a[0] - b[0]);
};

const buildShard = (index, rows, column) => {
  const lo = index * SHARD_ID_WIDTH;
  const hi = lo + SHARD_ID_WIDTH;
  rows.sort((a, b) => a.id - b.id);
  const lines = [`${shardHeader(lo, hi, column)}\n`];
  for (const row of rows) lines.push(rowText(row.id, row.balance));
  const data = Buffer.from(lines.join(""), "utf8");
  return { file: shardFileName(index), lo, hi, rows: rows.length, bytes: data.length, sha256: sha256Of(data), data };
};

/** `{ head, headText, shards }`; throws the shardProblem reason when the snapshot cannot be sharded. */
export const buildShards = (snapshot) => {
  const problem = shardProblem(snapshot);
  if (problem) throw new Error(`Snapshot cannot be sharded: ${problem}`);
  const column = `${Object.keys(snapshot.chains)[0]}${BALANCE_SUFFIX}`;
  const shards = groupByRange(snapshot.wallets).map(([index, rows]) => buildShard(index, rows, column));
  const walletShards = {
    idWidth: SHARD_ID_WIDTH,
    order: SHARD_ORDER,
    column,
    rows: snapshot.wallets.length,
    files: shards.map(({ file, lo, hi, rows, bytes, sha256 }) => ({ file, lo, hi, rows, bytes, sha256 })),
  };
  const head = { layout: SNAPSHOT_LAYOUT_SHARDED, ...slimShell(snapshot), walletShards };
  return { head, headText: `${JSON.stringify(head, null, 2)}\n`, shards };
};

const shardFail = (file, what) => new Error(`Shard ${file}: ${what}`);

const loadVerifiedBytes = (entry, loadShard) => {
  if (typeof entry.file !== "string" || !SHARD_FILE_PATTERN.test(entry.file)) throw shardFail(entry.file, "manifest file name is not wallets-<NNN>.tsv");
  const data = loadShard(entry.file);
  if (data.length !== entry.bytes) throw shardFail(entry.file, `has ${data.length} bytes, manifest says ${entry.bytes}`);
  const sha = sha256Of(data);
  if (sha !== entry.sha256) throw shardFail(entry.file, `sha256 ${sha} does not match manifest ${entry.sha256}`);
  return data;
};

/**
 * Appends the shard's wallets to `out`. Single indexed pass over the text: no split into a line array.
 * Row validity is checked by canonical re-stringification so garbage cannot slip through Number().
 */
const parseShardInto = (entry, text, column, out) => {
  const headerEnd = text.indexOf("\n");
  const expected = shardHeader(entry.lo, entry.hi, column);
  if (headerEnd < 0 || text.slice(0, headerEnd) !== expected) throw shardFail(entry.file, `header is not "${expected}"`);
  let rows = 0;
  let prevId = -1;
  let pos = headerEnd + 1;
  while (pos < text.length) {
    const lineEnd = text.indexOf("\n", pos);
    if (lineEnd < 0) throw shardFail(entry.file, "last row has no line feed");
    const tab = text.indexOf("\t", pos);
    if (tab < 0 || tab > lineEnd) throw shardFail(entry.file, `row ${rows + 1} has no tab`);
    const id = Number(text.slice(pos, tab));
    const balance = Number(text.slice(tab + 1, lineEnd));
    if (!Number.isSafeInteger(id) || String(id) !== text.slice(pos, tab)) throw shardFail(entry.file, `row ${rows + 1} has a bad account number`);
    if (!Number.isFinite(balance) || String(balance) !== text.slice(tab + 1, lineEnd)) throw shardFail(entry.file, `row ${rows + 1} has a bad balance`);
    if (id < entry.lo || id >= entry.hi) throw shardFail(entry.file, `account ${id} is outside [${entry.lo},${entry.hi})`);
    if (id <= prevId) throw shardFail(entry.file, `account ${id} is not ascending after ${prevId}`);
    out.push({ address: `${ADDRESS_PREFIX}${id}`, [column]: balance, [TOTAL_KEY]: balance });
    prevId = id;
    rows += 1;
    pos = lineEnd + 1;
  }
  if (rows !== entry.rows) throw shardFail(entry.file, `has ${rows} rows, manifest says ${entry.rows}`);
};

const manifestOf = (head) => {
  const manifest = head?.walletShards;
  if (!manifest || !Array.isArray(manifest.files) || typeof manifest.column !== "string") {
    throw new Error("Sharded head has no valid walletShards manifest");
  }
  if (manifest.idWidth !== SHARD_ID_WIDTH || manifest.order !== SHARD_ORDER) {
    throw new Error(`Sharded head: unsupported idWidth/order (${manifest.idWidth}, ${manifest.order})`);
  }
  return manifest;
};

/**
 * Head + shards -> snapshot with `wallets` and without `walletShards`. The result carries the
 * "slim-v1" marker, so it is exactly what a parsed slim file looks like and hydrateChainHolders
 * (which only looks at `chains.<k>.holdersOmitted` and `wallets`) works on it unchanged.
 * `loadShard(file)` returns the shard's Buffer.
 */
export const assembleSnapshot = (head, loadShard) => {
  const manifest = manifestOf(head);
  const wallets = [];
  let prevLo = -1;
  for (const entry of manifest.files) {
    if (entry.lo <= prevLo) throw shardFail(entry.file, "manifest ranges are not ascending");
    prevLo = entry.lo;
    const text = loadVerifiedBytes(entry, loadShard).toString("utf8");
    parseShardInto(entry, text, manifest.column, wallets);
  }
  if (wallets.length !== manifest.rows) {
    throw new Error(`Sharded snapshot has ${wallets.length} rows in its shards, manifest says ${manifest.rows}`);
  }
  // Array.prototype.sort is stable: ties keep ascending account number from the range-ordered concat.
  wallets.sort((a, b) => b[TOTAL_KEY] - a[TOTAL_KEY]);
  const { walletShards: _manifest, layout: _layout, ...rest } = head;
  return { layout: SNAPSHOT_LAYOUT_SLIM, ...rest, wallets };
};
