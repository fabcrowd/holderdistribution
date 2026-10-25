import { describe, it, expect } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BROWSER_DATA_FILES } from "./browserDataFiles.js";
import { LIVE_DATA_FILES } from "../../netlify/functions/live-data.mjs";
import { pruneDistData } from "../prune-dist-data.js";

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });

describe("browser data files", () => {
  const src = walk(path.resolve("src")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  // resolveDataUrl("feed") (default project) and dataUrl(slug, "feed").
  const fetched = [
    ...[...src.matchAll(/resolveDataUrl\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bdataUrl\(\s*[\w.]+\s*,\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]),
  ];

  it("covers every feed the frontend fetches", () => {
    expect(fetched.length).toBeGreaterThanOrEqual(10);
    for (const f of fetched) expect(BROWSER_DATA_FILES.has(f), f).toBe(true);
  });

  it("the frontend never fetches the big pipeline files", () => {
    for (const f of ["holders-checkpoint.json", "holders-ever-checkpoint.json", "tel-holders.json", "tel-holders-previous.json", "cex-wallets.json", "funding-wallets.json"]) {
      expect(fetched).not.toContain(f);
      expect(BROWSER_DATA_FILES.has(f)).toBe(false);
    }
  });

  it("every browser feed is also served by /live-data", () => {
    for (const f of BROWSER_DATA_FILES) expect(LIVE_DATA_FILES.has(f), f).toBe(true);
  });

  it("prune keeps the browser feeds and removes the rest", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dist-data-"));
    for (const f of ["holders-lite.json", "chain-status.json", "tel-holders.json", "holders-checkpoint.json", "cex-wallets.json"]) await fsp.writeFile(path.join(dir, f), "{}");
    await fsp.mkdir(path.join(dir, "wallet-analysis"));
    const { kept, removed } = await pruneDistData(dir);
    expect(kept).toEqual(["chain-status.json", "holders-lite.json"]);
    expect(removed).toEqual(["cex-wallets.json", "holders-checkpoint.json", "tel-holders.json", "wallet-analysis"]);
  });

  it("multi-token: copies a legacy-root project's feeds into /data/<slug>/ and prunes every project folder", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dist-data-"));
    for (const f of ["holders-lite.json", "chain-status.json", "tel-holders.json"]) await fsp.writeFile(path.join(dir, f), `"${f}"`);
    await fsp.mkdir(path.join(dir, "abc"));
    for (const f of ["holders-lite.json", "holders-checkpoint.json"]) await fsp.writeFile(path.join(dir, "abc", f), "{}");
    await fsp.mkdir(path.join(dir, "wallet-analysis"));
    const out = await pruneDistData(dir, { slugs: ["tel", "abc"], legacySlugs: ["tel"] });
    // Legacy root copies stay for old bundles / links.
    expect(out.kept).toEqual(["chain-status.json", "holders-lite.json"]);
    expect(out.removed).toEqual(["tel-holders.json", "wallet-analysis"]);
    expect(out.projects.tel.kept).toEqual(["chain-status.json", "holders-lite.json"]);
    expect(JSON.parse(await fsp.readFile(path.join(dir, "tel", "holders-lite.json"), "utf8"))).toBe("holders-lite.json");
    expect(out.projects.abc).toEqual({ kept: ["holders-lite.json"], removed: ["holders-checkpoint.json"] });
  });
});
