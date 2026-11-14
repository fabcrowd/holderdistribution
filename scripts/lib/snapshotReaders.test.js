import { describe, expect, it } from "vitest";
import { buildSnapshotData } from "./holdersView.js";
import { hydrateChainHolders, serializeSnapshot } from "./snapshotFormat.js";

const legacySingleChain = () => ({
  generatedAt: "2026-11-14T00:00:00.000Z",
  thresholds: { retail: 1000, megaHolder: 2_000_000_000 },
  totals: { totalSupply: 10_000 },
  chains: {
    hedera: {
      key: "hedera",
      name: "Hedera",
      metrics: { holderCount: 3, totalBalance: 1500 },
      holders: [
        { address: "0.0.1", balance: 1200 },
        { address: "0.0.3", balance: 200 },
        { address: "0.0.4", balance: 100 },
      ],
    },
  },
  combined: { holderCount: 3 },
  wallets: [
    { address: "0.0.9", hedera_balance: 5000, total_telcoin_balance: 5000 },
    { address: "0.0.1", hedera_balance: 1200, total_telcoin_balance: 1200 },
    { address: "0.0.3", hedera_balance: 200, total_telcoin_balance: 200 },
    { address: "0.0.4", hedera_balance: 100, total_telcoin_balance: 100 },
  ],
  chainOrder: ["hedera"],
  source: { type: "rpc" },
});

describe("snapshot readers see the same data from a slim snapshot", () => {
  it("buildSnapshotData matches for legacy and slim forms", () => {
    const legacy = legacySingleChain();
    const slim = JSON.parse(serializeSnapshot(legacy));
    expect(slim.chains.hedera.holders).toBeUndefined();
    const call = (s) => buildSnapshotData(s, null, () => false);
    expect(call(slim)).toEqual(call(legacy));
  });

  it("hydrate on a slim snapshot reproduces the holders the CLI readers iterate", () => {
    // generate-holder-transitions.js and generate-tier-outflows.js are CLI files with no
    // importable function; they read `chain.holders` after hydrateChainHolders.
    const legacy = legacySingleChain();
    const slim = JSON.parse(serializeSnapshot(legacy));
    expect(hydrateChainHolders(slim).chains.hedera.holders).toEqual(legacy.chains.hedera.holders);
  });
});
