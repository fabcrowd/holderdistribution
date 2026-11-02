import { describe, expect, it, vi } from "vitest";
import { CallBudgetError, createCallBudget } from "./callBudget.js";

describe("createCallBudget", () => {
  it("allows exactly `limit` calls and refuses the next without calling through", async () => {
    const inner = vi.fn(async () => "ok");
    const budget = createCallBudget(inner, 3);
    await budget.call("getSlot", []);
    await budget.call("getSlot", []);
    await budget.call("getSlot", []);
    await expect(budget.call("getSlot", [])).rejects.toBeInstanceOf(CallBudgetError);
    expect(inner).toHaveBeenCalledTimes(3);
    expect(budget.used()).toBe(3);
  });

  it("propagates wrapped errors unchanged and counts the failed call", async () => {
    const boom = new Error("every RPC endpoint failed");
    const inner = vi.fn(async () => {
      throw boom;
    });
    const budget = createCallBudget(inner, 2);
    await expect(budget.call("getTransaction", ["sig"])).rejects.toBe(boom);
    expect(budget.used()).toBe(1);
    await expect(budget.call("getTransaction", ["sig"])).rejects.toBe(boom);
    await expect(budget.call("getTransaction", ["sig"])).rejects.toBeInstanceOf(CallBudgetError);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("flips exhausted() at the limit", async () => {
    const budget = createCallBudget(async () => null, 2);
    expect(budget.exhausted()).toBe(false);
    await budget.call("getSlot", []);
    expect(budget.exhausted()).toBe(false);
    await budget.call("getSlot", []);
    expect(budget.exhausted()).toBe(true);
    expect(budget.used()).toBe(2);
  });

  it("passes method, params and the result through", async () => {
    const budget = createCallBudget(async (method, params) => ({ method, params }), 1);
    await expect(budget.call("getSignaturesForAddress", ["A", { limit: 5 }])).resolves.toEqual({
      method: "getSignaturesForAddress",
      params: ["A", { limit: 5 }],
    });
  });
});
