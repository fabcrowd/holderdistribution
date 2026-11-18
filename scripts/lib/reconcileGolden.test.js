import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildReconciliation } from "./reconcileSupply.js";
import { reconcileOptions } from "../reconcile-supply.js";

// The golden (each committed project reproduces its committed supply-reconciliation
// feed) runs in `npm run check:data` (scripts/datachecks/reconcileGolden.datacheck.js).
// Its code-side guard here: a characterization of buildReconciliation on a trimmed
// sample of each project's real inputs (one row per category, every override and
// bridge lock, a few retail rows) against the output recorded when the sample was cut.
describe.each(["tel", "zebec-network"])("supply reconciliation characterization: %s", (slug) => {
  it("reproduces the output recorded for a trimmed sample of the committed inputs", () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/reconcile", `${slug}.json`), "utf8"));
    const { snapshot, exclusions, cexWallets, options } = fixture.input;
    expect(JSON.parse(JSON.stringify(buildReconciliation(snapshot, exclusions, cexWallets, options)))).toEqual(fixture.expected);
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
