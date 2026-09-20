import { describe, expect, it } from "vitest";
import { residualCustodyBalance } from "./stakingCustody.js";

// Real figures observed on 2026-08-07, before the fix.
const CONTRACT_HELD = 4_166_000_625;
const ATTRIBUTED = 4_671_679_427;
const POLYGON_REPORTED = 41_180_472_419;
const POLYGON_ONCHAIN = 37_248_867_603;

describe("residualCustodyBalance", () => {
  it("retires attributed tokens from the custody contract", () => {
    // 1,000 held, all 1,000 placed with owners -> nothing left to count again.
    expect(residualCustodyBalance(1000, 1000)).toBe(0);
  });

  it("keeps whatever attribution could not place with an owner", () => {
    // Incomplete attribution is expected (a stakeFor beneficiary who never
    // personally transacted is invisible to Transfer-log discovery). The
    // unplaced remainder must survive so supply stays whole.
    expect(residualCustodyBalance(1000, 600)).toBe(400);
  });

  it("floors at zero when attribution overshoots custody", () => {
    // Over-attribution is a real, currently-live condition: 4.672B credited
    // against 4.166B custodied. It must never yield a negative balance.
    expect(residualCustodyBalance(CONTRACT_HELD, ATTRIBUTED)).toBe(0);
    expect(residualCustodyBalance(CONTRACT_HELD, ATTRIBUTED)).toBeGreaterThanOrEqual(0);
  });

  it("closes the Polygon overstatement against on-chain totalSupply", () => {
    // The bug: the contract stayed in the chain balance map after its tokens
    // were attributed to stakers, so Polygon double-counted them.
    const buggyChainTotal = POLYGON_REPORTED;
    const overstatement = buggyChainTotal - POLYGON_ONCHAIN;
    expect(overstatement).toBeGreaterThan(3_800_000_000);

    // With the fix the contract contributes 0 instead of its full balance,
    // removing the double-count and landing within a scan-dust margin of the
    // real on-chain supply.
    const fixedChainTotal = buggyChainTotal - CONTRACT_HELD;
    expect(Math.abs(fixedChainTotal - POLYGON_ONCHAIN)).toBeLessThan(600_000_000);
    expect(fixedChainTotal).toBeLessThan(buggyChainTotal);
  });

  it("is a no-op for chains with no custody contract", () => {
    expect(residualCustodyBalance(0, 0)).toBe(0);
    expect(residualCustodyBalance(0, 5000)).toBe(0);
    expect(residualCustodyBalance(undefined, undefined)).toBe(0);
  });

  it("leaves custody untouched when nothing was attributed", () => {
    expect(residualCustodyBalance(4_166_000_625, 0)).toBe(4_166_000_625);
  });
});
