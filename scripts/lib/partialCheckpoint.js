/**
 * Mid-scan ("partial") checkpoints for the pull-holders-rpc legacy-token log scan.
 *
 * The real checkpoint (holders-checkpoint.json) is only written when a scan
 * finishes, so a cold public-RPC scan that stalls hours in restarts from genesis.
 * A partial checkpoint is written beside it in the project's WORK dir (never in
 * public/data) as `holders-partial-<chain>.json`, atomically (tmp + rename), and
 * deleted once the chain's scan completes — so finished runs, and TEL/ZBCN
 * outputs, are byte-identical to before.
 *
 * Exactness: it stores the FULL raw balance map (negatives and zeros included,
 * unlike the final checkpoint's dust filter) and the last block whose logs are
 * all applied. Blocks are applied strictly in contiguous slices, so resuming at
 * lastBlock + 1 applies every log exactly once. It is only used when it was
 * built on top of exactly the same base (token, start block, and the final
 * checkpoint's lastBlock it resumed from, or none).
 */
import fs from "node:fs/promises";
import path from "node:path";

export const PARTIAL_SCHEMA = 1;

export const partialName = (chainKey) => `holders-partial-${chainKey}.json`;

export function serializePartial({ chainKey, token, genesisBlock, baseLastBlock, lastBlock, raw }) {
  const rawBalances = {};
  for (const [addr, v] of raw) rawBalances[addr] = v.toString();
  return {
    schemaVersion: PARTIAL_SCHEMA,
    kind: "holders-partial",
    savedAt: new Date().toISOString(),
    chainKey,
    token: token.toLowerCase(),
    genesisBlock,
    baseLastBlock: baseLastBlock ?? null,
    lastBlock,
    rawBalances,
  };
}

/** Atomic write: a crash mid-write leaves the previous partial intact. */
export async function writePartial(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.rename(tmp, file);
}

export async function readPartial(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function removePartial(file) {
  await fs.rm(file, { force: true });
}

/**
 * Saved scan state of a resumable (non-EVM) adapter: the file's content when the adapter accepts it, else null.
 * An unreadable file or one the adapter rejects (other version, floor, width, malformed) is warned about and
 * removed, so the scan starts fresh; this never throws.
 */
export async function loadResumable(adapter, chain, file, log = console) {
  let saved = null;
  try {
    saved = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    log.warn?.(`${chain.key}: ignoring unreadable saved scan state (${e.message}); starting a fresh scan.`);
    await removePartial(file);
    return null;
  }
  if (saved === null) return null;
  let problem;
  try {
    problem = adapter.resumeProblem(chain, saved);
  } catch (e) {
    problem = `unusable (${e.message})`;
  }
  if (!problem) return saved;
  log.warn?.(`${chain.key}: ignoring saved scan state (${problem}); starting a fresh scan.`);
  await removePartial(file);
  return null;
}

/** An adapter opts in to keeping its finished scan state with `keepsFinishedScan: true`; no chain or slug is ever named here. */
export const keepsFinishedScan = (adapter) => adapter?.keepsFinishedScan === true;

/** After the chain's checkpoint is saved: remove the partial file unless the adapter keeps its finished state. */
export async function settlePartial(adapter, file) {
  if (keepsFinishedScan(adapter)) return false;
  await removePartial(file);
  return true;
}

/** A partial is usable only on exactly the base it was built from. */
export function partialUsable(partial, { chainKey, token, genesisBlock, baseLastBlock }) {
  if (!partial || partial.schemaVersion !== PARTIAL_SCHEMA || partial.kind !== "holders-partial") return false;
  if (partial.chainKey !== chainKey || partial.token !== token.toLowerCase()) return false;
  if (partial.genesisBlock !== genesisBlock) return false;
  if ((partial.baseLastBlock ?? null) !== (baseLastBlock ?? null)) return false;
  if (!Number.isFinite(partial.lastBlock)) return false;
  const start = baseLastBlock == null ? genesisBlock : baseLastBlock + 1;
  return partial.lastBlock >= start - 1;
}

/** True when a pinned run (pinBlock set) would resume from a partial that already applied logs past the pin. */
export const partialAheadOfPin = (partial, pinBlock) =>
  pinBlock != null && Number.isFinite(partial?.lastBlock) && partial.lastBlock > pinBlock;

/**
 * The whole resume decision, pure (no I/O, no logging). `discard` names why a present partial must be
 * removed: "different-base" (fails partialUsable) or "ahead-of-pin" (usable base, but past the run's pin).
 */
export function partialResumeDecision(partial, { chainKey, token, genesisBlock, baseLastBlock, pinBlock = null }) {
  if (!partial) return { resume: false, discard: null };
  if (!partialUsable(partial, { chainKey, token, genesisBlock, baseLastBlock })) return { resume: false, discard: "different-base" };
  if (partialAheadOfPin(partial, pinBlock)) return { resume: false, discard: "ahead-of-pin" };
  return { resume: true, discard: null };
}

export const partialRaw = (partial) => new Map(Object.entries(partial.rawBalances ?? {}).map(([a, v]) => [a, BigInt(v)]));

/** Block chunks [from, to] of `chunkSize` covering fromBlock..latest. */
export function buildChunks(fromBlock, latest, chunkSize) {
  const chunks = [];
  for (let from = fromBlock; from <= latest; from += chunkSize) chunks.push({ from, to: Math.min(from + chunkSize - 1, latest) });
  return chunks;
}

/**
 * Fetches chunks `concurrency` at a time and applies each slice in block order.
 * After a whole slice is applied, `onProgress(lastAppliedBlock)` is awaited — the
 * only point where a partial checkpoint may be taken. A failing chunk rejects
 * the slice, so nothing from it is applied (no partial slice, no double count).
 */
export async function streamChunks({ chunks, concurrency, fetchChunk, onLogs, onProgress = null }) {
  let totalLogs = 0;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const slice = chunks.slice(i, i + concurrency);
    const results = await Promise.all(slice.map((c, idx) => fetchChunk(c, idx).then((logs) => ({ ...c, logs }))));
    for (const r of results) {
      if (r.logs.length > 0) {
        onLogs(r.logs, r);
        totalLogs += r.logs.length;
      }
    }
    if (onProgress) await onProgress(slice[slice.length - 1].to, totalLogs);
  }
  return totalLogs;
}
