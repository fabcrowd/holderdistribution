import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildChunks, streamChunks, serializePartial, writePartial, readPartial, partialUsable, partialRaw,
} from "./partialCheckpoint.js";

// Deterministic fake chain: a few transfers per block between 6 addresses, mints from 0x0.
const ZERO = "0x0";
function logsForBlock(b) {
  const a = (i) => `0x${String(i).padStart(2, "0")}`;
  if (b % 7 === 0) return [{ from: ZERO, to: a(b % 6), value: BigInt(1000 + b) }];
  return [{ from: a(b % 6), to: a((b + 1) % 6), value: BigInt(b % 13) }, { from: a((b + 3) % 6), to: a(b % 5), value: 3n }];
}
const fetchRange = async ({ from, to }) => {
  const out = [];
  for (let b = from; b <= to; b++) out.push(...logsForBlock(b));
  return out;
};
const apply = (raw) => (logs) => {
  for (const l of logs) {
    if (l.to !== ZERO) raw.set(l.to, (raw.get(l.to) ?? 0n) + l.value);
    if (l.from !== ZERO) raw.set(l.from, (raw.get(l.from) ?? 0n) - l.value);
  }
};

async function fullRun(from, to, chunk, conc) {
  const raw = new Map();
  await streamChunks({ chunks: buildChunks(from, to, chunk), concurrency: conc, fetchChunk: fetchRange, onLogs: apply(raw) });
  return raw;
}

describe("partial checkpoint resume equivalence", () => {
  it.each([[1, 1], [3, 2], [5, 3]])("interrupt + resume == full run (failAt chunk %i, concurrency %i)", async (failAt, conc) => {
    const GEN = 100, HEAD = 400, CHUNK = 17;
    const expected = await fullRun(GEN, HEAD, CHUNK, conc);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "partial-"));
    const file = path.join(dir, "holders-partial-ethereum.json");
    const base = { chainKey: "ethereum", token: "0xAbC", genesisBlock: GEN, baseLastBlock: null };

    // Run 1: a chunk fails mid-scan; progress is saved after every whole slice.
    const raw1 = new Map();
    let applied = GEN - 1;
    let n = 0;
    await expect(streamChunks({
      chunks: buildChunks(GEN, HEAD, CHUNK),
      concurrency: conc,
      fetchChunk: async (c) => { if (n++ === failAt * conc) throw new Error("429 forever"); return fetchRange(c); },
      onLogs: apply(raw1),
      onProgress: async (last) => { applied = last; await writePartial(file, serializePartial({ ...base, lastBlock: last, raw: raw1 })); },
    })).rejects.toThrow("429");
    expect(applied).toBeLessThan(HEAD);

    // Run 2: resume from the partial on disk (round-tripped through JSON).
    const partial = await readPartial(file);
    expect(partialUsable(partial, base)).toBe(true);
    const raw2 = partialRaw(partial);
    await streamChunks({ chunks: buildChunks(partial.lastBlock + 1, HEAD, CHUNK), concurrency: conc, fetchChunk: fetchRange, onLogs: apply(raw2) });

    expect([...raw2.entries()].sort()).toEqual([...expected.entries()].sort());
  });

  it("a failing slice applies nothing from that slice", async () => {
    const raw = new Map();
    const progress = [];
    await expect(streamChunks({
      chunks: buildChunks(0, 99, 10), concurrency: 2,
      fetchChunk: async (c) => { if (c.from === 30) throw new Error("x"); return fetchRange(c); },
      onLogs: apply(raw), onProgress: async (b) => progress.push(b),
    })).rejects.toThrow();
    expect(progress).toEqual([19]);
    expect([...raw.entries()].sort()).toEqual([...(await fullRun(0, 19, 10, 2)).entries()].sort());
  });

  it("keeps negative and zero balances exactly (no dust filter)", () => {
    const p = serializePartial({ chainKey: "c", token: "0x1", genesisBlock: 0, baseLastBlock: null, lastBlock: 5, raw: new Map([["a", -5n], ["b", 0n], ["c", 10n ** 30n]]) });
    expect([...partialRaw(JSON.parse(JSON.stringify(p))).entries()]).toEqual([["a", -5n], ["b", 0n], ["c", 10n ** 30n]]);
  });

  it("rejects a partial built on a different base", () => {
    const p = serializePartial({ chainKey: "ethereum", token: "0xabc", genesisBlock: 10, baseLastBlock: null, lastBlock: 50, raw: new Map() });
    const base = { chainKey: "ethereum", token: "0xabc", genesisBlock: 10, baseLastBlock: null };
    expect(partialUsable(p, base)).toBe(true);
    expect(partialUsable(p, { ...base, baseLastBlock: 40 })).toBe(false);
    expect(partialUsable(p, { ...base, genesisBlock: 11 })).toBe(false);
    expect(partialUsable(p, { ...base, token: "0xdef" })).toBe(false);
    expect(partialUsable(p, { ...base, chainKey: "base" })).toBe(false);
  });
});
