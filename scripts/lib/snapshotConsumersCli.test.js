import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeSnapshotFiles } from "./snapshotIo.js";

// Runs the real reader CLIs against one small hedera-shaped single-chain project stored twice, as a single slim
// file and as a head plus shards, and requires byte-identical outputs. A reader that still did a bare JSON.parse
// would see a sharded head without `wallets` and publish zeros, which is what this guards.
//
// Not covered here (needs the network or a live chain): pull-holders-rpc.js, resync-chain-holders.js (writers, own
// test), detect-cex-candidates.js (spellbook fetch over the network), sync-cex-wallets-dune.js (Dune API),
// recompute-history-from-git.js / rebuild-history-from-logs.js / rebuild-holders-history-solana.js (RPC and
// transfer caches), cross-check-rebuild-etherscan.js (Etherscan), fill-history-gaps.js (spawns pull-holders-rpc.js),
// onboard-run.js (gh and GitHub workflows).
const repo = path.resolve(import.meta.dirname, "..", "..");

// Some CLIs (derive-holder-tiers, append-treasury-history) resolve their root from their own file location, so each
// temp root gets its own copy of scripts/ (tests left out) and a link to the repo's node_modules.
const installScripts = (root) => {
  fs.cpSync(path.join(repo, "scripts"), path.join(root, "scripts"), { recursive: true, filter: (src) => !src.endsWith(".test.js") });
  fs.copyFileSync(path.join(repo, "package.json"), path.join(root, "package.json"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.copyFileSync(path.join(repo, "config", "holder-tiers.default.json"), path.join(root, "config", "holder-tiers.default.json"));
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "junction");
};

// Fields that carry the wall clock; they are dropped from JSON outputs before the layouts are compared.
const WALL_CLOCK_FIELDS = new Set(["generatedAt", "listUpdatedAt", "updatedAt"]);

const SLUG = "hbar";
const DATA_REL = `public/data/${SLUG}`;
const QUIET = { log: () => {}, warn: () => {} };

const wallets = (rows) =>
  rows.map(([address, balance]) => ({ address, hedera_balance: balance, total_telcoin_balance: balance }));

const snapshotOf = (date, rows) => {
  const list = wallets(rows);
  const holders = list.filter((w) => w.address !== "0.0.9").map((w) => ({ address: w.address, balance: w.hedera_balance }));
  const total = list.reduce((s, w) => s + w.total_telcoin_balance, 0);
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

// Account numbers span two shard ranges; 0.0.9 is excluded (treasury).
const DAY1 = snapshotOf("2026-11-13", [["0.0.9", 9000], ["0.0.1000002", 4000], ["0.0.20", 2500], ["0.0.1000001", 3500], ["0.0.1000003", 10]]);
const DAY2 = snapshotOf("2026-11-14", [["0.0.9", 9000], ["0.0.1000002", 5000], ["0.0.20", 2000], ["0.0.1000001", 2000], ["0.0.1000003", 10]]);

const writeFile = (root, rel, value) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

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

const git = (root, args, env = {}) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

const commitDay = (root, date) => {
  const stamp = `${date}T12:00:00+0000`;
  git(root, ["add", "-A", DATA_REL], {});
  git(root, ["commit", "-m", `snapshot ${date}`], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
};

const buildRoot = async (sharded) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hd-consumers-${sharded ? "sharded" : "slim"}-`));
  writeFile(root, "config/projects.json", { projects: [{ slug: "tel", default: true, legacyRoot: true }, { slug: SLUG }] });
  writeFile(root, "config/projects/tel.json", {
    slug: "tel", name: "tel", ticker: "TEL", chains: [{ key: "ethereum" }], holders: { retailThreshold: 1000 },
    data: { legacyRoot: true, dir: "public/data" },
    classification: { exclusions: "config/exclusions.json", cexWallets: "config/cex-wallets.json", dexContracts: "config/dex-contracts.json" },
  });
  writeFile(root, "config/exclusions.json", { addresses: [] });
  writeFile(root, "config/cex-wallets.json", { wallets: [] });
  writeFile(root, "config/dex-contracts.json", { pools: [], routers: [] });
  writeFile(root, `config/projects/${SLUG}.json`, {
    slug: SLUG,
    name: "Hbar",
    ticker: "HBAR",
    chains: [{ key: "hedera", vm: "hedera", asset: { kind: "native", decimals: 8 } }],
    holders: {
      retailThreshold: 1000,
      distributionTiers: [
        { label: "3K+", min: 3000, max: null },
        { label: "1K-3K", min: 1000, max: 3000 },
        { label: "Under 1K", min: 0, max: 1000 },
      ],
    },
    supply: { target: 100000 },
    treasury: { categories: ["treasury"] },
    data: { legacyRoot: false, dir: DATA_REL },
    classification: {
      exclusions: `config/projects/${SLUG}/exclusions.json`,
      cexWallets: `config/projects/${SLUG}/cex-wallets.json`,
    },
  });
  writeFile(root, `config/projects/${SLUG}/exclusions.json`, {
    addresses: ["0.0.9"],
    labels: { "0.0.9": { category: "treasury", name: "Treasury", evidenceTier: "contract-analysis", confidence: "confirmed" } },
  });
  writeFile(root, `config/projects/${SLUG}/cex-wallets.json`, { wallets: [{ address: "0.0.20", label: "Kraken" }] });

  installScripts(root);
  git(root, ["init", "-q"]);
  const head = path.join(root, DATA_REL, "tel-holders.json");
  await writeSnapshot(head, DAY1, sharded);
  commitDay(root, "2026-11-13");
  await writeSnapshot(head, DAY2, sharded);
  commitDay(root, "2026-11-14");
  await writeSnapshot(path.join(root, DATA_REL, "tel-holders-previous.json"), DAY1, sharded);

  writeFile(root, `data/${SLUG}/hedera-flow-days.json`, {
    schema: 1,
    chains: {
      hedera: {
        days: {
          "2026-11-14": {
            totals: { cexIn: "500000000", cexOut: "200000000" },
            byExchange: { Kraken: { cexIn: "500000000", cexOut: "200000000" } },
            counterparties: { "cexIn|Kraken|0.0.1000002": "500000000", "cexOut|Kraken|0.0.1000001": "200000000" },
          },
        },
      },
    },
  });
  writeFile(root, `${DATA_REL}/holders-summary.json`, { generatedAt: "x", snapshotDate: "2026-11-14", combined: {}, chains: {} });
  writeFile(root, `${DATA_REL}/treasury-history.json`, { entries: [] });
  return root;
};

const cliEnv = () => {
  const { HD_SNAPSHOT_SHARD_BYTES: _forced, ...env } = process.env;
  // A closed local port, so the Hedera network-stake lookup fails fast and offline, identically in both roots.
  return { ...env, HEDERA_MIRROR_URL: "http://127.0.0.1:9" };
};

const run = (root, name, args = []) => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", name), "--project", SLUG, ...args], {
    cwd: root,
    encoding: "utf8",
    env: cliEnv(),
    timeout: 60_000,
  });
  return { status: result.status, stdout: (result.stdout ?? "").split(root).join("<root>"), stderr: (result.stderr ?? "").split(root).join("<root>") };
};

const dropWallClock = (value) => {
  if (Array.isArray(value)) return value.map(dropWallClock);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !WALL_CLOCK_FIELDS.has(k)).map(([k, v]) => [k, dropWallClock(v)]));
  }
  return value;
};

const LAYOUT_SPECIFIC = new Set(["tel-holders.json", "tel-holders-previous.json", "tel-holders.d", "tel-holders-previous.d"]);

/** Every file the CLIs produced under public/data and data, as text with the wall-clock fields dropped. */
const collectOutputs = (root) => {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (LAYOUT_SPECIFIC.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const text = fs.readFileSync(full, "utf8");
        const rel = path.relative(root, full).split(path.sep).join("/");
        out[rel] = entry.name.endsWith(".json") ? `${JSON.stringify(dropWallClock(JSON.parse(text)), null, 2)}\n` : text;
      }
    }
  };
  for (const top of [DATA_REL, `data/${SLUG}`]) if (fs.existsSync(path.join(root, top))) walk(path.join(root, top));
  return out;
};

// Order matters: later steps read what earlier ones wrote.
const STEPS = [
  ["pull-cex-wallets.js"],
  ["generate-holders-lite.js"],
  ["generate-holders-history.js"],
  ["derive-holder-tiers.js"],
  ["reconcile-supply.js"],
  ["append-treasury-history.js"],
  ["validate-outputs.js"],
  ["generate-holder-transitions.js"],
  ["generate-tier-outflows.js"],
];

const roots = [];
afterAll(() => {
  for (const root of roots) {
    // Unlink the node_modules junction first so the recursive delete can never follow it into the repo.
    fs.unlinkSync(path.join(root, "node_modules"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("reader CLIs give the same outputs for a slim file and a sharded snapshot", () => {
  let slim;
  let sharded;

  it("builds the two projects in the two layouts", async () => {
    slim = await buildRoot(false);
    sharded = await buildRoot(true);
    roots.push(slim, sharded);
    expect(JSON.parse(fs.readFileSync(path.join(slim, DATA_REL, "tel-holders.json"), "utf8")).layout).toBe("slim-v1");
    expect(JSON.parse(fs.readFileSync(path.join(sharded, DATA_REL, "tel-holders.json"), "utf8")).layout).toBe("sharded-v1");
    expect(JSON.parse(fs.readFileSync(path.join(sharded, DATA_REL, "tel-holders.json"), "utf8")).wallets).toBeUndefined();
  });

  const results = new Map();
  for (const [name] of STEPS) {
    it(`${name} succeeds and prints the same in both layouts`, () => {
      const a = run(slim, name);
      const b = run(sharded, name);
      results.set(name, { a, b });
      expect(a.status, `${name} (slim) failed:\n${a.stdout}\n${a.stderr}`).toBe(0);
      expect(b.status, `${name} (sharded) failed:\n${b.stdout}\n${b.stderr}`).toBe(0);
      if (name === "derive-holder-tiers.js" || name === "validate-outputs.js") expect(b.stdout).toBe(a.stdout);
    }, 90_000);
  }

  it("leaves byte-identical files behind", () => {
    const a = collectOutputs(slim);
    const b = collectOutputs(sharded);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    for (const file of Object.keys(a)) expect(b[file], file).toBe(a[file]);
    // The run did real work: the sharded outputs are not the empty-snapshot shape.
    const lite = JSON.parse(b[`${DATA_REL}/holders-lite.json`]);
    expect(lite.views.combined.metrics.holderCount).toBe(3);
    expect(lite.views.combined.metrics.totalBalance).toBe(7010);
    // Past snapshots come from git: the tier feed and the transitions matrix must have seen real holders.
    const tiers = JSON.parse(b[`${DATA_REL}/tier-outflows.json`]);
    expect(tiers.ranges["1"].tiers["3K+"].cex).toBe(5);
    expect(tiers.ranges["1"].tiers["1K-3K"].inflows.cex).toBe(2);
    const transitions = JSON.parse(b[`${DATA_REL}/holder-transitions.json`]);
    expect(transitions.ranges["1"].matrix).toEqual({ "3K+": { "1K-3K": { count: 1, tel: 2000 } } });
    expect(JSON.parse(b[`${DATA_REL}/supply-reconciliation.json`]).categories.treasury).toBe(9000);
    expect(JSON.parse(b[`${DATA_REL}/treasury-history.json`]).entries).toHaveLength(1);
  });
});
