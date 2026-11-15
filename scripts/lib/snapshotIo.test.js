import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SNAPSHOT_FAIL_BYTES, hydrateChainHolders, serializeSnapshot, serializeVerified } from "./snapshotFormat.js";
import {
  copySnapshotFiles,
  publishSnapshot,
  readSnapshot,
  readSnapshotAtRev,
  readSnapshotHead,
  readSnapshotHeadSync,
  readSnapshotSync,
  removeSnapshotFiles,
  writeSnapshotFiles,
} from "./snapshotIo.js";
import { SHARD_ID_WIDTH, shardDirFor } from "./snapshotShards.js";

const ENV = "HD_SNAPSHOT_SHARD_BYTES";
const RANGES = [0, 1, 3, 7];

const canonical = (a, b) => b.total_telcoin_balance - a.total_telcoin_balance || Number(a.address.slice(4)) - Number(b.address.slice(4));

const fixture = ({ count = 400, ranges = RANGES, evm = false } = {}) => {
  const wallets = [];
  for (let i = 0; i < count; i += 1) {
    const balance = i % 7 === 0 ? 1e-8 : i % 11 === 0 ? 1234567890.12345678 : (i % 5) + 0.5;
    const id = ranges[i % ranges.length] * SHARD_ID_WIDTH + 10 + Math.floor(i / ranges.length);
    const address = evm ? `0x${id.toString(16).padStart(40, "0")}` : `0.0.${id}`;
    wallets.push({ address, hedera_balance: balance, total_telcoin_balance: balance });
  }
  wallets.sort(evm ? (a, b) => b.total_telcoin_balance - a.total_telcoin_balance : canonical);
  const holders = wallets.filter((_, i) => i % 40 !== 0).map((w) => ({ address: w.address, balance: w.hedera_balance }));
  return {
    generatedAt: "2026-11-14T00:00:00.000Z",
    chains: { hedera: { key: "hedera", metrics: { holderCount: holders.length }, holders } },
    wallets,
    chainOrder: ["hedera"],
  };
};

const twoChain = () => ({
  chains: { a: { key: "a", holders: [{ address: "x", balance: 1 }] }, b: { key: "b", holders: [{ address: "x", balance: 2 }] } },
  wallets: [{ address: "x", a_balance: 1, b_balance: 2, total_telcoin_balance: 3 }],
});

const quiet = () => {
  const lines = [];
  return { lines, log: { warn: (m) => lines.push(`warn ${m}`), log: (m) => lines.push(m) } };
};

let dir;
let savedEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "snapshot-io-"));
  savedEnv = process.env[ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

const sameSnapshot = (readBack, original) => {
  expect(readBack.wallets).toStrictEqual(original.wallets);
  expect(hydrateChainHolders(readBack).chains.hedera.holders).toStrictEqual(original.chains.hedera.holders);
};

describe("writeSnapshotFiles", () => {
  it("writes legacy and small slim snapshots byte-identical to serializeVerified, with no shard dir", async () => {
    process.env[ENV] = "1";
    const legacy = join(dir, "legacy.json");
    const slim = join(dir, "slim.json");
    const w = quiet();
    await writeSnapshotFiles(legacy, twoChain(), { log: w.log });
    expect(readFileSync(legacy, "utf8")).toBe(serializeVerified(twoChain(), legacy, w.log));
    expect(existsSync(shardDirFor(legacy))).toBe(false);

    delete process.env[ENV];
    const small = fixture({ count: 20 });
    const result = await writeSnapshotFiles(slim, small, { log: w.log });
    expect(readFileSync(slim, "utf8")).toBe(serializeVerified(small, slim, w.log));
    expect(existsSync(shardDirFor(slim))).toBe(false);
    expect(result).toMatchObject({ layout: "slim-v1", files: 1 });
  });

  it("writes a shardable snapshot sharded when the trigger is forced and reads it back", async () => {
    process.env[ENV] = "1";
    const file = join(dir, "tel-holders.json");
    const fx = fixture();
    const w = quiet();
    const result = await writeSnapshotFiles(file, fx, { log: w.log });
    expect(result).toMatchObject({ layout: "sharded-v1", files: 5 });
    expect(JSON.parse(readFileSync(file, "utf8")).layout).toBe("sharded-v1");
    expect(readdirSync(shardDirFor(file)).sort()).toEqual(["wallets-000.tsv", "wallets-001.tsv", "wallets-003.tsv", "wallets-007.tsv"]);
    expect(existsSync(`${shardDirFor(file)}.tmp`)).toBe(false);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    sameSnapshot(readSnapshotSync(file), fx);
    sameSnapshot(await readSnapshot(file), fx);
    expect(w.lines.some((l) => /sharded-v1/.test(l))).toBe(true);
  });

  it("falls back to the slim single file when forced but not shardable", async () => {
    process.env[ENV] = "1";
    const file = join(dir, "evm.json");
    const fx = fixture({ evm: true });
    const w = quiet();
    await writeSnapshotFiles(file, fx, { log: w.log });
    expect(readFileSync(file, "utf8")).toBe(serializeVerified(fx, file, w.log));
    expect(existsSync(shardDirFor(file))).toBe(false);
    expect(w.lines.some((l) => l.startsWith("warn") && /0\.0\.<n>/.test(l))).toBe(true);
  });

  it("removes the shard dir when a path goes back to a single file", async () => {
    const file = join(dir, "tel-holders.json");
    process.env[ENV] = "1";
    await writeSnapshotFiles(file, fixture(), { log: quiet().log });
    expect(existsSync(shardDirFor(file))).toBe(true);
    delete process.env[ENV];
    const small = fixture({ count: 20 });
    await writeSnapshotFiles(file, small, { log: quiet().log });
    expect(existsSync(shardDirFor(file))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(serializeSnapshot(small));
  });

  it("leaves no stale shard file when rewritten with fewer ranges", async () => {
    const file = join(dir, "tel-holders.json");
    process.env[ENV] = "1";
    await writeSnapshotFiles(file, fixture(), { log: quiet().log });
    const fewer = fixture({ ranges: [0, 1] });
    await writeSnapshotFiles(file, fewer, { log: quiet().log });
    expect(readdirSync(shardDirFor(file)).sort()).toEqual(["wallets-000.tsv", "wallets-001.tsv"]);
    sameSnapshot(readSnapshotSync(file), fewer);
  });

  it("rejects a crash between shards and head (old head, new shards)", async () => {
    const file = join(dir, "tel-holders.json");
    process.env[ENV] = "1";
    await writeSnapshotFiles(file, fixture(), { log: quiet().log });
    const oldHead = readFileSync(file, "utf8");
    const changed = fixture();
    changed.wallets[0].hedera_balance = changed.wallets[0].total_telcoin_balance = 9e9;
    await writeSnapshotFiles(file, changed, { log: quiet().log });
    writeFileSync(file, oldHead);
    expect(() => readSnapshotSync(file)).toThrow(/Shard wallets-\d{3}\.tsv/);
  });
});

describe("readSnapshot", () => {
  it("equals a bare JSON.parse for legacy and slim single files (not hydrated)", async () => {
    const legacy = join(dir, "legacy.json");
    const slim = join(dir, "slim.json");
    writeFileSync(legacy, serializeSnapshot(twoChain()));
    writeFileSync(slim, serializeSnapshot(fixture({ count: 30 })));
    for (const file of [legacy, slim]) {
      expect(readSnapshotSync(file)).toStrictEqual(JSON.parse(readFileSync(file, "utf8")));
      expect(await readSnapshot(file)).toStrictEqual(JSON.parse(readFileSync(file, "utf8")));
    }
    expect(readSnapshotSync(slim).chains.hedera.holders).toBeUndefined();
  });

  it("throws ENOENT for a missing head and names a missing shard", async () => {
    expect(() => readSnapshotSync(join(dir, "none.json"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
    await expect(readSnapshot(join(dir, "none.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const file = join(dir, "tel-holders.json");
    process.env[ENV] = "1";
    await writeSnapshotFiles(file, fixture(), { log: quiet().log });
    rmSync(join(shardDirFor(file), "wallets-003.tsv"));
    expect(() => readSnapshotSync(file)).toThrow(/wallets-003\.tsv.*missing/);
  });
});

describe("copySnapshotFiles / removeSnapshotFiles", () => {
  it("copies a sharded snapshot so the destination reads the same", async () => {
    process.env[ENV] = "1";
    const src = join(dir, "tel-holders.json");
    const dest = join(dir, "tel-holders-previous.json");
    const fx = fixture();
    await writeSnapshotFiles(src, fx, { log: quiet().log });
    mkdirSync(shardDirFor(dest), { recursive: true });
    writeFileSync(join(shardDirFor(dest), "wallets-099.tsv"), "stale");
    await copySnapshotFiles(src, dest);
    expect(existsSync(join(shardDirFor(dest), "wallets-099.tsv"))).toBe(false);
    sameSnapshot(readSnapshotSync(dest), fx);
  });

  it("removes a stale destination shard dir when the source is a single file", async () => {
    const src = join(dir, "a.json");
    const dest = join(dir, "b.json");
    writeFileSync(src, serializeSnapshot(twoChain()));
    mkdirSync(shardDirFor(dest), { recursive: true });
    await copySnapshotFiles(src, dest);
    expect(existsSync(shardDirFor(dest))).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(src, "utf8"));
  });

  it("removes head and shard dir, ignoring what is absent", async () => {
    const file = join(dir, "tel-holders.json");
    process.env[ENV] = "1";
    await writeSnapshotFiles(file, fixture(), { log: quiet().log });
    await removeSnapshotFiles(file);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(shardDirFor(file))).toBe(false);
    await expect(removeSnapshotFiles(file)).resolves.toBeUndefined();
  });
});

describe("readSnapshotHead", () => {
  it("returns single-file layouts whole and a sharded head without rows, marked", async () => {
    const legacy = join(dir, "legacy.json");
    writeFileSync(legacy, serializeSnapshot(twoChain()));
    expect(readSnapshotHeadSync(legacy)).toStrictEqual(JSON.parse(readFileSync(legacy, "utf8")));
    expect(await readSnapshotHead(legacy)).toStrictEqual(JSON.parse(readFileSync(legacy, "utf8")));

    const file = join(dir, "tel-holders.json");
    process.env[ENV] = "1";
    const fx = fixture();
    fx.asOf = { date: "2026-11-13" };
    await writeSnapshotFiles(file, fx, { log: quiet().log });
    for (const head of [readSnapshotHeadSync(file), await readSnapshotHead(file)]) {
      expect(head.rowsLoaded).toBe(false);
      expect(head.wallets).toBeUndefined();
      expect(head.asOf).toEqual({ date: "2026-11-13" });
    }
    rmSync(shardDirFor(file), { recursive: true });
    expect(readSnapshotHeadSync(file).rowsLoaded).toBe(false);
  });
});

describe("publishSnapshot", () => {
  const snapshotFiles = (file) => {
    const files = { head: existsSync(file) ? readFileSync(file, "utf8") : null };
    const d = shardDirFor(file);
    if (existsSync(d)) for (const name of readdirSync(d).sort()) files[name] = readFileSync(join(d, name), "utf8");
    return files;
  };
  const strays = () => readdirSync(dir).filter((name) => /stage|\.tmp/.test(name));
  const changed = (count = 400, ranges = RANGES) => {
    const fx = fixture({ count, ranges });
    fx.wallets[0].hedera_balance = fx.wallets[0].total_telcoin_balance = 9e9;
    return fx;
  };

  it("rotates the old sharded files to previous before the new write", async () => {
    const file = join(dir, "tel-holders.json");
    const previous = join(dir, "tel-holders-previous.json");
    process.env[ENV] = "1";
    const first = fixture();
    await writeSnapshotFiles(file, first, { log: quiet().log });
    const before = snapshotFiles(file);
    const second = changed();
    const result = await publishSnapshot({ file, previousFile: previous, snapshot: second, rotate: true, log: quiet().log });
    expect(result.rotated).toBe(true);
    expect(snapshotFiles(previous)).toEqual(Object.fromEntries(Object.entries(before)));
    sameSnapshot(readSnapshotSync(previous), first);
    sameSnapshot(readSnapshotSync(file), second);
    expect(strays()).toEqual([]);
  });

  it("does not touch previous when the guard says no", async () => {
    const file = join(dir, "tel-holders.json");
    const previous = join(dir, "tel-holders-previous.json");
    process.env[ENV] = "1";
    await writeSnapshotFiles(file, fixture(), { log: quiet().log });
    writeFileSync(previous, "older");
    const second = changed();
    const result = await publishSnapshot({ file, previousFile: previous, snapshot: second, rotate: false, log: quiet().log });
    expect(result.rotated).toBe(false);
    expect(readFileSync(previous, "utf8")).toBe("older");
    sameSnapshot(readSnapshotSync(file), second);
    expect(strays()).toEqual([]);
  });

  it("keeps a legacy prior in the legacy layout in previous", async () => {
    const file = join(dir, "tel-holders.json");
    const previous = join(dir, "tel-holders-previous.json");
    await writeSnapshotFiles(file, twoChain(), { log: quiet().log });
    const bytes = readFileSync(file, "utf8");
    await publishSnapshot({ file, previousFile: previous, snapshot: fixture({ count: 20 }), rotate: true, log: quiet().log });
    expect(readFileSync(previous, "utf8")).toBe(bytes);
    expect(existsSync(shardDirFor(previous))).toBe(false);
  });

  it("leaves current and previous exactly as they were when the write is refused", async () => {
    const file = join(dir, "tel-holders.json");
    const previous = join(dir, "tel-holders-previous.json");
    process.env[ENV] = "1";
    await writeSnapshotFiles(file, fixture(), { log: quiet().log });
    await writeSnapshotFiles(previous, changed(), { log: quiet().log });
    const currentBefore = snapshotFiles(file);
    const previousBefore = snapshotFiles(previous);

    // Round-trip failure: a holder that is not in wallets[].
    const bad = fixture();
    bad.chains.hedera.holders[0] = { address: bad.chains.hedera.holders[0].address, balance: 123456789 };
    await expect(publishSnapshot({ file, previousFile: previous, snapshot: bad, rotate: true, log: quiet().log })).rejects.toThrow(/round trip/);
    expect(snapshotFiles(file)).toEqual(currentBefore);
    expect(snapshotFiles(previous)).toEqual(previousBefore);
    expect(strays()).toEqual([]);

    // Size-gate failure on the single-file path.
    delete process.env[ENV];
    const huge = fixture({ count: 20 });
    huge.padding = "x".repeat(SNAPSHOT_FAIL_BYTES + 1);
    await expect(publishSnapshot({ file, previousFile: previous, snapshot: huge, rotate: true, log: quiet().log })).rejects.toThrow();
    expect(snapshotFiles(file)).toEqual(currentBefore);
    expect(snapshotFiles(previous)).toEqual(previousBefore);
    expect(strays()).toEqual([]);
  });

  it("leaves no stale shard directory or shard file across layout transitions", async () => {
    const file = join(dir, "tel-holders.json");
    const previous = join(dir, "tel-holders-previous.json");
    const publish = (snapshot, force) => {
      if (force) process.env[ENV] = "1";
      else delete process.env[ENV];
      return publishSnapshot({ file, previousFile: previous, snapshot, rotate: true, log: quiet().log });
    };

    await writeSnapshotFiles(file, fixture({ count: 20 }), { log: quiet().log }); // slim single file
    await publish(fixture(), true); // slim -> sharded; previous is the slim single file
    expect(existsSync(shardDirFor(previous))).toBe(false);
    expect(existsSync(shardDirFor(file))).toBe(true);

    await publish(fixture({ ranges: [0, 1] }), true); // sharded -> sharded, fewer shards
    expect(readdirSync(shardDirFor(file)).sort()).toEqual(["wallets-000.tsv", "wallets-001.tsv"]);
    expect(readdirSync(shardDirFor(previous)).sort()).toEqual(["wallets-000.tsv", "wallets-001.tsv", "wallets-003.tsv", "wallets-007.tsv"]);

    const slim = fixture({ count: 20 });
    await publish(slim, false); // sharded -> slim
    expect(existsSync(shardDirFor(file))).toBe(false);
    expect(readdirSync(shardDirFor(previous)).sort()).toEqual(["wallets-000.tsv", "wallets-001.tsv"]);
    expect(readFileSync(file, "utf8")).toBe(serializeSnapshot(slim));

    await publish(slim, false); // previous was sharded, now rotated from a single file: its shard dir goes
    expect(existsSync(shardDirFor(previous))).toBe(false);
    expect(strays()).toEqual([]);
  });
});

describe("readSnapshotAtRev", () => {
  it("reads sharded and single-file revisions from git", async () => {
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    const rel = "data/tel-holders.json";
    const file = join(dir, rel);
    process.env[ENV] = "1";
    const first = fixture();
    await writeSnapshotFiles(file, first, { log: quiet().log });
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "one");

    const second = fixture();
    second.wallets[0].hedera_balance = second.wallets[0].total_telcoin_balance = 9e9;
    await writeSnapshotFiles(file, second, { log: quiet().log });
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "two");

    delete process.env[ENV];
    const small = fixture({ count: 20 });
    await writeSnapshotFiles(file, small, { log: quiet().log });
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "three");

    sameSnapshot(readSnapshotAtRev("HEAD~2", rel, { cwd: dir }), first);
    sameSnapshot(readSnapshotAtRev("HEAD~1", rel, { cwd: dir }), second);
    expect(readSnapshotAtRev("HEAD", rel, { cwd: dir })).toStrictEqual(JSON.parse(serializeSnapshot(small)));
    expect(() => readSnapshotAtRev("HEAD~9", rel, { cwd: dir })).toThrow();
  });
});
