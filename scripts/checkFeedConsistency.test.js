/**
 * check-feed-consistency.js, check 3: treasury-history's newest row is a
 * settled-day row, so it is only comparable to supply-reconciliation when the
 * snapshot is pinned. An unpinned (head-read) snapshot must skip it, like check 1.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const repo = path.resolve(".");
const SLUG = "demo";
const NOT_COMPARED = "treasury-history not compared: snapshot is unpinned";
let tmp;

const write = (rel, obj) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), JSON.stringify(obj));
};

const CATS = { retail: 100, treasury: 50, council: 30, holdings: 10, escrow: 10 };
const combined = { totalBalance: 100, holderCount: 5 };

/** Writes the fixture feeds; `councilInTreasury` is the settled row's council value. */
const writeFixture = ({ unpinned, councilInTreasury, treasuryDate = "2026-10-01" }) => {
  const asOf = { date: "2026-10-02", unpinned: unpinned ? ["ethereum"] : [] };
  write(`public/data/${SLUG}/supply-reconciliation.json`, { categories: CATS, counted: 200, generatedAt: new Date().toISOString() });
  write(`public/data/${SLUG}/holders-lite.json`, { generatedAt: new Date().toISOString(), views: { combined: { metrics: { totalBalance: 100, holderCount: 5 } } } });
  write(`public/data/${SLUG}/holders-summary.json`, { asOf, combined });
  write(`public/data/${SLUG}/tel-holders.json`, { asOf, combined });
  write(`public/data/${SLUG}/holders-history.json`, { entries: [{ date: "2026-10-01", combined }] });
  write(`public/data/${SLUG}/treasury-history.json`, { entries: [{ date: treasuryDate, categories: { ...CATS, council: councilInTreasury } }] });
  write(`public/data/${SLUG}/classification-changelog.json`, { events: [] });
};

const run = () => {
  const r = spawnSync(process.execPath, [path.join(repo, "scripts", "check-feed-consistency.js"), `--project=${SLUG}`], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, HD_PROJECT: "" },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-feedcheck-"));
  write("config/projects.json", { projects: [{ slug: SLUG, name: "Demo", ticker: "DMO", default: true }] });
  write(`config/projects/${SLUG}.json`, {
    slug: SLUG, name: "Demo", ticker: "DMO", supply: { target: 200 },
    chains: [{ key: "ethereum", name: "Ethereum", chainId: 1, origin: true, fromBlock: 1, explorer: "https://etherscan.io",
      tokens: [{ generation: "v1", address: `0x${"a".repeat(40)}`, decimals: 18, deployBlock: 1 }] }],
  });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("check-feed-consistency treasury-history comparison", () => {
  it("unpinned snapshot with a mismatched council row is not compared", () => {
    writeFixture({ unpinned: true, councilInTreasury: 130 });
    const { status, out } = run();
    expect(out).toContain(NOT_COMPARED);
    expect(out).not.toContain('category "council" DISAGREES');
    expect(status).toBe(0);
  });

  it("pinned snapshot with a mismatched council row fails", () => {
    writeFixture({ unpinned: false, councilInTreasury: 130 });
    const { status, out } = run();
    expect(out).toContain('category "council" DISAGREES');
    expect(status).toBe(1);
  });

  it("pinned snapshot with matching rows passes", () => {
    writeFixture({ unpinned: false, councilInTreasury: 30 });
    const { status, out } = run();
    expect(out).toContain('category "council": 2 feeds agree');
    expect(out).not.toContain(NOT_COMPARED);
    expect(status).toBe(0);
  });

  it("unpinned snapshot whose treasury newest row is the settled day-1 passes", () => {
    writeFixture({ unpinned: true, councilInTreasury: 30, treasuryDate: "2026-10-01" });
    const { status, out } = run();
    expect(out).toContain(NOT_COMPARED);
    expect(status).toBe(0);
  });

  it("sizes the cross-feed tolerance from the supply target, not a fixed 1 token", () => {
    const cfgPath = path.join(tmp, "config", "projects", `${SLUG}.json`);
    const original = fs.readFileSync(cfgPath, "utf8");
    const withTarget = (target) => fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(original), supply: { target } }));
    try {
      writeFixture({ unpinned: false, councilInTreasury: 35 });
      withTarget(200); // tolerance floors at 1 token: a 5-token gap is real
      expect(run().status).toBe(1);
      withTarget(1e12); // tolerance 10: the same gap is within it
      expect(run().status).toBe(0);
    } finally {
      fs.writeFileSync(cfgPath, original);
    }
  });

  it("unpinned snapshot whose treasury newest row is 3 days old fails as stale", () => {
    writeFixture({ unpinned: true, councilInTreasury: 30, treasuryDate: "2026-09-29" });
    const { status, out } = run();
    expect(out).toContain("treasury-history is stale: newest row 2026-09-29");
    expect(status).toBe(1);
  });
});
