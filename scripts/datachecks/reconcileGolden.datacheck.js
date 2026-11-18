// Data check (npm run check:data): moved from scripts/lib/reconcileGolden.test.js.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReconciliation } from "../lib/reconcileSupply.js";
import { resolveProject } from "../lib/projects.js";
import { projectExclusions, reconcileOptions, reconcilePaths } from "../reconcile-supply.js";

// check:data scope: HD_PROJECT is set by vitest.datacheck.config.ts ("" = every project).
const inScope = (...slugs) => !process.env.HD_PROJECT || slugs.includes(process.env.HD_PROJECT);

const repo = path.resolve(import.meta.dirname, "../..");
const read = (p, fallback) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback);

// Golden: reconciling each committed project from its committed inputs must
// reproduce its committed supply-reconciliation feed exactly. Guards the move
// of TEL-shaped defaults into per-project config.
describe.each(["tel", "zebec-network"])("supply reconciliation golden: %s", (slug) => {
  it.runIf(inScope(slug))("reproduces the committed feed", () => {
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
    // generatedAt is the write time (reconcile-supply.js main), not part of the reconciliation.
    expect(JSON.parse(JSON.stringify(out))).toEqual({ ...committed, generatedAt: undefined });
  });
});
