import { describe, expect, it } from "vitest";
import { scanContractIds } from "./scan.js";

describe("scanContractIds", () => {
  it("retries a transient 404 from the list endpoint instead of failing the whole scan", async () => {
    let failed = false;
    const client = {
      getPage: async (path) => {
        if (!failed) {
          failed = true;
          return { body: null, status: 404, clusterId: null };
        }
        const probe = /gt:0\.0\.5(&|$)/.test(path);
        return { body: { contracts: probe ? [] : [{ contract_id: "0.0.5" }], links: { next: null } }, clusterId: null };
      },
    };
    const ids = await scanContractIds(client, { maxId: 10, width: 100, concurrency: 1 });
    expect([...ids]).toEqual([5]);
    expect(failed).toBe(true);
  }, 15_000);
});
