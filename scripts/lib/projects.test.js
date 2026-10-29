import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  defaultProjectSlug,
  legacyRootSlugs,
  loadProjectConfig,
  loadRegistry,
  parseProjectArg,
  pipelineProject,
  projectDataDir,
  projectStakingContracts,
  resolveProject,
  SLUG_RE,
} from "./projects.js";
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

  it("live-data function derives slugs from the registry; registry legacyRoot matches each project config", () => {
    expect([...PROJECT_SLUGS].sort()).toEqual(registry.map((p) => p.slug).sort());
    expect([...LEGACY_ROOT_SLUGS].sort()).toEqual(legacyRootSlugs(root).sort());
    expect(LEGACY_URL_SLUG).toBe(registry.find((p) => p.default)?.slug);
    for (const p of registry) expect(p.legacyRoot === true, p.slug).toBe(loadProjectConfig(p.slug, root).data?.legacyRoot === true);
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

describe("pipeline --project selection", () => {
  const root = path.resolve(".");
  it("takes the default from the registry, never a literal", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-default-"));
    fs.mkdirSync(path.join(tmp, "config"), { recursive: true });
    const write = (projects) => fs.writeFileSync(path.join(tmp, "config/projects.json"), JSON.stringify({ projects }));
    try {
      write([{ slug: "alpha" }, { slug: "beta", default: true }]);
      expect(defaultProjectSlug(tmp)).toBe("beta");
      write([]);
      expect(() => defaultProjectSlug(tmp)).toThrow(/no default project/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("defaults to the registry default (tel) when the flag and env are absent", () => {
    expect(defaultProjectSlug(root)).toBe("tel");
    expect(parseProjectArg([], {}, root)).toBe("tel");
    expect(parseProjectArg(["--days=14"], {}, root)).toBe("tel");
  });

  it("accepts --project slug and --project=slug, flag beats HD_PROJECT env", () => {
    expect(parseProjectArg(["--project", "abc"], {}, root)).toBe("abc");
    expect(parseProjectArg(["--days=3", "--project=abc"], {}, root)).toBe("abc");
    expect(parseProjectArg([], { HD_PROJECT: "abc" }, root)).toBe("abc");
    expect(parseProjectArg(["--project=TEL"], { HD_PROJECT: "abc" }, root)).toBe("tel");
    expect(parseProjectArg([], { HD_PROJECT: "  " }, root)).toBe("tel");
  });

  it("rejects a missing or malformed slug", () => {
    expect(() => parseProjectArg(["--project"], {}, root)).toThrow(/needs a slug/);
    expect(() => parseProjectArg(["--project", "--days=3"], {}, root)).toThrow(/needs a slug/);
    expect(() => parseProjectArg(["--project="], {}, root)).toThrow(/needs a slug/);
    expect(() => parseProjectArg(["--project=../etc"], {}, root)).toThrow(/invalid project slug/);
  });

  it("resolveProject checks the registry and returns the data dir", () => {
    expect(resolveProject("tel", root)).toMatchObject({ slug: "tel", dataDir: "public/data", isDefault: true });
    expect(resolveProject("tel", root).config.ticker).toBe("TEL");
    expect(() => resolveProject("nope", root)).toThrow(/unknown project "nope"/);
  });

  it("pipelineProject only lets legacyRoot projects through", () => {
    expect(pipelineProject("t", { argv: [], env: {}, root }).slug).toBe("tel");
    expect(() => pipelineProject("t", { argv: ["--project", "nope"], env: {}, root })).toThrow(/unknown project/);

    // A registered, non-legacy project is refused until its scripts are ported.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hd-proj-"));
    fs.mkdirSync(path.join(tmp, "config/projects"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "config/projects.json"), JSON.stringify({ projects: [
      { slug: "tel", default: true }, { slug: "abc" },
    ] }));
    fs.writeFileSync(path.join(tmp, "config/projects/tel.json"), JSON.stringify({ slug: "tel", data: { legacyRoot: true } }));
    fs.writeFileSync(path.join(tmp, "config/projects/abc.json"), JSON.stringify({ slug: "abc" }));
    expect(resolveProject("abc", tmp).dataDir).toBe("public/data/abc");
    expect(() => pipelineProject("pull", { argv: ["--project=abc"], env: {}, root: tmp })).toThrow(/pull: project "abc" is not wired/);
    expect(pipelineProject("pull", { argv: [], env: {}, root: tmp }).dataDir).toBe("public/data");
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

it("projectStakingContracts keeps Solana base58 case", () => {
  const zbcn = resolveProject("zebec-network", root);
  expect(projectStakingContracts(zbcn, { kind: "zebecStakeV1" })[0].address).toBe("zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv");
});

it("ZBCN AMM pool custody accounts are dex-role contracts keyed by the token-account owner", () => {
  const orca = "FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w";
  const cfg = loadProjectConfig("zebec-network", root);
  const addresses = Object.values(cfg.chains[0].contracts)
    .filter((c) => c.role === "dex")
    .map((c) => c.address);
  expect(new Set(addresses).size).toBe(addresses.length);
  // Orca WSOL-ZBCN plus Meteora DLMM/DAMM, Raydium CLMM, extra Orca and Boop custody found 2026-10-28.
  expect(addresses).toHaveLength(13);
  expect(addresses).toContain(orca);
  // Every newly labelled dex address is itemised in the reclassification changelog.
  const log = read("config/projects/zebec-network/classification-changelog.json");
  const event = log.events.find((e) => e.id === "2026-10-28-zbcn-dex-pools");
  expect([...event.addresses].sort()).toEqual(addresses.filter((a) => a !== orca).sort());
});
