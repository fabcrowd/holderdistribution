/**
 * File access for holder snapshots in any layout (legacy, slim-v1, sharded-v1); past revisions: stateStore.js.
 * Readers return what a bare JSON.parse returned before, except that a sharded head is
 * assembled (and verified) from its shard directory.
 */

import { cp, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SNAPSHOT_LAYOUT_SLIM,
  checkSnapshotSize,
  findHoldersMismatch,
  hydrateChainHolders,
  serializeVerified,
  snapshotLayout,
} from "./snapshotFormat.js";
import {
  SNAPSHOT_LAYOUT_SHARDED,
  assembleSnapshot,
  buildShards,
  estimateSlimBytes,
  shardDirFor,
  shardProblem,
  shardTriggerBytes,
} from "./snapshotShards.js";

const MIB = 1024 * 1024;

const isSharded = (head) => head?.layout === SNAPSHOT_LAYOUT_SHARDED;

const missingShardError = (headPath, file, cause) =>
  new Error(`Shard ${file} of ${headPath} is missing or unreadable (${cause.code ?? cause.message})`, { cause });

const diskShardLoader = (headPath) => {
  const dir = shardDirFor(headPath);
  return (file) => {
    try {
      return readFileSync(join(dir, file));
    } catch (error) {
      throw missingShardError(headPath, file, error);
    }
  };
};

export const readSnapshotSync = (file) => {
  const head = JSON.parse(readFileSync(file, "utf8"));
  return isSharded(head) ? assembleSnapshot(head, diskShardLoader(file)) : head;
};

export const readSnapshot = async (file) => {
  const head = JSON.parse(await readFile(file, "utf8"));
  return isSharded(head) ? assembleSnapshot(head, diskShardLoader(file)) : head;
};

const headOnly = (head) => (isSharded(head) ? { ...head, rowsLoaded: false } : head);

/**
 * Parsed head for callers that need only its fields (asOf, generatedAt, ...). A single-file snapshot comes
 * back whole (it is one parse anyway); a sharded one comes back without rows and with `rowsLoaded: false`.
 */
export const readSnapshotHeadSync = (file) => headOnly(JSON.parse(readFileSync(file, "utf8")));

export const readSnapshotHead = async (file) => headOnly(JSON.parse(await readFile(file, "utf8")));

/**
 * A snapshot from a head text read out of any store (stateStore.js reads past revisions); a sharded head is
 * assembled from `loadShard(repoRelShardPath)`, which returns each shard's Buffer.
 */
export const parseSnapshotFrom = (repoRelPath, headText, loadShard) => {
  const head = JSON.parse(headText);
  if (!isSharded(head)) return head;
  const dir = shardDirFor(repoRelPath);
  return assembleSnapshot(head, (file) => loadShard(`${dir}/${file}`));
};

const removeShardDir = (file) => rm(shardDirFor(file), { recursive: true, force: true });

const SHARD_ROUND_TRIP_ERROR = "does not survive the sharded round trip; nothing written";

/** Assemble from the built Buffers and compare with the original before anything touches disk. */
const verifyShardRoundTrip = (snapshot, built, file) => {
  const buffers = new Map(built.shards.map((shard) => [shard.file, shard.data]));
  const assembled = assembleSnapshot(JSON.parse(built.headText), (name) => buffers.get(name));
  const rebuilt = hydrateChainHolders(assembled);
  const key = findHoldersMismatch(snapshot, rebuilt);
  if (key !== null) throw new Error(`Sharded snapshot ${file}: chain "${key}" holders ${SHARD_ROUND_TRIP_ERROR}.`);
  if (!isDeepStrictEqual(assembled.wallets, snapshot.wallets)) {
    throw new Error(`Sharded snapshot ${file}: wallets[] ${SHARD_ROUND_TRIP_ERROR}.`);
  }
};

const gateSize = (bytes, name, log) => {
  const size = checkSnapshotSize(bytes, name);
  if (size.level === "fail") throw new Error(size.message);
  if (size.level === "warn") log.warn(size.message);
};

const decideLayout = (snapshot, file, log) => {
  if (snapshotLayout(snapshot) !== SNAPSHOT_LAYOUT_SLIM) return "single";
  if (estimateSlimBytes(snapshot) < shardTriggerBytes()) return "single";
  const problem = shardProblem(snapshot);
  if (problem === null) return SNAPSHOT_LAYOUT_SHARDED;
  log.warn(`${file} is large enough to shard but cannot be (${problem}); writing a single file.`);
  return "single";
};

const writeSingle = async (file, snapshot, log) => {
  const text = serializeVerified(snapshot, file, log);
  await writeFile(file, text);
  await removeShardDir(file);
  return { layout: snapshotLayout(snapshot) === SNAPSHOT_LAYOUT_SLIM ? SNAPSHOT_LAYOUT_SLIM : "legacy", bytes: Buffer.byteLength(text), files: 1 };
};

const writeSharded = async (file, snapshot, log) => {
  const built = buildShards(snapshot);
  verifyShardRoundTrip(snapshot, built, file);
  const headBytes = Buffer.byteLength(built.headText);
  gateSize(headBytes, file, log);
  for (const shard of built.shards) gateSize(shard.bytes, `${file} shard ${shard.file}`, log);

  const dir = shardDirFor(file);
  const tmpDir = `${dir}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  for (const shard of built.shards) await writeFile(join(tmpDir, shard.file), shard.data);
  // Shards are swapped in before the head: a crash in between leaves the old head whose manifest
  // hashes no longer match the new shards, so readSnapshot rejects it instead of mixing two snapshots.
  await rm(dir, { recursive: true, force: true });
  await rename(tmpDir, dir);
  const tmpHead = `${file}.tmp`;
  await writeFile(tmpHead, built.headText);
  await rename(tmpHead, file);

  const bytes = built.shards.reduce((sum, shard) => sum + shard.bytes, headBytes);
  return { layout: SNAPSHOT_LAYOUT_SHARDED, bytes, files: built.shards.length + 1, rows: snapshot.wallets.length };
};

/** Writes the snapshot in the layout it needs; returns `{ layout, bytes, files }` (files includes the head). */
export const writeSnapshotFiles = async (file, snapshot, { log = console } = {}) => {
  await mkdir(dirname(file), { recursive: true });
  const layout = decideLayout(snapshot, file, log);
  const result = layout === SNAPSHOT_LAYOUT_SHARDED ? await writeSharded(file, snapshot, log) : await writeSingle(file, snapshot, log);
  const rows = result.rows ?? snapshot.wallets?.length ?? 0;
  log.log?.(`Wrote ${file}: layout ${result.layout}, ${rows} wallets, ${result.files} file(s), ${(result.bytes / MIB).toFixed(2)} MiB.`);
  return { layout: result.layout, bytes: result.bytes, files: result.files };
};

/** Copies head (+ shard directory when sharded); a single-file source clears a stale destination shard directory. */
export const copySnapshotFiles = async (srcFile, destFile) => {
  const head = JSON.parse(await readFile(srcFile, "utf8"));
  const destDir = shardDirFor(destFile);
  await rm(destDir, { recursive: true, force: true });
  if (isSharded(head)) await cp(shardDirFor(srcFile), destDir, { recursive: true });
  await copyFile(srcFile, destFile);
};

export const removeSnapshotFiles = async (file) => {
  await rm(file, { force: true });
  await removeShardDir(file);
};

/**
 * Writes `snapshot` to `file`; when `rotate` is true the files `file` held before become `previousFile`.
 * The old files are copied to a staging path first and only moved into place after the new write succeeds,
 * so a refused write (round trip or size gate) leaves both `file` and `previousFile` exactly as they were.
 * The caller owns the rotation decision (canRotatePrevious); a layout is kept as it was on disk.
 */
export const publishSnapshot = async ({ file, previousFile, snapshot, rotate, log = console }) => {
  const stage = `${previousFile}.stage.json`;
  if (rotate) await copySnapshotFiles(file, stage);
  let result;
  try {
    result = await writeSnapshotFiles(file, snapshot, { log });
  } catch (error) {
    if (rotate) await removeSnapshotFiles(stage);
    throw error;
  }
  if (!rotate) return { ...result, rotated: false };
  await removeSnapshotFiles(previousFile);
  await rename(shardDirFor(stage), shardDirFor(previousFile)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rename(stage, previousFile);
  log.log?.(`Archived prior snapshot to ${previousFile}`);
  return { ...result, rotated: true };
};
