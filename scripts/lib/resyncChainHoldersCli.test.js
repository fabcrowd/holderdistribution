import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hydrateChainHolders, resyncSnapshot, serializeSnapshot, serializeVerified } from "./snapshotFormat.js";
import { readSnapshot, writeSnapshotFiles } from "./snapshotIo.js";

// Runs the real scripts/resync-chain-holders.js against a temp root: the CLI resolves config and data from
// process.cwd(), and the pure-function tests cannot see how the CLI writes the file back.
const repo = path.resolve(import.meta.dirname, "..", "..");
const cli = path.join(repo, "scripts", "resync-chain-holders.js");

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const D = "0x" + "d".repeat(40);
const E = "0x" + "e".repeat(40);

const write = (root, rel, value) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

const chainEntry = (key, holders) => ({
  key,
  name: key,
  metrics: { holderCount: holders.length, totalBalance: 0, excluded: { count: 1, balance: 9000 } },
  holders,
});

const singleChainSnapshot = () => ({
  generatedAt: "2026-11-14T00:00:00.000Z",
  chains: {
    ethereum: chainEntry("ethereum", [
      { address: A, balance: 5000 },
      { address: B, balance: 2000 },
      { address: C, balance: 10 },
    ]),
  },
  combined: { holderCount: 3 },
  wallets: [
    { address: D, ethereum_balance: 9000, total_telcoin_balance: 9000 },
    { address: A, ethereum_balance: 5000, total_telcoin_balance: 5000 },
    { address: B, ethereum_balance: 2000, total_telcoin_balance: 2000 },
    { address: C, ethereum_balance: 10, total_telcoin_balance: 10 },
  ],
  chainOrder: ["ethereum"],
  source: { type: "rpc" },
});

const twoChainSnapshot = () => ({
  generatedAt: "2026-11-14T00:00:00.000Z",
  chains: {
    ethereum: chainEntry("ethereum", [{ address: A, balance: 5000 }, { address: B, balance: 20 }]),
    polygon: chainEntry("polygon", [{ address: A, balance: 700 }]),
  },
  combined: {},
  wallets: [
    { address: A, ethereum_balance: 5000, polygon_balance: 700, total_telcoin_balance: 5700 },
    { address: B, ethereum_balance: 20, polygon_balance: 0, total_telcoin_balance: 20 },
  ],
  chainOrder: ["ethereum", "polygon"],
  source: { type: "rpc" },
});

const projectConfig = (slug, chains, extra) => ({
  slug,
  name: slug,
  ticker: slug.toUpperCase(),
  chains: chains.map((key) => ({ key })),
  holders: { retailThreshold: 1000 },
  ...extra,
});

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-resync-cli-"));
  write(root, "config/projects.json", { projects: [{ slug: "tel", default: true, legacyRoot: true }, { slug: "solo" }] });
  // solo: single chain, own classification files, feeds in public/data/solo/
  write(root, "config/projects/solo.json", projectConfig("solo", ["ethereum"], {
    data: { legacyRoot: false, dir: "public/data/solo" },
    classification: { exclusions: "config/projects/solo/exclusions.json", cexWallets: "config/projects/solo/cex-wallets.json" },
  }));
  write(root, "config/projects/solo/exclusions.json", { addresses: [D] });
  write(root, "config/projects/solo/cex-wallets.json", { wallets: [] });
  // tel: two chains, legacy root classification files
  write(root, "config/projects/tel.json", projectConfig("tel", ["ethereum", "polygon"], {
    data: { legacyRoot: true, dir: "public/data" },
    classification: { exclusions: "config/exclusions.json", cexWallets: "config/cex-wallets.json", dexContracts: "config/dex-contracts.json" },
  }));
  write(root, "config/exclusions.json", { addresses: [] });
  write(root, "config/cex-wallets.json", { wallets: [] });
  write(root, "config/dex-contracts.json", { pools: [], routers: [] });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const run = (slug, args = []) =>
  execFileSync(process.execPath, [cli, "--project", slug, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const soloFile = () => path.join(root, "public/data/solo/tel-holders.json");
const readSolo = () => fs.readFileSync(soloFile(), "utf8");

// A slim file whose metrics already agree with its holders, so an unchanged resync cannot move a byte.
const seedSlim = () => {
  const settled = serializeVerified(singleChainSnapshot(), "seed");
  write(root, "public/data/solo/tel-holders.json", settled);
  write(root, "public/data/solo/holders-summary.json", {});
  run("solo");
  return readSolo();
};

describe("resync-chain-holders CLI", () => {
  it("leaves a slim single-chain file byte-identical when exclusions are unchanged", () => {
    const slim = seedSlim();
    const parsed = JSON.parse(slim);
    expect(parsed.layout).toBe("slim-v1");
    expect(parsed.chains.ethereum.holders).toBeUndefined();
    expect(parsed.chains.ethereum.holdersOmitted).toEqual([D]);
    run("solo");
    expect(readSolo()).toBe(slim);
  });

  it("keeps the file slim and records a newly excluded address", () => {
    seedSlim();
    write(root, "config/projects/solo/exclusions.json", { addresses: [D, B] });
    const out = run("solo");
    expect(out).toMatch(/removed 1/);
    const parsed = JSON.parse(readSolo());
    expect(parsed.layout).toBe("slim-v1");
    expect(parsed.chains.ethereum.holders).toBeUndefined();
    expect(parsed.chains.ethereum.holdersOmitted).toContain(B);
    const hydrated = hydrateChainHolders(parsed);
    expect(hydrated.chains.ethereum.holders.map((h) => h.address)).toEqual([A, C]);
    expect(parsed.chains.ethereum.metrics.holderCount).toBe(hydrated.chains.ethereum.holders.length);
  });

  it("writes a two-chain snapshot in the legacy layout", () => {
    write(root, "public/data/tel-holders.json", `${JSON.stringify(twoChainSnapshot(), null, 2)}\n`);
    write(root, "public/data/holders-summary.json", {});
    run("tel");
    const text = fs.readFileSync(path.join(root, "public/data/tel-holders.json"), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.layout).toBeUndefined();
    expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(text).toBe(serializeSnapshot(parsed));
  });

  describe("hedera-shaped single chain forced to shards", () => {
    const SHARD_ENV = { HD_SNAPSHOT_SHARD_BYTES: "1" };
    const hbarDir = () => path.join(root, "public/data/hbar");
    const hbarHead = () => path.join(hbarDir(), "tel-holders.json");
    const hbarShardDir = () => path.join(hbarDir(), "tel-holders.d");
    const runHbar = (args = []) =>
      execFileSync(process.execPath, [cli, "--project", "hbar", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...SHARD_ENV },
      });
    const dirBytes = () => {
      const files = { head: fs.readFileSync(hbarHead(), "utf8") };
      for (const name of fs.readdirSync(hbarShardDir()).sort()) files[name] = fs.readFileSync(path.join(hbarShardDir(), name), "utf8");
      return files;
    };

    // Account numbers span two shard ranges; wallets are in canonical order (total desc, id asc).
    const hbarSnapshot = () => {
      const wallets = [
        { address: "0.0.9", hedera_balance: 9000, total_telcoin_balance: 9000 },
        { address: "0.0.1000002", hedera_balance: 5000, total_telcoin_balance: 5000 },
        { address: "0.0.20", hedera_balance: 2000, total_telcoin_balance: 2000 },
        { address: "0.0.1000001", hedera_balance: 2000, total_telcoin_balance: 2000 },
        { address: "0.0.1000003", hedera_balance: 10, total_telcoin_balance: 10 },
      ];
      const holders = wallets.filter((w) => w.address !== "0.0.20").map((w) => ({ address: w.address, balance: w.hedera_balance }));
      return {
        generatedAt: "2026-11-14T00:00:00.000Z",
        chains: { hedera: chainEntry("hedera", holders) },
        combined: { holderCount: holders.length },
        wallets,
        chainOrder: ["hedera"],
        source: { type: "rpc" },
      };
    };

    const seedSharded = async () => {
      write(root, "config/projects.json", { projects: [{ slug: "tel", default: true, legacyRoot: true }, { slug: "hbar" }] });
      write(root, "config/projects/hbar.json", projectConfig("hbar", ["hedera"], {
        data: { legacyRoot: false, dir: "public/data/hbar" },
        classification: { exclusions: "config/projects/hbar/exclusions.json", cexWallets: "config/projects/hbar/cex-wallets.json" },
      }));
      write(root, "config/projects/hbar/exclusions.json", { addresses: ["0.0.9"] });
      write(root, "config/projects/hbar/cex-wallets.json", { wallets: [] });
      write(root, "public/data/hbar/holders-summary.json", {});
      const saved = process.env.HD_SNAPSHOT_SHARD_BYTES;
      process.env.HD_SNAPSHOT_SHARD_BYTES = "1";
      try {
        await writeSnapshotFiles(hbarHead(), hbarSnapshot(), { log: { log: () => {}, warn: () => {} } });
      } finally {
        if (saved === undefined) delete process.env.HD_SNAPSHOT_SHARD_BYTES;
        else process.env.HD_SNAPSHOT_SHARD_BYTES = saved;
      }
    };

    it("rewrites head and shards, is byte-stable on a second run, and matches the expected resync", async () => {
      await seedSharded();
      expect(JSON.parse(fs.readFileSync(hbarHead(), "utf8")).layout).toBe("sharded-v1");
      write(root, "config/projects/hbar/exclusions.json", { addresses: ["0.0.9", "0.0.1000001"] });

      runHbar();
      const first = dirBytes();
      expect(JSON.parse(first.head).layout).toBe("sharded-v1");
      expect(Object.keys(first).sort()).toEqual(["head", "wallets-000.tsv", "wallets-001.tsv"]);

      runHbar();
      expect(dirBytes()).toEqual(first);

      const expected = resyncSnapshot(hydrateChainHolders(hbarSnapshot()), new Set(["0.0.9", "0.0.1000001"]), 1000).snapshot;
      const actual = hydrateChainHolders(await readSnapshot(hbarHead()));
      expect(actual.wallets).toEqual(expected.wallets);
      expect(actual.chains.hedera.holders).toEqual(expected.chains.hedera.holders);
      expect(actual.chains.hedera.metrics).toEqual(expected.chains.hedera.metrics);
      expect(actual.combined).toEqual(expected.combined);
    });

    it("writes nothing with --dry-run", async () => {
      await seedSharded();
      write(root, "config/projects/hbar/exclusions.json", { addresses: ["0.0.9", "0.0.1000001"] });
      const before = dirBytes();
      expect(runHbar(["--dry-run"])).toMatch(/nothing written/);
      expect(dirBytes()).toEqual(before);
    });
  });

  it("does not touch the file with --dry-run", () => {
    const slim = seedSlim();
    write(root, "config/projects/solo/exclusions.json", { addresses: [D, B] });
    const out = run("solo", ["--dry-run"]);
    expect(out).toMatch(/nothing written/);
    expect(readSolo()).toBe(slim);
  });
});
