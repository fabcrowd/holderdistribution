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
  for (let i = 0; i < n; i++) {
    lines.push(solana
      ? "('solana', '" + (i + 1000000000000000000000000000000000000000).toString(36).padEnd(44, "A").slice(0, 44) + "', 'Binance', 'Binance " + i + "', 'x', date '2024-01-01')"
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

const run = (args, env) => {
  const childEnv = { ...process.env, ...env };
  delete childEnv.ENV_PASSPHRASE;
  delete childEnv.HD_PROJECT;
  return spawnSync(process.execPath, ["--import", pathToFileURL(stubFile).href, script, "--source", "spellbook", ...args], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
  });
};

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
