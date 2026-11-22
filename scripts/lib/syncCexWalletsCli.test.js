import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs scripts/sync-cex-wallets-dune.js with --source spellbook in a temp root that holds a copy of config/
// (the 4 MB cex-wallets.json replaced by a stub). A --import preload replaces fetch: STUB_FETCH=throw fails the
// test if anything is fetched, otherwise the body is a spellbook-shaped SQL text with STUB_ROWS rows.
const repo = path.resolve(import.meta.dirname, "..", "..");
const script = path.join(repo, "scripts", "sync-cex-wallets-dune.js");
const STUB = `
const mode = process.env.STUB_FETCH;
globalThis.fetch = async (url) => {
  if (mode === "throw") throw new Error("FETCH CALLED " + url);
  const n = Number(process.env.STUB_ROWS);
  const solana = String(url).includes("solana");
  const lines = [];
  // A valid Solana key: base58 of exactly 32 bytes (top byte 0x55 keeps the length; the row index sits in the low bytes).
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const solanaKey = (v) => { let x = (0x55n << 248n) + BigInt(v); let s = ""; while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; } return s; };
  for (let i = 0; i < n; i++) {
    lines.push(solana
      ? "('solana', '" + solanaKey(i + 1) + "', 'Binance', 'Binance " + i + "', 'x', date '2024-01-01')"
      : "(0x" + (i + 1).toString(16).padStart(40, "0") + ", 'Binance', 'Binance " + i + "', 'x', date '2024-01-01')");
  }
  return { ok: true, status: 200, text: async () => "select * from (values " + lines.join(", ") + ") as t" };
};
`;

let root;
let stubFile;
const CEX_STUB = { wallets: [] };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hd-sync-cex-"));
  fs.cpSync(path.join(repo, "config"), path.join(root, "config"), {
    recursive: true,
    filter: (src) => path.basename(src) !== "cex-wallets.json",
  });
  fs.writeFileSync(path.join(root, "config", "cex-wallets.json"), JSON.stringify(CEX_STUB));
  stubFile = path.join(root, "fetch-stub.mjs");
  fs.writeFileSync(stubFile, STUB);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const runIn = (dir, args, env) => {
  const childEnv = { ...process.env, ...env };
  delete childEnv.ENV_PASSPHRASE;
  delete childEnv.HD_PROJECT;
  return spawnSync(process.execPath, ["--import", pathToFileURL(stubFile).href, script, "--source", "spellbook", ...args], {
    cwd: dir,
    env: childEnv,
    encoding: "utf8",
  });
};
const run = (args, env) => runIn(root, args, env);

describe("sync-cex-wallets-dune --source spellbook", () => {
  it("spellbook is the default source: no --source flag still fetches the spellbook list", () => {
    const childEnv = { ...process.env, STUB_FETCH: "rows", STUB_ROWS: "10" };
    delete childEnv.ENV_PASSPHRASE;
    delete childEnv.HD_PROJECT;
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(stubFile).href, script, "--project", "tel"], {
      cwd: root, env: childEnv, encoding: "utf8",
    });
    expect(r.stdout).toContain("Fetching Dune spellbook CEX model (evm)");
    expect(r.stderr).not.toMatch(/DUNE_API_KEY|Dune API/);
  });

  it("a vm with no spellbook model is a clean skip: notice, exit 0, nothing fetched or written", () => {
    const r = run(["--project", "hedera", "--candidates"], { STUB_FETCH: "throw" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::notice::no spellbook CEX model for vm "hedera" (hedera); CEX list is owner-maintained');
    expect(r.stderr).not.toContain("FETCH CALLED");
    expect(fs.existsSync(path.join(root, "data", "hedera", "cex-dune-candidates.json"))).toBe(false);
  });

  it("the skip also applies without --candidates", () => {
    const r = run(["--project", "hedera"], { STUB_FETCH: "throw" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::notice::no spellbook CEX model");
  });

  it("EVM list below its floor exits 1 and writes nothing", () => {
    const before = fs.readFileSync(path.join(root, "config", "cex-wallets.json"), "utf8");
    const r = run(["--project", "tel"], { STUB_FETCH: "rows", STUB_ROWS: "10" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Nothing written");
    expect(fs.readFileSync(path.join(root, "config", "cex-wallets.json"), "utf8")).toBe(before);
  });

  it("Solana list below its floor exits 1 and writes nothing", () => {
    const r = run(["--project", "zebec-network", "--candidates"], { STUB_FETCH: "rows", STUB_ROWS: "5" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Nothing written");
    expect(fs.existsSync(path.join(root, "data", "zebec-network", "cex-dune-candidates.json"))).toBe(false);
  });
});

// Mode is decided by the script alone: additions only for an EVM project with a CEX file; otherwise candidates.
const made = [];
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
// A fresh copy of config/ with a stub for each CEX file the case needs; `mutate` edits the copied config first.
const makeRoot = (cexFiles, mutate) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-sync-cex-mode-"));
  made.push(dir);
  fs.cpSync(path.join(repo, "config"), path.join(dir, "config"), {
    recursive: true,
    filter: (src) => path.basename(src) !== "cex-wallets.json",
  });
  for (const rel of cexFiles) writeJson(path.join(dir, rel), CEX_STUB);
  mutate?.(dir);
  return dir;
};
// Candidates mode reads the holder snapshot: TEL's sits at the legacy root, other projects under public/data/<slug>.
const writeHolders = (dir, slug, wallets) => {
  const file = slug === "tel" ? "public/data/tel-holders.json" : `public/data/${slug}/tel-holders.json`;
  writeJson(path.join(dir, file), { generatedAt: "2026-11-01T00:00:00.000Z", totals: { totalSupply: 1000 }, wallets });
};
const withoutCexDeclaration = (slug) => (dir) => {
  const file = path.join(dir, "config", "projects", `${slug}.json`);
  const cfg = readJson(file);
  delete cfg.classification.cexWallets;
  writeJson(file, cfg);
};
const EVM_HOLDER = `0x${"0".repeat(39)}1`;

describe("sync-cex-wallets-dune mode: additions only for an EVM project with a CEX file", () => {
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("TEL (EVM, CEX file at the legacy path) merges additions and writes no candidates file", () => {
    const dir = makeRoot(["config/cex-wallets.json"]);
    const r = runIn(dir, ["--project", "tel"], { STUB_FETCH: "rows", STUB_ROWS: "1000" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Net-new addresses to add: 1000");
    expect(readJson(path.join(dir, "config", "cex-wallets.json")).wallets).toHaveLength(1000);
    expect(fs.existsSync(path.join(dir, "data", "cex-dune-candidates.json"))).toBe(false);
  });

  it("a non-TEL EVM project with a CEX file (ondo) merges additions into its own file", () => {
    const dir = makeRoot(["config/projects/ondo/cex-wallets.json"]);
    const r = runIn(dir, ["--project", "ondo"], { STUB_FETCH: "rows", STUB_ROWS: "1000" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Net-new addresses to add: 1000");
    expect(readJson(path.join(dir, "config", "projects", "ondo", "cex-wallets.json")).wallets).toHaveLength(1000);
    expect(fs.existsSync(path.join(dir, "data", "ondo", "cex-dune-candidates.json"))).toBe(false);
  });

  it("an EVM project with no CEX file gets candidates and no list is created", () => {
    const dir = makeRoot([], withoutCexDeclaration("ondo"));
    writeHolders(dir, "ondo", [{ address: EVM_HOLDER, total_telcoin_balance: 5 }]);
    const r = runIn(dir, ["--project", "ondo"], { STUB_FETCH: "rows", STUB_ROWS: "1000" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Wrote candidates (review only, no production list touched)");
    expect(fs.existsSync(path.join(dir, "config", "projects", "ondo", "cex-wallets.json"))).toBe(false);
    const out = readJson(path.join(dir, "data", "ondo", "cex-dune-candidates.json"));
    expect(out.candidates.map((c) => c.address)).toEqual([EVM_HOLDER]);
  });

  it("a Solana project with a declared CEX file (zebec-network) gets candidates and its file is untouched", () => {
    const cexRel = "config/projects/zebec-network/cex-wallets.json";
    const dir = makeRoot([cexRel]);
    const before = fs.readFileSync(path.join(dir, cexRel), "utf8");
    writeHolders(dir, "zebec-network", []);
    const r = runIn(dir, ["--project", "zebec-network"], { STUB_FETCH: "rows", STUB_ROWS: "60" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Wrote candidates (review only, no production list touched)");
    expect(fs.readFileSync(path.join(dir, cexRel), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(dir, "data", "zebec-network", "cex-dune-candidates.json"))).toBe(true);
  });

  it("--candidates forces candidates for an EVM project that has a CEX file, and leaves the file unchanged", () => {
    const dir = makeRoot(["config/cex-wallets.json"]);
    const before = fs.readFileSync(path.join(dir, "config", "cex-wallets.json"), "utf8");
    writeHolders(dir, "tel", []);
    const r = runIn(dir, ["--project", "tel", "--candidates"], { STUB_FETCH: "rows", STUB_ROWS: "1000" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Wrote candidates (review only, no production list touched)");
    expect(fs.readFileSync(path.join(dir, "config", "cex-wallets.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(dir, "data", "cex-dune-candidates.json"))).toBe(true);
  });
});
