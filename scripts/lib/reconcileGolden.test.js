import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReconciliation } from "./reconcileSupply.js";
import { resolveProject } from "./projects.js";
import { projectExclusions, reconcileOptions, reconcilePaths } from "../reconcile-supply.js";

const repo = path.resolve(import.meta.dirname, "../..");
const read = (p, fallback) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback);

// Golden: reconciling each committed project from its committed inputs must
// reproduce its committed supply-reconciliation feed exactly. Guards the move
// of TEL-shaped defaults into per-project config.
describe.each(["tel", "zebec-network"])("supply reconciliation golden: %s", (slug) => {
  it("reproduces the committed feed", () => {
    const project = resolveProject(slug, repo);
    const paths = reconcilePaths(project, repo);
    const committed = read(paths.output);
    const snapshot = read(paths.holders);
    const exclusions = read(paths.exclusions, { addresses: [], labels: {} });
    const cex = read(paths.cexWallets, { wallets: [] });
    const out = buildReconciliation(snapshot, projectExclusions(project, exclusions, snapshot), cex, {
      ...reconcileOptions(project),
      coingeckoCirculating: committed.coingeckoCirculating ?? null,
    });
    expect(JSON.parse(JSON.stringify(out))).toEqual(committed);
  });
});

describe("supply reconciliation: third project with no TEL/ethereum assumption", () => {
  const project = {
    slug: "third",
    config: { supply: { target: 1_000 }, chains: [{ key: "near", name: "NEAR", origin: true }] },
  };

  it("reconciles from the project's own chain list when the snapshot names none", () => {
    const snapshot = { wallets: [{ address: "alice.near", near_balance: 600 }, { address: "bob.near", near_balance: 400 }] };
    const r = buildReconciliation(snapshot, { labels: {} }, { wallets: [] }, { ...reconcileOptions(project), coingeckoCirculating: null });
    expect(r.totalSupply).toBe(1_000);
    expect(r.counted).toBe(1_000);
    expect(r.residual).toBe(0);
    expect(r.derivedOriginTotal).toBe(1_000);
    expect(r.mirrored).toBe(0);
    expect(r.upgrade).toBeUndefined();
  });

  it("takes the declared origin, not the first chain", () => {
    const two = { config: { supply: { target: 100 }, chains: [{ key: "a" }, { key: "b", origin: true }] } };
    expect(reconcileOptions(two)).toMatchObject({ chains: ["a", "b"], origin: "b" });
  });

  it("requires a supply target", () => {
    expect(() => reconcileOptions({ slug: "x", config: { chains: [] } })).toThrow(/supply.target/);
  });
});
