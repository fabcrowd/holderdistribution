import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TRANSFER_TOPIC0,
  readWindow,
  sliceWindow,
  windowConfigHash,
  writeWindow,
} from "./transferWindow.js";

const TOKEN_A = "0x00000000000000000000000000000000000000aa";
const TOKEN_B = "0x00000000000000000000000000000000000000bb";
const CHAIN = 1;

const log = (block, index, extra = {}) => ({
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${index.toString(16)}`,
  transactionHash: `0x${(block * 16 + index).toString(16)}`,
  address: TOKEN_A,
  topics: [TRANSFER_TOPIC0],
  data: "0x0",
  ...extra,
});

const blocksOf = (logs) => logs.map((l) => parseInt(l.blockNumber, 16));

describe("transferWindow", () => {
  let dir;
  let file;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tw-"));
    file = path.join(dir, "window.ndjson");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeSample = (logs = [log(100, 0), log(150, 0), log(200, 0)], extra = {}) =>
    writeWindow(file, {
      chain: CHAIN,
      tokens: [TOKEN_A],
      fromBlock: 100,
      toBlock: 200,
      logs,
      ...extra,
    });

  it("serves a fully covered range from the stored logs", async () => {
    await writeSample();
    const window = await readWindow(file);
    const sliced = sliceWindow(window, 120, 200, window.meta.configHash);
    expect(blocksOf(sliced)).toEqual([150, 200]);
  });

  it("returns null when the range starts before or ends after the window", async () => {
    await writeSample();
    const window = await readWindow(file);
    expect(sliceWindow(window, 90, 150)).toBeNull();
    expect(sliceWindow(window, 150, 210)).toBeNull();
  });

  it("returns null on a config hash mismatch and logs on a match", async () => {
    await writeSample();
    const window = await readWindow(file);
    expect(sliceWindow(window, 100, 200, windowConfigHash(CHAIN, [TOKEN_B]))).toBeNull();
    expect(sliceWindow(window, 100, 200, windowConfigHash(CHAIN, [TOKEN_A]))).toHaveLength(3);
  });

  it("round-trips an empty window and serves a covered range as []", async () => {
    await writeSample([]);
    expect(await readFile(file, "utf8")).toBe("");
    const window = await readWindow(file);
    expect(window.meta.count).toBe(0);
    expect(window.logs).toEqual([]);
    expect(sliceWindow(window, 110, 120)).toEqual([]);
  });

  it("includes logs exactly at the slice and window boundaries", async () => {
    await writeSample([log(100, 0), log(200, 0), log(150, 0)]);
    const window = await readWindow(file);
    expect(blocksOf(sliceWindow(window, 100, 200))).toEqual([100, 150, 200]);
    expect(blocksOf(sliceWindow(window, 100, 100))).toEqual([100]);
    expect(blocksOf(sliceWindow(window, 200, 200))).toEqual([200]);
  });

  it("round-trips logs, sorts a copy by block and log index, and leaves the input alone", async () => {
    const noIndex = { blockNumber: "0x64", transactionHash: "0xcc", address: TOKEN_A, topics: [], data: "0x" };
    const input = [log(150, 0), log(100, 2), log(100, 1), noIndex, log(120, 0)];
    const snapshot = JSON.parse(JSON.stringify(input));

    const meta = await writeSample(input, { tokens: [TOKEN_B, TOKEN_A] });

    expect(input).toEqual(snapshot);
    const window = await readWindow(file);
    expect(window.logs).toEqual([noIndex, log(100, 1), log(100, 2), log(120, 0), log(150, 0)]);
    expect(meta).toEqual({
      version: 1,
      chain: CHAIN,
      tokens: [TOKEN_A, TOKEN_B],
      topics: [TRANSFER_TOPIC0],
      fromBlock: 100,
      toBlock: 200,
      count: 5,
      configHash: windowConfigHash(CHAIN, [TOKEN_B, TOKEN_A]),
    });
    expect(window.meta).toEqual(meta);
    expect((await readdir(dir)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("rejects non-integer or inverted block ranges", async () => {
    await expect(writeSample([], { fromBlock: 2.5 })).rejects.toThrow();
    await expect(writeSample([], { fromBlock: 201, toBlock: 200 })).rejects.toThrow();
  });

  it("returns null when files are missing", async () => {
    expect(await readWindow(file)).toBeNull();
    await writeSample();
    await unlink(`${file}.meta.json`);
    expect(await readWindow(file)).toBeNull();
  });

  it("returns null when meta is corrupt, has the wrong version, or mismatches the count", async () => {
    await writeSample();
    const metaPath = `${file}.meta.json`;
    const meta = JSON.parse(await readFile(metaPath, "utf8"));

    await writeFile(metaPath, "{not json", "utf8");
    expect(await readWindow(file)).toBeNull();

    await writeFile(metaPath, JSON.stringify({ ...meta, version: 2 }), "utf8");
    expect(await readWindow(file)).toBeNull();

    await writeFile(metaPath, JSON.stringify({ ...meta, count: meta.count + 1 }), "utf8");
    expect(await readWindow(file)).toBeNull();
  });

  it("returns null when a log line is unparseable", async () => {
    await writeSample();
    const text = await readFile(file, "utf8");
    await writeFile(file, `${text}{broken\n`, "utf8");
    expect(await readWindow(file)).toBeNull();
  });

  it("hashes ignore token order and case but change with chain, token or topics", () => {
    const base = windowConfigHash(CHAIN, [TOKEN_A, TOKEN_B]);
    expect(windowConfigHash(CHAIN, [TOKEN_B, TOKEN_A])).toBe(base);
    expect(windowConfigHash(CHAIN, [TOKEN_B.toUpperCase(), TOKEN_A])).toBe(base);
    expect(windowConfigHash(CHAIN, TOKEN_A)).toBe(windowConfigHash(CHAIN, [TOKEN_A]));
    expect(windowConfigHash(137, [TOKEN_A, TOKEN_B])).not.toBe(base);
    expect(windowConfigHash(CHAIN, [TOKEN_A])).not.toBe(base);
    expect(windowConfigHash(CHAIN, [TOKEN_A, TOKEN_B], ["0x1234"])).not.toBe(base);
  });
});
