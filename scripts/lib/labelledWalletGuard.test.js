import { describe, expect, it } from "vitest";
import { vanishedLabelledWallets } from "./labelledWalletGuard.js";

const SAFE = "0x84b94024463f01d5cbb3086f14f574d7ed83b794";
const CATEGORIES = ["treasury", "council", "holdings", "escrow"];
const labels = {
  [SAFE]: { category: "holdings", name: "Holdings Safe" },
  "0x1111111111111111111111111111111111111111": { category: "treasury", name: "Treasury" },
};
const prevTotals = { holdings: 1_000_000_000, treasury: 500_000_000 };

const run = (overrides) =>
  vanishedLabelledWallets({
    previous: { wallets: [{ address: SAFE, total_telcoin_balance: 275_000_000 }] },
    current: { wallets: [] },
    labels,
    categories: CATEGORIES,
    previousCategoryTotals: prevTotals,
    ...overrides,
  });

describe("vanishedLabelledWallets", () => {
  it("flags a material labelled wallet absent from today's snapshot", () => {
    expect(run()).toEqual([
      { address: SAFE, category: "holdings", name: "Holdings Safe", previousBalance: 275_000_000 },
    ]);
  });

  it("does not flag a wallet that is still present, even with a reduced balance", () => {
    const current = { wallets: [{ address: SAFE, total_telcoin_balance: 10 }] };
    expect(run({ current })).toEqual([]);
  });

  it("ignores wallets below minShare of their category total", () => {
    const previous = { wallets: [{ address: SAFE, total_telcoin_balance: 9_999_999 }] };
    expect(run({ previous })).toEqual([]);
  });

  it("does not flag addresses listed in allow", () => {
    expect(run({ allow: [SAFE.toUpperCase().replace("0X", "0x")] })).toEqual([]);
  });

  it("ignores labelled wallets outside the treasury categories", () => {
    const labelsNonTreasury = { [SAFE]: { category: "cex", name: "Binance" } };
    expect(run({ labels: labelsNonTreasury })).toEqual([]);
  });

  it("keeps base58 addresses case-sensitive when matching", () => {
    // Real Solana pubkey shape (base58, 32 bytes); a case-flipped copy is a different key.
    const SOL = "So11111111111111111111111111111111111111112";
    const solLabels = { [SOL]: { category: "treasury", name: "Sol Treasury" } };
    const previous = { wallets: [{ address: SOL, total_telcoin_balance: 100 }] };
    const categoriesTotals = { treasury: 100 };

    const stillThere = vanishedLabelledWallets({
      previous,
      current: { wallets: [{ address: SOL, total_telcoin_balance: 100 }] },
      labels: solLabels,
      categories: CATEGORIES,
      previousCategoryTotals: categoriesTotals,
    });
    expect(stillThere).toEqual([]);

    const flipped = SOL.toLowerCase();
    const missing = vanishedLabelledWallets({
      previous,
      current: { wallets: [{ address: flipped, total_telcoin_balance: 100 }] },
      labels: solLabels,
      categories: CATEGORIES,
      previousCategoryTotals: categoriesTotals,
    });
    expect(missing).toEqual([
      { address: SOL, category: "treasury", name: "Sol Treasury", previousBalance: 100 },
    ]);
  });
});
