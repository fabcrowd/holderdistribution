import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectHasVm } from "./chainAdapters.js";
import { loadNonRetailSet } from "./nonRetailSet.js";
import { loadRegistry, projectClassificationPath, projectDataPath, projectNonRetailPaths, projectRoleAccounts, resolveProject } from "./projects.js";
import { buildReconciliation } from "./reconcileSupply.js";
import { projectExclusions, reconcileOptions } from "../reconcile-supply.js";

const root = path.resolve(__dirname, "../..");

const solanaProjects = loadRegistry(root)
  .map(({ slug }) => resolveProject(slug, root))
  .filter((project) => projectHasVm(project.config, "solana"));

// Every Solana project must classify the owner of a contracts{} role token account
// (staking vault, treasury) as non-retail in the committed snapshot, exactly as the
// account itself (the holder row of a token account is its owner wallet). Checked on
// both consumers: the shared non-retail set and the supply reconciliation's itemised
// non-retail addresses. tel-holders.json lists every holder, so retail is decided by those.
describe("Solana role-account owners are never retail", () => {
  it("has at least one Solana project to check", () => {
    expect(solanaProjects.length).toBeGreaterThan(0);
  });

  it.each(solanaProjects.map((project) => [project.slug, project]))("%s: owners of contracts{} role accounts are non-retail", async (_slug, project) => {
    const file = projectDataPath(project, "tel-holders.json", root);
    // pipeline.feedsPending is banned (goLive.js), so every registry project is live: its snapshot must exist.
    expect(fs.existsSync(file), `${project.slug}: ${file} is missing`).toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    const { set } = await loadNonRetailSet(projectNonRetailPaths(project, root, snapshot));
    const owners = Object.values(projectRoleAccounts(project.config, snapshot.tokenAccountOwnersByChain))
      .flat()
      .filter((entry) => entry.owner);

    const readOptional = (p, fallback) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback);
    const exclusions = readOptional(projectClassificationPath(project, "exclusions", root), { addresses: [], labels: {} });
    const cexWallets = readOptional(projectClassificationPath(project, "cexWallets", root), { wallets: [] });
    const reconciled = buildReconciliation(snapshot, projectExclusions(project, exclusions, snapshot), cexWallets, { ...reconcileOptions(project), coingeckoCirculating: null });
    const itemised = new Set(reconciled.items.map((item) => item.address));
    // An owner with no holder row (balance moved out to stakers) has nothing to itemise.
    const holderRows = new Set((snapshot.wallets ?? []).map((wallet) => wallet.address));

    const leaked = owners
      .filter(({ owner }) => !set.has(owner) || (holderRows.has(owner) && !itemised.has(owner)))
      .map(({ name, address, owner }) => `${name} ${address} -> owner ${owner}`);
    expect(leaked, `token-account owners counted as retail: ${leaked.join("; ")}`).toEqual([]);
  });
});
