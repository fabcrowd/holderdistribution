import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { overlay, main } from "./store-overlay.js";

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-overlay-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const list = (dir) => fs.readdirSync(path.join(dir, "manifests")).sort();

describe("store-overlay", () => {
  it("removes the absent marker of a coin the publish wrote, keeps the others", () => {
    const origin = tree({ "manifests/new.absent": "", "manifests/old.json": "{\"v\":1}", "manifests/other.absent": "", "heads/x": "1" });
    const published = tree({ "manifests/new.json": "{}", "manifests/old.json": "{\"v\":2}" });
    const out = path.join(tree({}), "after");
    expect(overlay({ originDir: origin, publishedDir: published, outDir: out })).toEqual(["new.absent"]);
    expect(list(out)).toEqual(["new.json", "old.json", "other.absent"]);
    expect(fs.readFileSync(path.join(out, "manifests/old.json"), "utf8")).toBe("{\"v\":2}");
    expect(fs.existsSync(path.join(out, "heads/x"))).toBe(true);
    expect(fs.existsSync(path.join(origin, "manifests/new.absent"))).toBe(true);
  });

  it("works through the CLI entry", () => {
    const origin = tree({ "manifests/a.absent": "" });
    const published = tree({ "manifests/a.json": "{}" });
    const out = path.join(tree({}), "after");
    const lines = [];
    expect(main(["--origin-dir", origin, "--published-dir", published, "--out-dir", out], { logger: { log: (l) => lines.push(l) } })).toBe(0);
    expect(list(out)).toEqual(["a.json"]);
    expect(lines[0]).toContain("1 absent marker");
  });
});
