import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const chains = JSON.parse(fs.readFileSync(path.join(root, "config/chains.json"), "utf8"));
const uiSource = fs.readFileSync(path.join(root, "src/lib/telContracts.ts"), "utf8");

// Pinned from the official sources (see docs/TEL-CONTRACTS.md):
//  - https://tel3.telcoin.network/faqs and /bridge (Telcoin Association upgrade portal)
//  - https://github.com/Telcoin-Association/tel-v3 (deployments/{ethereum,polygon,base}.json)
// and confirmed on-chain (name/symbol/decimals and the immutable wiring between contracts).
const OFFICIAL = {
  v3: "0x7e13b43065380acdec1c2d138c579cbbbafa0731",
  legacy: {
    ethereum: "0x467bccd9d29f223bce8043b84e8c8b282827790f",
    polygon: "0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32",
    base: "0x09be1692ca16e06f536f0038ff11d1da8524adb1",
  },
  contracts: {
    tokenMigration: "0x2703e00cae30a7707e4d18c38f8cb6a4a40c2703",
    migrationVault: "0x222213deb441c5a9f71df2942db431978a733333",
    telcoinBridge: "0x6a7e6616653e84eee0c70257ec2e3d79a4476a7e",
    mintBurnWrapper: "0x4a1c2ab0661651ee55c41db1239f292e00c3d149",
  },
};
const EXPLORER = {
  ethereum: "https://etherscan.io",
  polygon: "https://polygonscan.com",
  base: "https://basescan.org",
};
const ADDR = /^0x[a-f0-9]{40}$/;

describe("TEL contract registry (config/chains.json)", () => {
  it("keeps the pipeline's tokenAddress/decimals pointing at the legacy contract", () => {
    for (const [key, chain] of Object.entries(chains)) {
      expect(chain.tokenAddress, key).toBe(OFFICIAL.legacy[key]);
      expect(chain.decimals, key).toBe(2);
      expect(chain.tokens.legacy.address, key).toBe(chain.tokenAddress);
      expect(chain.tokens.legacy.decimals, key).toBe(chain.decimals);
    }
  });

  it("maps TEL v3 as one 18-decimal address shared by every chain", () => {
    const v3Addresses = new Set();
    for (const [key, chain] of Object.entries(chains)) {
      const v3 = chain.tokens.v3;
      expect(v3.address, key).toMatch(ADDR);
      expect(v3.address, key).toBe(OFFICIAL.v3);
      expect(v3.decimals, key).toBe(18);
      expect(v3.status, key).toBe("canonical");
      expect(chain.tokens.legacy.status, key).toBe("deprecated");
      expect(v3.explorer.token, key).toBe(`${EXPLORER[key]}/token/${OFFICIAL.v3}`);
      v3Addresses.add(v3.address);
    }
    expect(v3Addresses.size).toBe(1);
  });

  it("never lets the v3 or upgrade-contract addresses collide with a legacy token", () => {
    const legacy = new Set(Object.values(chains).map((c) => c.tokens.legacy.address));
    for (const chain of Object.values(chains)) {
      expect(legacy.has(chain.tokens.v3.address)).toBe(false);
      for (const c of Object.values(chain.contracts)) expect(legacy.has(c.address)).toBe(false);
    }
  });

  it("maps the official upgrade and bridge contracts on every chain", () => {
    for (const [key, chain] of Object.entries(chains)) {
      expect(Object.keys(chain.contracts).sort(), key).toEqual(Object.keys(OFFICIAL.contracts).sort());
      for (const [name, expected] of Object.entries(OFFICIAL.contracts)) {
        const entry = chain.contracts[name];
        expect(entry.address, `${key}.${name}`).toMatch(ADDR);
        expect(entry.address, `${key}.${name}`).toBe(expected);
        expect(entry.explorer, `${key}.${name}`).toBe(`${EXPLORER[key]}/address/${expected}`);
      }
    }
  });

  it("keeps src/lib/telContracts.ts in lockstep with config/chains.json", () => {
    expect(uiSource).toContain(`TEL_V3_ADDRESS = "${OFFICIAL.v3}"`);
    for (const [key, address] of Object.entries(OFFICIAL.legacy)) {
      expect(uiSource, `legacy ${key}`).toContain(`${key}: "${address}"`);
    }
    for (const [name, address] of Object.entries(OFFICIAL.contracts)) {
      expect(uiSource, name).toContain(`${name}: "${address}"`);
    }
    for (const [key, chain] of Object.entries(chains)) {
      expect(uiSource, key).toContain(`${key}: "${EXPLORER[key]}"`);
      expect(chain.explorer.token, key).toBe(`${EXPLORER[key]}/token/${chain.tokenAddress}`);
    }
  });
});
