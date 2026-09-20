import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeAddress,
  loadNonRetailSet,
  createNonRetailChecker,
} from "./nonRetailSet.js";

const writeJson = (filePath, data) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

describe("nonRetailSet", () => {
  it("normalises valid addresses and rejects junk", () => {
    expect(normalizeAddress(" 0xAbcDef0123456789abcdef0123456789abcdef01 ")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
    expect(normalizeAddress("not-an-address")).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
  });

  it("merges exclusions, CEX, and DEX pools/routers into one set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "non-retail-"));
    const exclusionsPath = path.join(dir, "exclusions.json");
    const cexPath = path.join(dir, "cex-wallets.json");
    const dexPath = path.join(dir, "dex-contracts.json");

    writeJson(exclusionsPath, {
      addresses: ["0x1111111111111111111111111111111111111111"],
      chains: {
        polygon: { addresses: ["0x2222222222222222222222222222222222222222"] },
      },
    });
    writeJson(cexPath, {
      wallets: [{ address: "0x3333333333333333333333333333333333333333", label: "Exchange" }],
    });
    writeJson(dexPath, {
      pools: [{ address: "0x4444444444444444444444444444444444444444", chain: "polygon" }],
      routers: [{ address: "0x5555555555555555555555555555555555555555", name: "Router" }],
    });

    const { set, sizes } = await loadNonRetailSet({ exclusionsPath, cexPath, dexPath });
    expect(sizes.exclusions).toBe(2);
    expect(sizes.cex).toBe(1);
    expect(sizes.dex).toBe(2);
    expect(sizes.total).toBe(5);

    const isNonRetail = createNonRetailChecker(set);
    expect(isNonRetail("0x1111111111111111111111111111111111111111")).toBe(true);
    expect(isNonRetail("0x4444444444444444444444444444444444444444")).toBe(true);
    expect(isNonRetail("0x9999999999999999999999999999999999999999")).toBe(false);
  });

  it("includes the four polygon DEX pools that were previously missing from exclusions", async () => {
    const { set } = await loadNonRetailSet();
    const pools = [
      "0xa5cabfc725dfa129f618d527e93702d10412f039",
      "0xe88e24f49338f974b528ace10350ac4576c5c8a1",
      "0x4917bc6b8e705ad462ef525937e7eb7c6c87c356",
      "0x9b5c71936670e9f1f36e63f03384de7e06e60d2a",
    ];
    for (const pool of pools) {
      expect(set.has(pool), `missing pool ${pool}`).toBe(true);
    }
  });
});
