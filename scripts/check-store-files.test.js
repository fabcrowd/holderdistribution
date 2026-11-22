import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coinLayout } from "./lib/storeFiles.js";
import { checkCoin, formatCoin, main } from "./check-store-files.js";

let root;
const put = (rel, text = "{}") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const layout = (extra = {}) => coinLayout({ slug: "abc", dataDir: "public/data/abc", workDir: "data/abc", slugs: ["abc", "xyz"], ...extra });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "check-store-files-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("checkCoin", () => {
  it("counts stored and excluded files per kind", async () => {
    put("public/data/abc/holders.json");
    put("data/abc/holders-previous.json");
    put("data/abc/ledger/a.json");
    put("data/abc/forensics/f.json");
    put("data/abc/forensics/wallet-flows.registry.json");
    const r = await checkCoin({ root, layout: layout() });
    expect(r.unclassified).toEqual([]);
    expect(r.kinds.holders).toEqual({ stored: 1, excluded: 1 });
    expect(r.kinds.ledger).toEqual({ stored: 1, excluded: 0 });
    expect(r.kinds.walletFlows).toEqual({ stored: 1, excluded: 1 });
  });

  it("reports every unclassified file with its kind and reason", async () => {
    put("public/data/abc/ok.json");
    put("data/abc/bad#slice.json");
    put("data/abc/ledger/x#slice.y.json");
    const r = await checkCoin({ root, layout: layout() });
    expect(r.unclassified.map((u) => [u.kind, u.path, u.why])).toEqual([
      ["holders", "data/abc/bad#slice.json", "name cannot be stored"],
      ["ledger", "data/abc/ledger/x#slice.y.json", "name cannot be stored"],
    ]);
  });

  it("treats a registry excludedFiles entry as classified", async () => {
    put("data/abc/scratch/ui.json");
    expect((await checkCoin({ root, layout: layout() })).kinds.holders.stored).toBe(1);
    const r = await checkCoin({ root, layout: layout({ excludedFiles: ["scratch/ui.json"] }) });
    expect(r.kinds.holders).toEqual({ stored: 0, excluded: 1 });
  });

  it("flags a directory named like another coin", async () => {
    put("data/abc/xyz/a.json");
    const r = await checkCoin({ root, layout: layout() });
    expect(r.unclassified).toHaveLength(1);
    expect(r.unclassified[0].why).toMatch(/another registered coin/);
  });
});

describe("formatCoin", () => {
  it("prints counts and an UNCLASSIFIED line per file", () => {
    const text = formatCoin({ slug: "abc", kinds: { holders: { stored: 2, excluded: 1 } }, unclassified: [{ kind: "holders", path: "p", why: "w" }] });
    expect(text).toContain("abc");
    expect(text).toContain("holders stored 2 excluded 1");
    expect(text).toContain("UNCLASSIFIED p (w) [holders]");
  });
});

describe("main", () => {
  it("rejects an unknown slug with exit code 2", async () => {
    const logger = { log() {}, error() {} };
    expect(await main(["--project", "no-such-coin-zz"], { logger })).toBe(2);
  });

  it("rejects an unknown argument with exit code 2", async () => {
    const logger = { log() {}, error() {} };
    expect(await main(["--bogus", "x"], { logger })).toBe(2);
  });
});
