/**
 * Golden test for `mapWorkflowFiles` on the real TEL project. Every list is the
 * exact argument list a workflow passes to `node scripts/workflow-paths.js files`
 * (.github/workflows). The expected arrays pin TEL's commit-path output, so a
 * change to the mapping must leave TEL byte-identical.
 *
 * The files are created in a temp root (the real config/ is copied in, so the
 * TEL registry entry is the real one). Two named files stay absent to exercise
 * the drop-missing-paths rule. The result therefore does not depend on which
 * local data files happen to exist.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mapWorkflowFiles } from "./workflow-paths.js";
import { resolveProject } from "./lib/projects.js";

const repo = path.resolve(".");

const CASES = {
  backfillTreasuryCexHistory: ["public/data/treasury-history.json", "public/data/cex-balance-history.json", "data/holders-asof-blocks.json"],
  detectCexCandidates: ["data/cex-candidates.json"],
  fillHistoryGaps: ["public/data/holders-history.json", "public/data/date-blocks.json", "data/holders-asof-blocks.json"],
  generateTierOutflows: [
    "public/data/tier-outflows.json", "data/tier-outflows-days.json", "data/tier-outflows-checkpoint.json",
    "public/data/exchange-flow-checkpoint.json", "data/hedera-flow-days.json", "data/tier-counterparty-days", "public/data/date-blocks.json",
  ],
  pipelineWatchdog: [
    "public/data/funding-wallets.json", "public/data/tel-holders.json", "public/data/holders-summary.json", "public/data/holders-history.json",
    "public/data/cex-wallets.json", "public/data/cex-flows.json", "public/data/cex-balance-history.json", "public/data/holders-lite.json",
    "public/data/holders-checkpoint.json", "public/data/chain-status.json", "public/data/holder-transitions.json", "public/data/holders-ever-checkpoint.json",
    "public/data/supply-reconciliation.json", "public/data/treasury-history.json", "public/data/classification-changelog.json",
    "public/data/exchange-flow-history.json", "public/data/exchange-flow-checkpoint.json", "public/data/date-blocks.json",
  ],
  rebuildHoldersHistorySolana: ["public/data/holders-history.json", "public/data/holders-ever-checkpoint.json", "data/holders-replay-solana.checkpoint.json"],
  rebuildHoldersHistory: ["public/data/holders-history.json", "public/data/holders-ever-checkpoint.json", "public/data/date-blocks.json"],
  recomputeHoldersHistory: ["public/data/holders-history.json", "public/data/cex-balance-history.json", "public/data/holders-ever-checkpoint.json"],
  refreshHoldersCommit: [
    "public/data/funding-wallets.json", "public/data/tel-holders.json", "public/data/holders-summary.json", "public/data/holders-history.json",
    "public/data/cex-wallets.json", "public/data/cex-flows.json", "public/data/cex-balance-history.json", "public/data/holders-lite.json",
    "public/data/holders-checkpoint.json", "public/data/chain-status.json", "public/data/holder-transitions.json", "public/data/holders-ever-checkpoint.json",
    "public/data/supply-reconciliation.json", "public/data/treasury-history.json", "public/data/classification-changelog.json", "public/data/date-blocks.json",
    "data/holders-asof-blocks.json",
  ],
  refreshHoldersDownstream: [
    "public/data/exchange-flow-history.json", "public/data/exchange-flow-checkpoint.json", "public/data/tier-outflows.json", "data/tier-outflows-days.json",
    "data/tier-outflows-checkpoint.json", "data/solana-flow-days.json", "data/hedera-flow-days.json", "data/tier-counterparty-days",
    "public/data/holders-history.json", "data/holders-asof-blocks.json", "public/data/date-blocks.json", "data/rpc-usage.json", "public/data/pipeline-status.json",
  ],
  refreshStakerBalances: ["public/data/funding-wallets.json"],
  refreshWalletFlows: ["data/forensics/wallet-flows.json"],
  scanExchangeFlows: ["public/data/exchange-flow-history.json", "public/data/exchange-flow-checkpoint.json", "data/hedera-flow-days.json", "public/data/date-blocks.json"],
  syncCexWalletsCheck: ["config/cex-wallets.json", "public/data/cex-wallets.json", "public/data/cex-flows.json", "data/cex-dune-candidates.json"],
  syncCexWalletsAdd: [
    "config/cex-wallets.json", "public/data/cex-wallets.json", "public/data/cex-flows.json", "data/cex-dune-candidates.json",
    "public/data/tel-holders.json", "public/data/holders-summary.json", "public/data/holders-lite.json", "public/data/holders-history.json",
    "public/data/holder-transitions.json", "public/data/supply-reconciliation.json", "public/data/treasury-history.json",
    "public/data/classification-changelog.json", "public/data/cex-balance-history.json",
  ],
};

const ABSENT = new Set(["data/cex-candidates.json", "data/forensics/wallet-flows.json"]);

const EXPECTED = {
  backfillTreasuryCexHistory: ["public/data/treasury-history.json", "public/data/cex-balance-history.json", "data/holders-asof-blocks.json"],
  detectCexCandidates: [],
  fillHistoryGaps: ["public/data/holders-history.json", "public/data/date-blocks.json", "data/holders-asof-blocks.json"],
  generateTierOutflows: [
    "public/data/tier-outflows.json", "data/tier-outflows-days.json", "data/tier-outflows-checkpoint.json",
    "public/data/exchange-flow-checkpoint.json", "data/hedera-flow-days.json", "data/tier-counterparty-days", "public/data/date-blocks.json",
  ],
  pipelineWatchdog: [
    "public/data/funding-wallets.json", "public/data/tel-holders.json", "public/data/holders-summary.json", "public/data/holders-history.json",
    "public/data/cex-wallets.json", "public/data/cex-flows.json", "public/data/cex-balance-history.json", "public/data/holders-lite.json",
    "public/data/holders-checkpoint.json", "public/data/chain-status.json", "public/data/holder-transitions.json", "public/data/holders-ever-checkpoint.json",
    "public/data/supply-reconciliation.json", "public/data/treasury-history.json", "public/data/classification-changelog.json",
    "public/data/exchange-flow-history.json", "public/data/exchange-flow-checkpoint.json", "public/data/date-blocks.json",
  ],
  rebuildHoldersHistorySolana: ["public/data/holders-history.json", "public/data/holders-ever-checkpoint.json", "data/holders-replay-solana.checkpoint.json"],
  rebuildHoldersHistory: ["public/data/holders-history.json", "public/data/holders-ever-checkpoint.json", "public/data/date-blocks.json"],
  recomputeHoldersHistory: ["public/data/holders-history.json", "public/data/cex-balance-history.json", "public/data/holders-ever-checkpoint.json"],
  refreshHoldersCommit: [
    "public/data/funding-wallets.json", "public/data/tel-holders.json", "public/data/holders-summary.json", "public/data/holders-history.json",
    "public/data/cex-wallets.json", "public/data/cex-flows.json", "public/data/cex-balance-history.json", "public/data/holders-lite.json",
    "public/data/holders-checkpoint.json", "public/data/chain-status.json", "public/data/holder-transitions.json", "public/data/holders-ever-checkpoint.json",
    "public/data/supply-reconciliation.json", "public/data/treasury-history.json", "public/data/classification-changelog.json", "public/data/date-blocks.json",
    "data/holders-asof-blocks.json",
  ],
  refreshHoldersDownstream: [
    "public/data/exchange-flow-history.json", "public/data/exchange-flow-checkpoint.json", "public/data/tier-outflows.json", "data/tier-outflows-days.json",
    "data/tier-outflows-checkpoint.json", "data/solana-flow-days.json", "data/hedera-flow-days.json", "data/tier-counterparty-days",
    "public/data/holders-history.json", "data/holders-asof-blocks.json", "public/data/date-blocks.json", "data/rpc-usage.json", "public/data/pipeline-status.json",
  ],
  refreshStakerBalances: ["public/data/funding-wallets.json"],
  refreshWalletFlows: [],
  scanExchangeFlows: ["public/data/exchange-flow-history.json", "public/data/exchange-flow-checkpoint.json", "data/hedera-flow-days.json", "public/data/date-blocks.json"],
  syncCexWalletsCheck: ["config/cex-wallets.json", "public/data/cex-wallets.json", "public/data/cex-flows.json", "data/cex-dune-candidates.json"],
  syncCexWalletsAdd: [
    "config/cex-wallets.json", "public/data/cex-wallets.json", "public/data/cex-flows.json", "data/cex-dune-candidates.json",
    "public/data/tel-holders.json", "public/data/holders-summary.json", "public/data/holders-lite.json", "public/data/holders-history.json",
    "public/data/holder-transitions.json", "public/data/supply-reconciliation.json", "public/data/treasury-history.json",
    "public/data/classification-changelog.json", "public/data/cex-balance-history.json",
  ],
};

describe("mapWorkflowFiles golden: TEL commit paths match the workflow file lists", () => {
  let root;
  let tel;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-golden-"));
    fs.cpSync(path.join(repo, "config"), path.join(root, "config"), { recursive: true });
    for (const f of new Set(Object.values(CASES).flat())) {
      if (ABSENT.has(f)) continue;
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), "{}");
    }
    tel = resolveProject("tel", root);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses the real TEL registry entry (legacyRoot, public/data, data/)", () => {
    expect(tel.slug).toBe("tel");
    expect(tel.config.data.legacyRoot).toBe(true);
    expect(tel.dataDir).toBe("public/data");
  });

  for (const name of Object.keys(CASES)) {
    it(`${name}: exact TEL output`, () => {
      expect(mapWorkflowFiles(tel, CASES[name], root)).toEqual(EXPECTED[name]);
    });
  }
});
