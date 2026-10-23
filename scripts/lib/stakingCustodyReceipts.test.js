import { describe, it, expect } from "vitest";
import { attributeStakingReceipts } from "./stakingCustody.js";

const C = "0xcustody";

describe("attributeStakingReceipts", () => {
  it("moves custodied TEL to stakers and keeps the total unchanged", () => {
    const balances = new Map([[C, 300], ["0xa", 10]]);
    const v3 = new Map([[C, 300]]);
    const r = attributeStakingReceipts(balances, C, new Map([["0xa", 100], ["0xb", 200]]), v3);
    expect(balances.get("0xa")).toBe(110);
    expect(balances.get("0xb")).toBe(200);
    expect(balances.get(C)).toBe(0);
    expect(v3.get("0xa")).toBe(100);
    expect(v3.get(C)).toBe(0);
    expect([...balances.values()].reduce((s, v) => s + v, 0)).toBe(310);
    expect(r).toMatchObject({ held: 300, attributed: 300, residual: 0, stakers: 2, overAttributed: 0 });
  });

  it("leaves the unattributed remainder (e.g. pending withdrawals) on the contract", () => {
    const balances = new Map([[C, 500]]);
    const r = attributeStakingReceipts(balances, C, new Map([["0xa", 400]]));
    expect(balances.get(C)).toBe(100);
    expect(r.residual).toBe(100);
  });

  it("never invents TEL when receipts exceed custody: scales down and reports it", () => {
    const balances = new Map([[C, 100]]);
    const r = attributeStakingReceipts(balances, C, new Map([["0xa", 150], ["0xb", 50]]));
    expect(balances.get("0xa")).toBeCloseTo(75);
    expect(balances.get("0xb")).toBeCloseTo(25);
    expect(balances.get(C)).toBe(0);
    expect(r.overAttributed).toBe(100);
    expect([...balances.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(100);
  });

  it("ignores self-receipts, zero and non-finite positions", () => {
    const balances = new Map([[C, 50]]);
    const r = attributeStakingReceipts(balances, C, new Map([[C, 10], ["0xa", 0], ["0xb", NaN], ["0xc", 20]]));
    expect(r.stakers).toBe(1);
    expect(balances.get("0xc")).toBe(20);
    expect(balances.get(C)).toBe(30);
    expect(balances.has("0xa")).toBe(false);
  });
});
