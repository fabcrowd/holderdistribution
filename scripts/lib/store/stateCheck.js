// The state check (design 2.1, 3.6): per bucket a row count and an order-independent
// 64-bit hash, the sum modulo 2^64 of one hash per row over key and value together,
// so two keys that swap values do not cancel.
import { createHash } from "node:crypto";

const MASK = (1n << 64n) - 1n;

function h64(text) {
  return createHash("sha256").update(text, "utf8").digest().readBigUInt64BE(0);
}

const fields = (v) => v.map(String).join("\x1f");

export const rowHash = (key, value) => h64(`${key}\x00${fields(value)}`);
export const changeRowHash = (key, oldValue, newValue) => h64(`${key}\x00${fields(oldValue)}\x01${fields(newValue)}`);
export const addHash = (a, b) => (a + b) & MASK;
export const subHash = (a, b) => (a - b + (1n << 64n)) & MASK;
export const hashToHex = (h) => h.toString(16).padStart(16, "0");
export const hexToHash = (s) => BigInt(`0x${s}`);
export const isZero = (v) => v.every((x) => x === 0n);
export const sameValue = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function hashRows(rows) {
  let hash = 0n;
  for (const [k, v] of rows) hash = addHash(hash, rowHash(k, v));
  return { count: rows.size, hash };
}

// ctx: { table, bucket, day, part }. Every check failure and every unreadable item
// is reported with all four so the failing read can be found.
export class StoreCheckError extends Error {
  constructor(ctx, detail, cause) {
    super(`state check failed: table=${ctx.table} bucket=${ctx.bucket} day=${ctx.day} part=${ctx.part}: ${detail}`, cause ? { cause } : undefined);
    this.name = "StoreCheckError";
    Object.assign(this, { table: ctx.table, bucket: ctx.bucket, day: ctx.day, part: ctx.part });
  }
}

export function checkState(ctx, actual, expected, what) {
  const want = typeof expected.hash === "string" ? hexToHash(expected.hash) : expected.hash;
  if (actual.count !== expected.count || actual.hash !== want) {
    throw new StoreCheckError(
      ctx,
      `${what}: rebuilt ${actual.count} rows hash ${hashToHex(actual.hash)}, recorded ${expected.count} rows hash ${hashToHex(want)}`,
    );
  }
}

// Wraps any failure while reading an item (decode error, missing item) with its context.
export async function withContext(ctx, what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StoreCheckError) throw err;
    throw new StoreCheckError(ctx, `${what}: ${err.message}`, err);
  }
}
