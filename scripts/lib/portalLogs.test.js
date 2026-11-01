import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PortalError,
  PortalReorgError,
  chainToDataset,
  mapPortalLog,
  streamLogs,
} from "./portalLogs.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const TOKEN = "0x7e13b43065380acdec1c2d138c579cbbbafa0731";
const TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HASH = (n) => "0x" + n.toString(16).padStart(64, "0");

function logOf(blockNumber, logIndex) {
  return {
    address: TOKEN,
    topics: [TOPIC0, HASH(1), HASH(2)],
    data: "0x" + "00".repeat(31) + "0a",
    transactionHash: HASH(blockNumber * 1000 + logIndex),
    logIndex,
    transactionIndex: 0,
  };
}

function blockLine(number, logCount = 0) {
  const line = { header: { number, hash: HASH(number), timestamp: 1793491776 + number } };
  if (logCount > 0) line.logs = Array.from({ length: logCount }, (_, i) => logOf(number, i));
  return JSON.stringify(line) + "\n";
}

function jsonl(from, to, logsPerBlock = 1) {
  let text = "";
  for (let n = from; n <= to; n += 1) text += blockLine(n, logsPerBlock);
  return text;
}

const streamOk = (text) => new Response(text, { status: 200 });
const status = (code, text = "") => new Response(code === 204 ? null : text, { status: code });

function scriptedFetch(responses, { height = 1_000_000 } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    if (String(url).endsWith("/height")) return new Response(String(height), { status: 200 });
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch call");
    return typeof next === "function" ? next() : next;
  });
  return { fetchImpl, calls };
}

const baseOpts = (fetchImpl, extra = {}) => ({
  dataset: "polygon-mainnet",
  fromBlock: 100,
  toBlock: 110,
  address: [TOKEN.toUpperCase().replace("0X", "0x")],
  topics: [TOPIC0],
  fetchImpl,
  sleep: vi.fn(async () => {}),
  apiKey: "",
  ...extra,
});

describe("mapPortalLog", () => {
  it("maps fixture lines to the same logs as the RPC fixture", () => {
    const lines = readFileSync(join(FIXTURE_DIR, "portal-polygon-logs.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const mapped = lines.flatMap((line) => (line.logs ?? []).map((log) => mapPortalLog(line, log)));
    const rpc = JSON.parse(readFileSync(join(FIXTURE_DIR, "rpc-polygon-logs.json"), "utf8"));
    const keyOf = (l) => `${l.transactionHash}:${Number.parseInt(l.logIndex, 16)}`;
    const rpcByKey = new Map(rpc.map((l) => [keyOf(l), l]));

    expect(mapped).toHaveLength(41);
    expect(new Set(mapped.map(keyOf))).toEqual(new Set(rpcByKey.keys()));
    for (const log of mapped) {
      const want = rpcByKey.get(keyOf(log));
      for (const field of ["address", "topics", "data", "transactionHash", "blockNumber", "logIndex"]) {
        expect(log[field], `${field} of ${keyOf(log)}`).toEqual(want[field]);
      }
    }
  });

  it("maps header.number to a hex blockNumber and logIndex to hex", () => {
    const line = { header: { number: 96524238, hash: HASH(1), timestamp: 1793491813 } };
    const log = { address: TOKEN, topics: [TOPIC0], data: "0x", transactionHash: HASH(2), logIndex: 402, transactionIndex: 27 };
    const out = mapPortalLog(line, log);
    expect(out.blockNumber).toBe("0x5c0d7ce");
    expect(out.logIndex).toBe("0x192");
    expect(out.transactionIndex).toBe("0x1b");
  });

  it("mapPortalLog throws when a required field is missing", () => {
    const line = { header: { number: 100, hash: HASH(1), timestamp: 1 } };
    const log = { address: TOKEN, topics: [TOPIC0], data: "0x", transactionHash: HASH(2), transactionIndex: 0 };
    expect(() => mapPortalLog(line, log)).toThrow(PortalError);
    expect(() => mapPortalLog({ header: { hash: HASH(1) } }, { ...log, logIndex: 1 })).toThrow(PortalError);
  });
});

describe("chainToDataset", () => {
  it("maps the three chains and throws on unknown", () => {
    expect(chainToDataset("ethereum")).toBe("ethereum-mainnet");
    expect(chainToDataset("polygon")).toBe("polygon-mainnet");
    expect(chainToDataset("base")).toBe("base-mainnet");
    expect(() => chainToDataset("solana")).toThrow(PortalError);
  });
});

describe("streamLogs", () => {
  it("pages by resuming from lastBlock+1 when the stream ends early", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      streamOk(jsonl(100, 105, 2)),
      streamOk(jsonl(106, 110, 2)),
    ]);
    const logs = await streamLogs(baseOpts(fetchImpl));
    expect(calls.map((c) => c.body.fromBlock)).toEqual([100, 106]);
    expect(calls[0].body.toBlock).toBe(110);
    expect(logs).toHaveLength(22);
    const numbers = logs.map((l) => Number.parseInt(l.blockNumber, 16));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it("returns empty logs on 204 when the dataset head is above toBlock", async () => {
    const { fetchImpl } = scriptedFetch([status(204)], { height: 5_000_000 });
    const logs = await streamLogs(baseOpts(fetchImpl, { fromBlock: 100, toBlock: 100 }));
    expect(logs).toEqual([]);
  });

  it("throws PortalError on 204 when toBlock is above the dataset height", async () => {
    const { fetchImpl } = scriptedFetch([status(204)], { height: 105 });
    await expect(streamLogs(baseOpts(fetchImpl))).rejects.toMatchObject({ name: "PortalError", status: 204 });
  });

  it("retries 529 then succeeds, doubling the backoff from 2s", async () => {
    const { fetchImpl, calls } = scriptedFetch([status(529), status(529), streamOk(jsonl(100, 110))]);
    const opts = baseOpts(fetchImpl, { maxAttempts: 6 });
    const logs = await streamLogs(opts);
    expect(calls).toHaveLength(3);
    expect(opts.sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
    expect(logs).toHaveLength(11);
  });

  it("retries 429 and 503 as transient failures", async () => {
    const { fetchImpl, calls } = scriptedFetch([status(429), status(503), streamOk(jsonl(100, 110))]);
    await streamLogs(baseOpts(fetchImpl));
    expect(calls).toHaveLength(3);
  });

  it("throws PortalError after maxAttempts consecutive 529s", async () => {
    const { fetchImpl, calls } = scriptedFetch([status(529), status(529), status(529)]);
    const opts = baseOpts(fetchImpl, { maxAttempts: 3 });
    const err = await streamLogs(opts).catch((e) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect(err.status).toBe(529);
    expect(err.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(opts.sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  it("resets the attempt counter after progress", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      status(529),
      streamOk(jsonl(100, 105)),
      status(529),
      streamOk(jsonl(106, 110)),
    ]);
    const logs = await streamLogs(baseOpts(fetchImpl, { maxAttempts: 2 }));
    expect(calls).toHaveLength(4);
    expect(logs).toHaveLength(11);
  });

  it("treats an empty 200 stream as a failed attempt, not as completion", async () => {
    const { fetchImpl, calls } = scriptedFetch([streamOk(""), streamOk(jsonl(100, 110))]);
    const logs = await streamLogs(baseOpts(fetchImpl));
    expect(calls.map((c) => c.body.fromBlock)).toEqual([100, 100]);
    expect(logs).toHaveLength(11);
  });

  it("drops a truncated final line and resumes from the last complete block", async () => {
    const truncated = '{"header":{"number":103,"hash":"0x';
    const { fetchImpl, calls } = scriptedFetch([
      streamOk(jsonl(100, 102) + truncated),
      streamOk(jsonl(103, 110)),
    ]);
    const logs = await streamLogs(baseOpts(fetchImpl));
    expect(calls.map((c) => c.body.fromBlock)).toEqual([100, 103]);
    expect(logs).toHaveLength(11);
  });

  it("409 throws PortalReorgError with previousBlocks", async () => {
    const previousBlocks = [{ number: 100, hash: HASH(100) }];
    const { fetchImpl } = scriptedFetch([status(409, JSON.stringify({ previousBlocks }))]);
    const err = await streamLogs(baseOpts(fetchImpl)).catch((e) => e);
    expect(err).toBeInstanceOf(PortalReorgError);
    expect(err.previousBlocks).toEqual(previousBlocks);
  });

  it("400 throws PortalError immediately without retrying", async () => {
    const { fetchImpl, calls } = scriptedFetch([status(400, "bad request body")]);
    const err = await streamLogs(baseOpts(fetchImpl)).catch((e) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("bad request body");
    expect(calls).toHaveLength(1);
  });

  it("sends lowercase addresses and topic positions, x-api-key only when a key is given", async () => {
    const { fetchImpl, calls } = scriptedFetch([streamOk(jsonl(100, 110))]);
    await streamLogs(baseOpts(fetchImpl, { apiKey: "test-key-123", address: [TOKEN.toUpperCase().replace("0X", "0x")] }));
    expect(calls[0].body.logs[0].address).toEqual([TOKEN]);
    expect(calls[0].body.logs[0].topic0).toEqual([TOPIC0]);
    expect(calls[0].body.logs[0]).not.toHaveProperty("topic1");
    expect(calls[0].headers["x-api-key"]).toBe("test-key-123");

    const second = scriptedFetch([streamOk(jsonl(100, 110))]);
    await streamLogs(baseOpts(second.fetchImpl, { apiKey: "" }));
    expect(second.calls[0].headers).not.toHaveProperty("x-api-key");
  });

  it("does not leak the api key in error messages", async () => {
    const key = "sekrit-test-key-987";
    const { fetchImpl } = scriptedFetch([status(500), status(500)]);
    const err = await streamLogs(baseOpts(fetchImpl, { apiKey: key, maxAttempts: 2 })).catch((e) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect(err.message).not.toContain(key);
    expect(JSON.stringify(err)).not.toContain(key);
  });
});

describe("streamLogs onRequest hook", () => {
  it("calls onRequest once per stream request, before fetching", async () => {
    const { fetchImpl, calls } = scriptedFetch([streamOk(jsonl(100, 105)), streamOk(jsonl(106, 110))]);
    const onRequest = vi.fn();
    await streamLogs(baseOpts(fetchImpl, { onRequest }));
    expect(onRequest).toHaveBeenCalledTimes(calls.length);
    expect(calls).toHaveLength(2);
  });

  it("propagates an error thrown by onRequest without sending the request", async () => {
    const { fetchImpl, calls } = scriptedFetch([streamOk(jsonl(100, 110))]);
    const cap = new PortalError("request cap reached");
    const err = await streamLogs(baseOpts(fetchImpl, { onRequest: () => { throw cap; } })).catch((e) => e);
    expect(err).toBe(cap);
    expect(calls).toHaveLength(0);
  });
});
