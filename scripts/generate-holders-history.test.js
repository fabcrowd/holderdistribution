import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Runs the real generator CLI offline on a temp repo (a copy of config/ plus fixture feeds) and checks the
// holders-history.json `firstLiveDate` it writes (lib/firstLiveDate.js).
const repo = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(repo, "scripts", "generate-holders-history.js");
const SLUG = "zebec-network";

let root;
let dataDir;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gen-history-"));
  fs.cpSync(path.join(repo, "config"), path.join(root, "config"), { recursive: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  dataDir = path.join(root, "public", "data", SLUG);
  fs.rmSync(path.join(root, "public"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "data"), { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

const writeJson = (file, value) => fs.writeFileSync(path.join(dataDir, file), JSON.stringify(value));
const readHistory = () => JSON.parse(fs.readFileSync(path.join(dataDir, "holders-history.json"), "utf8"));
const snapshot = (date) => ({
  generatedAt: `${date}T12:00:00.000Z`,
  source: { snapshotDate: date },
  asOf: { date, settled: true, blocks: { solana: 1 } },
  chains: { solana: { key: "solana", holderCount: 1 } },
  combined: { holderCount: 1, totalBalance: 5 },
  wallets: [{ address: "A", solana_balance: 5, total: 5 }],
});
const row = (date) => ({ date, combined: { holderCount: 1 }, chains: {} });
const run = () => {
  const env = { ...process.env };
  delete env.HD_PROJECT;
  const r = spawnSync(process.execPath, [SCRIPT, "--project", SLUG], { cwd: root, env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return readHistory();
};

describe("generate-holders-history.js firstLiveDate", () => {
  it("a brand-new history takes the live row's day, not an earlier tel-holders-previous.json gap-fill row", () => {
    writeJson("tel-holders.json", snapshot("2026-11-05"));
    writeJson("tel-holders-previous.json", snapshot("2026-11-04"));
    const h = run();
    expect(h.entries.map((e) => e.date)).toEqual(["2026-11-04", "2026-11-05"]);
    expect(h.firstLiveDate).toBe("2026-11-05");
  });

  it("a pending history (rebuild rows, firstLiveDate null) takes the first live row's day", () => {
    writeJson("holders-history.json", { firstLiveDate: null, entries: [row("2024-01-17"), row("2024-01-18")] });
    writeJson("tel-holders.json", snapshot("2026-11-05"));
    expect(run().firstLiveDate).toBe("2026-11-05");
  });

  it("a pending history stays null when the run writes no live row", () => {
    writeJson("holders-history.json", { firstLiveDate: null, entries: [row("2024-01-17")] });
    const h = run();
    expect(Object.hasOwn(h, "firstLiveDate")).toBe(true);
    expect(h.firstLiveDate).toBeNull();
  });

  it("a known firstLiveDate survives the rewrite, even with a later live row and a different checkpoint", () => {
    writeJson("holders-history.json", { firstLiveDate: "2026-10-25", entries: [row("2026-10-25")] });
    writeJson("exchange-flow-checkpoint.json", { chains: { solana: { since: "2026-10-20" } } });
    writeJson("tel-holders.json", snapshot("2026-11-05"));
    expect(run().firstLiveDate).toBe("2026-10-25");
  });

  it("an unknown history (rows, no field) carries over the recorded flow floor once", () => {
    writeJson("holders-history.json", { entries: [row("2026-10-25"), row("2026-11-17")] });
    writeJson("exchange-flow-checkpoint.json", { chains: { solana: { since: "2026-10-25" } } });
    expect(run().firstLiveDate).toBe("2026-10-25");
  });

  it("an unknown history after an override flow run carries over the pre-override floor, not the override", () => {
    writeJson("holders-history.json", { entries: [row("2026-10-25"), row("2026-11-17")] });
    writeJson("exchange-flow-checkpoint.json", { chains: { solana: { since: "2026-12-01", sinceSource: "override", defaultSince: "2026-10-25" } } });
    expect(run().firstLiveDate).toBe("2026-10-25");
  });

  it("an unknown history without a recorded flow floor stays without the field (never guessed)", () => {
    writeJson("holders-history.json", { entries: [row("2024-01-17"), row("2026-11-04")] });
    writeJson("tel-holders.json", snapshot("2026-11-05"));
    expect(Object.hasOwn(run(), "firstLiveDate")).toBe(false);
  });
});
