import { describe, expect, it } from "vitest";
import { buildReconciliation } from "./reconcileSupply.js";
import { reconcileOptions } from "../reconcile-supply.js";
import { DEFAULT_CIRCULATING_SUBTRACT, resolveCirculatingSubtract, subtractedTotal } from "./circulatingSubtract.js";
import * as ui from "../../src/lib/circulatingSubtract.ts";
import tel from "../../config/projects/tel.json";
import zbcn from "../../config/projects/zebec-network.json";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const D = "0x" + "d".repeat(40);
const snapshot = {
  chainOrder: ["ethereum"],
  wallets: [A, B, C, D].map((address, i) => ({ address, ethereum_balance: [100, 50, 30, 20][i] })),
};
const labels = (extra = {}) => ({
  labels: {
    [A]: { category: "treasury", name: "T" },
    [B]: { category: "council", name: "C" },
    [C]: { category: "holdings", name: "H", ...extra },
  },
});
const run = (opts, ex = labels()) =>
  buildReconciliation(snapshot, ex, { wallets: [] }, { totalSupply: 200, ...opts });

describe("circulating subtract (config-driven)", () => {
  it("default subtracts treasury + council", () => {
    expect(run({}).circulating).toBe(200 - 150);
  });
  it("honours an explicit list", () => {
    expect(run({ circulatingSubtract: ["treasury"] }).circulating).toBe(200 - 100);
    expect(run({ circulatingSubtract: ["treasury", "holdings"] }).circulating).toBe(200 - 130);
    expect(run({ circulatingSubtract: [] }).circulating).toBe(200);
  });
  it("does not double-subtract duplicate keys", () => {
    expect(run({ circulatingSubtract: ["treasury", "treasury"] }).circulating).toBe(100);
  });
  it("still applies nonCirculatingOverride on top", () => {
    const r = run({ circulatingSubtract: ["treasury"] }, labels({ nonCirculatingOverride: 10 }));
    expect(r.circulating).toBe(200 - 100 - 10);
  });
  it("resolves default when config omits it, rejects malformed", () => {
    expect(resolveCirculatingSubtract({})).toEqual([...DEFAULT_CIRCULATING_SUBTRACT]);
    expect(resolveCirculatingSubtract(undefined)).toEqual(["treasury", "council"]);
    expect(resolveCirculatingSubtract({ circulating: { subtract: [] } })).toEqual([]);
    expect(() => resolveCirculatingSubtract({ circulating: { subtract: "treasury" } })).toThrow();
    expect(subtractedTotal({ treasury: 3, council: 4 }, ["treasury"])).toBe(3);
  });
  it("keeps today's definitions for TEL and ZBCN", () => {
    expect(reconcileOptions({ slug: "tel", config: tel }).circulatingSubtract).toEqual(["treasury", "council"]);
    expect(reconcileOptions({ slug: "zebec-network", config: zbcn }).circulatingSubtract).toEqual(["treasury"]);
  });
  it("UI and script defaults/resolution stay in parity", () => {
    expect(ui.DEFAULT_CIRCULATING_SUBTRACT).toEqual(DEFAULT_CIRCULATING_SUBTRACT);
    for (const s of [undefined, {}, { circulating: { subtract: ["team", "team"] } }]) {
      expect(ui.resolveCirculatingSubtract(s)).toEqual(resolveCirculatingSubtract(s));
    }
  });
});
