import { describe, expect, it } from "vitest";
import { attributeStakedBalances, residualCustodyBalance } from "./stakingCustody.js";

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

describe("attributeStakedBalances (legacy StakeChanged staking, funding-wallets.json)", () => {
  const CONTRACT = "0xstaking";

  it("credits every staker and retires the same amount from the contract", () => {
    const balances = new Map([[CONTRACT, 1000], ["0xa", 5]]);
    const r = attributeStakedBalances(balances, CONTRACT, [["0xa", 600], ["0xb", 300]]);
    expect(balances.get("0xa")).toBe(605);
    expect(balances.get("0xb")).toBe(300);
    expect(balances.get(CONTRACT)).toBe(100); // unplaced remainder, counted once
    expect(r).toMatchObject({ held: 1000, requested: 900, attributed: 900, residual: 100, stakers: 2, overAttributed: 0, scale: 1 });
  });

  it("a stale feed asking for more than the contract holds is scaled down: no TEL invented (2026-11-27)", () => {
    // Run 45975348118: funding-wallets.json from 2026-11-26 asked for 626,934,075 TEL;
    // the contract held 612,281,814. Crediting it in full put counted supply 14.1M TEL
    // above total supply and the TEL supply breakdown lost its "Supply gap" bucket.
    const held = 612_281_814;
    const asked = [["0xa", 400_000_000], ["0xb", 226_934_075]];
    const balances = new Map([[CONTRACT, held], ["0xother", 7]]);
    const before = [...balances.values()].reduce((s, v) => s + v, 0);
    const r = attributeStakedBalances(balances, CONTRACT, asked);
    const after = [...balances.values()].reduce((s, v) => s + v, 0);
    expect(after).toBeCloseTo(before, 3); // the chain total is unchanged
    expect(balances.get(CONTRACT)).toBe(0);
    expect(r.overAttributed).toBe(626_934_075 - held);
    expect(r.attributed).toBeCloseTo(held, 3);
    expect(balances.get("0xa") / balances.get("0xb")).toBeCloseTo(400_000_000 / 226_934_075, 9); // pro rata
  });

  it("with no custody balance in the map, positions are credited as given (unchanged behaviour)", () => {
    const balances = new Map();
    const r = attributeStakedBalances(balances, CONTRACT, [["0xa", 10]]);
    expect(balances.get("0xa")).toBe(10);
    expect(balances.has(CONTRACT)).toBe(false);
    expect(r).toMatchObject({ held: 0, attributed: 10, scale: 1, overAttributed: 0 });
  });

  it("skips zero, negative, non-finite and self positions", () => {
    const balances = new Map([[CONTRACT, 100]]);
    const r = attributeStakedBalances(balances, CONTRACT, [["0xa", 0], ["0xb", -1], ["0xc", Number.NaN], [CONTRACT, 50], ["0xd", 10]]);
    expect(r.stakers).toBe(1);
    expect(balances.get(CONTRACT)).toBe(90);
    expect(balances.has("0xa")).toBe(false);
  });
});
