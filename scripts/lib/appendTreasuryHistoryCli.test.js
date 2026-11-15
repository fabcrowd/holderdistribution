import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeSnapshotFiles } from "./snapshotIo.js";

// append-treasury-history.js resolves its root from its own file location, so the test runs a copy of scripts/
// (tests left out) inside a temp root. Only an absent previous snapshot may skip the vanished-wallet guard; a
// sharded previous snapshot with a missing or tampered shard must fail the run and write nothing.
const repo = path.resolve(import.meta.dirname, "..", "..");
const SLUG = "hbar";
const DATA_REL = `public/data/${SLUG}`;
const QUIET = { log: () => {}, warn: () => {} };
const EMPTY_HISTORY = { entries: [] };

const writeJson = (root, rel, value) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const snapshotOf = (date, rows) => {
  // Sharded layout requires balance-descending order (ties by account number).
  const list = [...rows].sort((a, b) => b[1] - a[1] || Number(a[0].slice(4)) - Number(b[0].slice(4))).map(([address, balance]) => ({ address, hedera_balance: balance, total_telcoin_balance: balance }));
  const holders = list.filter((w) => w.address !== "0.0.9").map((w) => ({ address: w.address, balance: w.hedera_balance }));
  const total = list.reduce((sum, w) => sum + w.total_telcoin_balance, 0);
  return {
    generatedAt: `${date}T00:30:00.000Z`,
    thresholds: { minTelRaw: 1 },
    totals: { totalSupply: 100000 },
    chains: {
      hedera: {
        key: "hedera",
        name: "Hedera",
        metrics: { holderCount: holders.length, totalBalance: total - 9000, excluded: { count: 1, balance: 9000 } },
        holders,
      },
    },
    combined: { holderCount: holders.length },
    wallets: list,
    chainOrder: ["hedera"],
    source: { type: "rpc", snapshotDate: date },
  };
};

const TODAY = snapshotOf("2026-11-14", [["0.0.9", 9000], ["0.0.1000002", 5000], ["0.0.20", 2000], ["0.0.1000001", 2000], ["0.0.1000003", 10]]);
const PREVIOUS = snapshotOf("2026-11-13", [["0.0.9", 9000], ["0.0.1000002", 4000], ["0.0.20", 2500], ["0.0.1000001", 3500], ["0.0.1000003", 10]]);

const writeSnapshot = async (file, snapshot, sharded) => {
  const saved = process.env.HD_SNAPSHOT_SHARD_BYTES;
  if (sharded) process.env.HD_SNAPSHOT_SHARD_BYTES = "1";
  else delete process.env.HD_SNAPSHOT_SHARD_BYTES;
  try {
    await writeSnapshotFiles(file, snapshot, { log: QUIET });
  } finally {
    if (saved === undefined) delete process.env.HD_SNAPSHOT_SHARD_BYTES;
    else process.env.HD_SNAPSHOT_SHARD_BYTES = saved;
  }
};

const buildRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-append-treasury-"));
  writeJson(root, "config/projects.json", { projects: [{ slug: "tel", default: true, legacyRoot: true }, { slug: SLUG }] });
  writeJson(root, "config/projects/tel.json", {
    slug: "tel", name: "tel", ticker: "TEL", chains: [{ key: "ethereum" }], holders: { retailThreshold: 1000 },
    data: { legacyRoot: true, dir: "public/data" },
    classification: { exclusions: "config/exclusions.json", cexWallets: "config/cex-wallets.json", dexContracts: "config/dex-contracts.json" },
  });
  writeJson(root, "config/exclusions.json", { addresses: [] });
  writeJson(root, "config/cex-wallets.json", { wallets: [] });
  writeJson(root, "config/dex-contracts.json", { pools: [], routers: [] });
  writeJson(root, `config/projects/${SLUG}.json`, {
    slug: SLUG,
    name: "Hbar",
    ticker: "HBAR",
    chains: [{ key: "hedera", vm: "hedera", asset: { kind: "native", decimals: 8 } }],
    holders: { retailThreshold: 1000 },
    supply: { target: 100000 },
    treasury: { categories: ["treasury"] },
    data: { legacyRoot: false, dir: DATA_REL },
    classification: {
      exclusions: `config/projects/${SLUG}/exclusions.json`,
      cexWallets: `config/projects/${SLUG}/cex-wallets.json`,
    },
  });
  writeJson(root, `config/projects/${SLUG}/exclusions.json`, {
    addresses: ["0.0.9"],
    labels: { "0.0.9": { category: "treasury", name: "Treasury", evidenceTier: "contract-analysis", confidence: "confirmed" } },
  });
  writeJson(root, `config/projects/${SLUG}/cex-wallets.json`, { wallets: [] });
  fs.cpSync(path.join(repo, "scripts"), path.join(root, "scripts"), { recursive: true, filter: (src) => !src.endsWith(".test.js") });
  fs.copyFileSync(path.join(repo, "package.json"), path.join(root, "package.json"));
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "junction");
  writeJson(root, `${DATA_REL}/supply-reconciliation.json`, { categories: { treasury: 9000 } });
  return root;
};

const runCli = (root) => {
  const { HD_SNAPSHOT_SHARD_BYTES: _forced, ...env } = process.env;
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "append-treasury-history.js"), "--project", SLUG], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

describe("append-treasury-history.js snapshot reads", () => {
  let root;
  const historyFile = () => path.join(root, DATA_REL, "treasury-history.json");
  const previousHead = () => path.join(root, DATA_REL, "tel-holders-previous.json");
  const previousDir = () => path.join(root, DATA_REL, "tel-holders-previous.d");
  const historyText = () => fs.readFileSync(historyFile(), "utf8");

  beforeAll(async () => {
    root = buildRoot();
    await writeSnapshot(path.join(root, DATA_REL, "tel-holders.json"), TODAY, false);
  });

  afterAll(() => {
    // Unlink the node_modules junction first so the recursive delete can never follow it into the repo.
    fs.unlinkSync(path.join(root, "node_modules"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const reset = () => {
    fs.rmSync(previousHead(), { force: true });
    fs.rmSync(previousDir(), { recursive: true, force: true });
    writeJson(root, `${DATA_REL}/treasury-history.json`, EMPTY_HISTORY);
    return historyText();
  };

  it("a missing previous snapshot skips the guard, logs it and still writes the row", () => {
    reset();
    const result = runCli(root);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Vanished-wallet guard skipped: no previous snapshot.");
    expect(JSON.parse(historyText()).entries).toHaveLength(1);
  });

  it("an intact sharded previous snapshot runs the guard and succeeds", async () => {
    reset();
    await writeSnapshot(previousHead(), PREVIOUS, true);
    expect(fs.readdirSync(previousDir()).length).toBeGreaterThan(0);
    const result = runCli(root);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain("Vanished-wallet guard skipped");
    expect(JSON.parse(historyText()).entries).toHaveLength(1);
  });

  it("a sharded previous snapshot with a missing shard fails the run and writes nothing", async () => {
    const before = reset();
    await writeSnapshot(previousHead(), PREVIOUS, true);
    const [shard] = fs.readdirSync(previousDir());
    fs.rmSync(path.join(previousDir(), shard));
    const result = runCli(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Vanished-wallet guard skipped");
    expect(result.stderr).toMatch(/missing or unreadable/);
    expect(historyText()).toBe(before);
  });

  it("a sharded previous snapshot with a wrong shard hash fails the run and writes nothing", async () => {
    const before = reset();
    await writeSnapshot(previousHead(), PREVIOUS, true);
    const [shard] = fs.readdirSync(previousDir());
    const shardPath = path.join(previousDir(), shard);
    const bytes = fs.readFileSync(shardPath);
    fs.writeFileSync(shardPath, Buffer.concat([bytes, Buffer.from(" ")]));
    const result = runCli(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Vanished-wallet guard skipped");
    expect(historyText()).toBe(before);
  });
});
