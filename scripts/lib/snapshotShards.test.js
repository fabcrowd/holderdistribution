import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { hydrateChainHolders, serializeSnapshot } from "./snapshotFormat.js";
import {
  SHARD_ID_WIDTH,
  SNAPSHOT_LAYOUT_SHARDED,
  assembleSnapshot,
  buildShards,
  estimateSlimBytes,
  shardDirFor,
  shardProblem,
  shardTriggerBytes,
} from "./snapshotShards.js";
import { SNAPSHOT_WARN_BYTES } from "./snapshotFormat.js";

const RANGES = [0, 1, 3, 7]; // range 2, 4-6 stay empty
const BIG_BALANCE = 1234567890.12345678;

const balanceFor = (i) => {
  if (i % 7 === 0) return 1e-8;
  if (i % 11 === 0) return BIG_BALANCE;
  if (i % 5 === 0) return 100;
  return (i % 13) + 0.5;
};

const canonical = (a, b) => b.total_telcoin_balance - a.total_telcoin_balance || Number(a.address.slice(4)) - Number(b.address.slice(4));

const fixture = (count = 3000) => {
  const wallets = [];
  for (let i = 0; i < count; i += 1) {
    const balance = balanceFor(i);
    const id = RANGES[i % RANGES.length] * SHARD_ID_WIDTH + 10 + Math.floor(i / RANGES.length);
    wallets.push({ address: `0.0.${id}`, hedera_balance: balance, total_telcoin_balance: balance });
  }
  wallets.sort(canonical);
  const holders = wallets.filter((_, i) => i % 50 !== 0).map((w) => ({ address: w.address, balance: w.hedera_balance }));
  return {
    generatedAt: "2026-11-14T00:00:00.000Z",
    chains: { hedera: { key: "hedera", name: "Hedera", metrics: { holderCount: holders.length, totalBalance: 0 }, holders } },
    wallets,
    chainOrder: ["hedera"],
    asOf: { date: "2026-11-13" },
  };
};

const sha = (data) => createHash("sha256").update(data).digest("hex");
const loaderOf = (built) => {
  const map = new Map(built.shards.map((s) => [s.file, s.data]));
  return (file) => {
    if (!map.has(file)) throw new Error(`no such shard ${file}`);
    return map.get(file);
  };
};

// Replaces one shard's text and recomputes its manifest bytes/sha so only the content check can catch it.
const tamper = (built, index, edit) => {
  const head = structuredClone(built.head);
  const entry = head.walletShards.files[index];
  const data = Buffer.from(edit(built.shards[index].data.toString("utf8")));
  entry.bytes = data.length;
  entry.sha256 = sha(data);
  const base = loaderOf(built);
  return { head, load: (file) => (file === entry.file ? data : base(file)), entry };
};

describe("shardDirFor", () => {
  it("swaps the trailing .json for .d on posix and rev:path style paths", () => {
    expect(shardDirFor("public/data/hedera/tel-holders.json")).toBe("public/data/hedera/tel-holders.d");
    expect(shardDirFor("public/data/hedera/tel-holders-previous.json")).toBe("public/data/hedera/tel-holders-previous.d");
  });
});

describe("shardTriggerBytes", () => {
  const saved = process.env.HD_SNAPSHOT_SHARD_BYTES;
  afterEach(() => {
    if (saved === undefined) delete process.env.HD_SNAPSHOT_SHARD_BYTES;
    else process.env.HD_SNAPSHOT_SHARD_BYTES = saved;
  });

  it("defaults to the warn size and reads the env at call time", () => {
    delete process.env.HD_SNAPSHOT_SHARD_BYTES;
    expect(shardTriggerBytes()).toBe(SNAPSHOT_WARN_BYTES);
    process.env.HD_SNAPSHOT_SHARD_BYTES = "123";
    expect(shardTriggerBytes()).toBe(123);
    process.env.HD_SNAPSHOT_SHARD_BYTES = "nope";
    expect(shardTriggerBytes()).toBe(SNAPSHOT_WARN_BYTES);
  });
});

describe("estimateSlimBytes", () => {
  it("is within 5 percent of the real slim text", () => {
    const fx = fixture();
    const real = serializeSnapshot(fx).length;
    expect(Math.abs(estimateSlimBytes(fx) - real) / real).toBeLessThan(0.05);
  });
});

describe("shardProblem", () => {
  it("accepts the fixture", () => {
    expect(shardProblem(fixture())).toBeNull();
  });

  it("rejects two chains", () => {
    const fx = fixture();
    fx.chains.other = { key: "other" };
    expect(shardProblem(fx)).toMatch(/single-chain/);
  });

  it("rejects an extra wallet key", () => {
    const fx = fixture();
    fx.wallets[3].extra = 1;
    expect(shardProblem(fx)).toMatch(/exactly the keys/);
  });

  it("rejects an EVM style address", () => {
    const fx = fixture();
    fx.wallets[2].address = "0xabc0000000000000000000000000000000000001";
    expect(shardProblem(fx)).toMatch(/0\.0\.<n>/);
  });

  it("rejects a column that differs from the total", () => {
    const fx = fixture();
    fx.wallets[2].hedera_balance += 1;
    expect(shardProblem(fx)).toMatch(/differs/);
  });

  it("rejects a duplicate address", () => {
    const fx = fixture();
    fx.wallets[5] = { ...fx.wallets[4] };
    expect(shardProblem(fx)).toMatch(/duplicate/);
  });

  it("rejects wallets out of canonical order", () => {
    const fx = fixture();
    [fx.wallets[10], fx.wallets[11]] = [fx.wallets[11], fx.wallets[10]];
    expect(shardProblem(fx)).toMatch(/canonical order/);
  });

  it("rejects a non-finite balance", () => {
    const fx = fixture();
    fx.wallets[0].hedera_balance = NaN;
    fx.wallets[0].total_telcoin_balance = NaN;
    expect(shardProblem(fx)).toMatch(/finite/);
  });
});

describe("buildShards / assembleSnapshot", () => {
  it("builds one non-empty shard per used range with the documented format", () => {
    const built = buildShards(fixture());
    expect(built.head.layout).toBe(SNAPSHOT_LAYOUT_SHARDED);
    expect(built.shards.map((s) => s.file)).toEqual(["wallets-000.tsv", "wallets-001.tsv", "wallets-003.tsv", "wallets-007.tsv"]);
    const text = built.shards[1].data.toString("utf8");
    expect(text.startsWith("#sharded-v1 ids=[1000000,2000000) col=hedera_balance\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(built.head.walletShards).toMatchObject({ idWidth: 1000000, order: "total-desc-id-asc", column: "hedera_balance", rows: 3000 });
    expect(built.head.chains.hedera.holders).toBeUndefined();
    expect(built.head.chains.hedera.holdersOmitted.length).toBe(60);
  });

  it("round-trips: assemble + hydrate deep-equals the hydrated original, order included", () => {
    const fx = fixture();
    const built = buildShards(fx);
    const assembled = assembleSnapshot(JSON.parse(built.headText), loaderOf(built));
    expect(assembled.walletShards).toBeUndefined();
    expect(assembled.wallets).toStrictEqual(fx.wallets);
    expect(Object.keys(assembled.wallets[0])).toEqual(["address", "hedera_balance", "total_telcoin_balance"]);
    const rebuilt = hydrateChainHolders(assembled);
    expect(isDeepStrictEqual(rebuilt.chains.hedera.holders, fx.chains.hedera.holders)).toBe(true);
    expect(rebuilt.wallets.map((w) => w.address)).toEqual(fx.wallets.map((w) => w.address));
  });

  it("round-trips an empty wallets list", () => {
    const fx = fixture(0);
    fx.chains.hedera.metrics.holderCount = 0;
    const built = buildShards(fx);
    expect(built.shards).toEqual([]);
    expect(assembleSnapshot(JSON.parse(built.headText), loaderOf(built)).wallets).toEqual([]);
  });

  it("is byte stable and a changed balance changes only its shard and the head", () => {
    const fx = fixture();
    const a = buildShards(fx);
    const b = buildShards(fixture());
    expect(b.headText).toBe(a.headText);
    a.shards.forEach((s, i) => expect(s.data.equals(b.shards[i].data)).toBe(true));

    const changed = fixture();
    const target = changed.wallets.find((w) => Number(w.address.slice(4)) >= 3 * SHARD_ID_WIDTH && Number(w.address.slice(4)) < 4 * SHARD_ID_WIDTH);
    target.hedera_balance = target.total_telcoin_balance = 777.25;
    changed.wallets.sort(canonical);
    const c = buildShards(changed);
    const diff = c.shards.filter((s, i) => s.sha256 !== a.shards[i].sha256).map((s) => s.file);
    expect(diff).toEqual(["wallets-003.tsv"]);
    expect(c.headText).not.toBe(a.headText);
  });

  it("throws the shardProblem reason when not shardable", () => {
    const fx = fixture();
    fx.wallets[2].address = "0xabc";
    expect(() => buildShards(fx)).toThrow(/cannot be sharded.*0\.0\.<n>/);
  });

  it("refuses a balance that does not round-trip", () => {
    const fx = fixture(8);
    fx.wallets[0].hedera_balance = Infinity;
    fx.wallets[0].total_telcoin_balance = Infinity;
    expect(() => buildShards(fx)).toThrow();
  });
});

describe("assembleSnapshot corruption", () => {
  const built = buildShards(fixture());
  const assemble = (head, load) => () => assembleSnapshot(head, load);

  it("rejects a truncated shard by byte count", () => {
    const base = loaderOf(built);
    expect(assemble(built.head, (f) => (f === "wallets-001.tsv" ? base(f).subarray(0, 100) : base(f)))).toThrow(/wallets-001\.tsv.*bytes/);
  });

  it("rejects a flipped byte by sha256", () => {
    const base = loaderOf(built);
    const flipped = Buffer.from(base("wallets-003.tsv"));
    flipped[flipped.length - 3] ^= 1;
    expect(assemble(built.head, (f) => (f === "wallets-003.tsv" ? flipped : base(f)))).toThrow(/wallets-003\.tsv.*sha256/);
  });

  it("rejects a removed row even when size and sha are recomputed", () => {
    const { head, load } = tamper(built, 0, (t) => t.slice(0, t.lastIndexOf("\n", t.length - 2) + 1));
    expect(assemble(head, load)).toThrow(/wallets-000\.tsv.*rows/);
  });

  it("rejects a missing shard file", () => {
    const base = loaderOf(built);
    expect(assemble(built.head, (f) => (f === "wallets-007.tsv" ? base("nope") : base(f)))).toThrow(/nope/);
  });

  it("rejects two swapped shard files", () => {
    const base = loaderOf(built);
    const swap = { "wallets-000.tsv": "wallets-001.tsv", "wallets-001.tsv": "wallets-000.tsv" };
    expect(assemble(built.head, (f) => base(swap[f] ?? f))).toThrow(/wallets-000\.tsv/);
  });

  it("rejects a row outside its range", () => {
    const { head, load } = tamper(built, 1, (t) => `${t}${2 * SHARD_ID_WIDTH + 5}\t1\n`);
    expect(assemble(head, load)).toThrow(/wallets-001\.tsv.*outside/);
  });

  it("rejects rows out of order", () => {
    const { head, load } = tamper(built, 2, (t) => {
      const [header, r1, r2, ...rest] = t.split("\n");
      return [header, r2, r1, ...rest].join("\n");
    });
    expect(assemble(head, load)).toThrow(/wallets-003\.tsv.*ascending/);
  });

  it("rejects a wrong header range", () => {
    const { head, load } = tamper(built, 0, (t) => t.replace("ids=[0,1000000)", "ids=[0,2000000)"));
    expect(assemble(head, load)).toThrow(/wallets-000\.tsv.*header/);
  });

  it("rejects a manifest total that does not match", () => {
    const head = structuredClone(built.head);
    head.walletShards.rows += 1;
    expect(assemble(head, loaderOf(built))).toThrow(/manifest says/);
  });

  it("rejects a manifest file name that could escape the directory", () => {
    const head = structuredClone(built.head);
    head.walletShards.files[0].file = "../evil.tsv";
    expect(assemble(head, loaderOf(built))).toThrow(/evil/);
  });
});
