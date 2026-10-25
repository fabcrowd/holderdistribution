import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { legacyRootSlugs, loadProjectConfig, loadRegistry, projectDataDir, SLUG_RE } from "./projects.js";
import { LEGACY_ROOT_SLUGS, LEGACY_URL_SLUG, PROJECT_SLUGS } from "../../netlify/functions/live-data.mjs";

const root = path.resolve(".");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

describe("project registry (node side)", () => {
  const registry = loadRegistry(root);

  it("every registered slug is valid and has config/projects/<slug>.json with matching identity", () => {
    expect(registry.length).toBeGreaterThan(0);
    for (const p of registry) {
      expect(SLUG_RE.test(p.slug), p.slug).toBe(true);
      const cfg = loadProjectConfig(p.slug, root);
      expect(cfg.slug).toBe(p.slug);
      expect(cfg.ticker).toBe(p.ticker);
      expect(cfg.name).toBe(p.name);
      expect(Array.isArray(cfg.chains) && cfg.chains.length > 0).toBe(true);
    }
  });

  it("live-data function constants match the registry (add the slug there too)", () => {
    expect([...PROJECT_SLUGS].sort()).toEqual(registry.map((p) => p.slug).sort());
    expect([...LEGACY_ROOT_SLUGS].sort()).toEqual(legacyRootSlugs(root).sort());
    expect(LEGACY_URL_SLUG).toBe(registry.find((p) => p.default)?.slug);
  });

  it("data dirs: TEL keeps the legacy root, others get public/data/<slug>", () => {
    expect(projectDataDir("tel", root)).toBe("public/data");
    expect(fs.existsSync(path.join(root, projectDataDir("tel", root), "holders-lite.json"))).toBe(true);
    for (const p of registry) {
      if (!legacyRootSlugs(root).includes(p.slug)) expect(projectDataDir(p.slug, root)).toBe(`public/data/${p.slug}`);
    }
  });

  it("tel.json addresses all come from the pipeline's own sources", () => {
    const tel = loadProjectConfig("tel", root);
    const chains = read("config/chains.json");
    const known = new Set(
      JSON.stringify(chains).match(/0x[0-9a-f]{40}/g).concat(read("config/exclusions.json").addresses),
    );
    const used = JSON.stringify(tel).match(/0x[0-9a-fA-F]{40}/g);
    expect(used.length).toBeGreaterThan(10);
    for (const a of used) expect(known.has(a), a).toBe(true);
    for (const c of tel.chains) {
      expect(c.chainId).toBe(chains[c.key].chainId);
      expect(c.tokens.find((t) => t.generation === "legacy").address).toBe(chains[c.key].tokens.legacy.address);
      expect(c.tokens.find((t) => t.generation === "v3").address).toBe(chains[c.key].tokens.v3.address);
    }
  });

  it("rejects malformed slugs", () => {
    expect(() => loadProjectConfig("../chains", root)).toThrow(/invalid/);
  });
});
