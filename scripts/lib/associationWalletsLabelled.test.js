import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadRegistry, projectClassificationPath, projectRoleAddresses, resolveProject } from "./projects.js";

const root = path.resolve(__dirname, "../..");
const key = (address) => (/^0x/i.test(address) ? address.toLowerCase() : address);

// Wallets the owner has not yet ruled on. Each entry is debt: resolve it by
// labelling the wallet, then delete the entry (the test below fails if an
// entry is already labelled, so the list cannot go stale).
const PENDING_OWNER_DECISION = new Map([]);

const labelledAddresses = (project) => {
  const set = new Set();
  const file = projectClassificationPath(project, "exclusions", root);
  if (file && fs.existsSync(file)) {
    const exclusions = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const address of Object.keys(exclusions.labels ?? {})) set.add(key(address));
    for (const chain of Object.values(exclusions.chains ?? {})) {
      for (const address of Object.keys(chain.labels ?? {})) set.add(key(address));
    }
  }
  for (const entries of Object.values(projectRoleAddresses(project.config))) {
    for (const { address } of entries) set.add(key(address));
  }
  return set;
};

const associationWallets = () =>
  loadRegistry(root).flatMap(({ slug }) => {
    const ledgerPath = path.join(root, "config/projects", slug, "ledger.json");
    if (!fs.existsSync(ledgerPath)) return [];
    const project = resolveProject(slug, root);
    // No exclusions file is not a free pass: every association wallet then counts as retail unless a
    // contracts{} role covers it. A project whose ledger lists none is the only one with nothing to compare.
    const labelled = labelledAddresses(project);
    return (JSON.parse(fs.readFileSync(ledgerPath, "utf8")).developerWallets ?? [])
      .filter((w) => w.entityClass === "association")
      .map((w) => ({ id: `${slug}:${key(w.address)}`, label: w.label, labelled: labelled.has(key(w.address)) }));
  });

describe("association wallets are classified", () => {
  it("labels every ledger developerWallet of class association (else it counts as retail)", () => {
    const missing = associationWallets()
      .filter((w) => !w.labelled && !PENDING_OWNER_DECISION.has(w.id))
      .map((w) => `${w.id} (${w.label})`);
    expect(missing, `unlabelled Association wallets are counted as retail: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the pending-decision list free of wallets that are already labelled", () => {
    const stale = associationWallets().filter((w) => w.labelled && PENDING_OWNER_DECISION.has(w.id)).map((w) => w.id);
    expect(stale).toEqual([]);
  });
});
