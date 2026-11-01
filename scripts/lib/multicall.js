/**
 * Multicall3 `aggregate3` helpers (no ABI library in this repo, so the encoding
 * is hand-rolled and covered by tests plus a live check against a real chain).
 *
 * One eth_call to Multicall3 replaces N separate eth_calls: the CU bill drops
 * from N x 26 to one call, and every result comes from the same block (a
 * consistent snapshot, which thousands of calls spread over minutes never are).
 *
 * Multicall3 is deployed at the same address on Ethereum, Polygon, Base and the
 * other chains this project scans.
 */
import { selector } from "./staking.js";
import { rpcCall } from "./rpc.js";

export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const AGGREGATE3_SELECTOR = selector("aggregate3((address,bool,bytes)[])");

/** Calls per aggregate3 before the batch is split (keeps one eth_call well inside node gas/response caps). */
export const DEFAULT_MULTICALL_BATCH = 400;

const WORD = 64; // hex chars in one ABI word
const word = (hex) => hex.padStart(WORD, "0");
const num = (n) => word(n.toString(16));
const strip = (hex) => (hex.startsWith("0x") ? hex.slice(2) : hex);
const padRight = (hex) => hex.padEnd(Math.ceil(hex.length / WORD) * WORD, "0");

function encodeTuple({ target, callData, allowFailure = true }) {
  const data = strip(callData);
  const dataBytes = data.length / 2;
  if (!Number.isInteger(dataBytes)) throw new Error("multicall: callData must be whole bytes");
  return (
    word(strip(target).toLowerCase()) +
    num(allowFailure ? 1 : 0) +
    num(0x60) + // offset of `bytes` inside the tuple: 3 head words
    num(dataBytes) +
    padRight(data)
  );
}

/** @param {{target: string, callData: string, allowFailure?: boolean}[]} calls @returns {string} 0x-prefixed calldata */
export function encodeAggregate3(calls) {
  const tuples = calls.map(encodeTuple);
  let offset = calls.length * 32; // element offsets are relative to the start of the elements area
  const offsets = tuples.map((t) => {
    const here = offset;
    offset += t.length / 2;
    return num(here);
  });
  return `${AGGREGATE3_SELECTOR}${num(0x20)}${num(calls.length)}${offsets.join("")}${tuples.join("")}`;
}

/** @param {string} hex aggregate3 return data @returns {{success: boolean, returnData: string}[]} */
export function decodeAggregate3(hex) {
  const h = strip(hex);
  const read = (wordIndexChars) => Number.parseInt(h.slice(wordIndexChars, wordIndexChars + WORD), 16);
  const arrayStart = read(0) * 2;
  const n = read(arrayStart);
  const elements = arrayStart + WORD;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const tuple = elements + read(elements + i * WORD) * 2;
    const success = read(tuple) === 1;
    const bytesStart = tuple + read(tuple + WORD) * 2;
    const len = read(bytesStart);
    out.push({ success, returnData: `0x${h.slice(bytesStart + WORD, bytesStart + WORD + len * 2)}` });
  }
  return out;
}

const TRANSPORT_ERROR_RE = /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|aborted|timed? ?out|^RPC HTTP (403|429|5\d\d)/i;
const TRANSPORT_ERROR_NAMES = new Set(["TimeoutError", "AbortError"]);

/**
 * True when the failure is the endpoint being unreachable or throttled rather
 * than the batch being rejected. Only batch-shape failures should be bisected.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransportError(err) {
  if (TRANSPORT_ERROR_NAMES.has(err?.name)) return true;
  return TRANSPORT_ERROR_RE.test(String(err?.message ?? err));
}

/**
 * Runs `calls` through Multicall3 on `rpcUrl`. A batch that the node rejects
 * (gas / size / response cap) is split in half and retried; a single call that
 * still fails comes back as `{success: false}` so the caller can fall back to a
 * plain eth_call for just that item. Result order matches `calls`.
 * A transport error (endpoint down, throttled, timed out) is rethrown unchanged
 * and never bisected, so the caller can fail over to another endpoint.
 * @param {string} rpcUrl
 * @param {{target: string, callData: string}[]} calls
 * @param {{maxBatch?: number, call?: typeof rpcCall, multicall?: string}} [opts]
 */
export async function aggregateCalls(rpcUrl, calls, { maxBatch = DEFAULT_MULTICALL_BATCH, call = rpcCall, multicall = MULTICALL3_ADDRESS } = {}) {
  if (calls.length === 0) return [];
  if (calls.length > maxBatch) {
    const out = [];
    for (let i = 0; i < calls.length; i += maxBatch) out.push(...(await aggregateCalls(rpcUrl, calls.slice(i, i + maxBatch), { maxBatch, call, multicall })));
    return out;
  }
  try {
    const result = await call(rpcUrl, "eth_call", [{ to: multicall, data: encodeAggregate3(calls) }, "latest"]);
    const decoded = decodeAggregate3(result);
    if (decoded.length !== calls.length) throw new Error(`multicall: expected ${calls.length} results, got ${decoded.length}`);
    return decoded;
  } catch (err) {
    // Outage: bisecting would multiply failing calls against the same dead endpoint.
    if (isTransportError(err)) throw err;
    if (calls.length === 1) return [{ success: false, returnData: "0x", error: String(err?.message ?? err).slice(0, 120) }];
    const mid = Math.ceil(calls.length / 2);
    const left = await aggregateCalls(rpcUrl, calls.slice(0, mid), { maxBatch, call, multicall });
    const right = await aggregateCalls(rpcUrl, calls.slice(mid), { maxBatch, call, multicall });
    return [...left, ...right];
  }
}
