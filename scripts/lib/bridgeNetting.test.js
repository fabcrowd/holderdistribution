import { describe, expect, it, vi } from "vitest";
import { computeBridgeNettedSupply, computeSupplyTotals, selectSupplyMethod } from "./supply.js";
import { resolveProject } from "./projects.js";

const LOCK = "0x1111000000000000000000000000000000000000";
const A = "0xaaaa000000000000000000000000000000000000";
const B = "0xbbbb000000000000000000000000000000000000";
const SOL_ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOL_LOCK = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const quiet = () => ({ warn: vi.fn(), log: vi.fn() });

describe("supply method selection", () => {
  it("TEL keeps its generations path; everything else nets by bridge mode", () => {
    expect(selectSupplyMethod(resolveProject("tel").config)).toBe("tel-generations");
    expect(selectSupplyMethod({ chains: [] })).toBe("bridge-netting");
  });
});

describe("computeBridgeNettedSupply", () => {
  it("sums native + burn-mint supply, lock-mint adds nothing", () => {
    const chains = { ethereum: { origin: true }, base: { bridge: "burn-mint" }, solana: { vm: "solana", bridge: "native" }, polygon: { bridge: "lock-mint" } };
    const wallets = [
      { address: LOCK, ethereum_balance: 300, base_balance: 0, solana_balance: 0, polygon_balance: 0 },
      { address: A, ethereum_balance: 700, base_balance: 200, solana_balance: 0, polygon_balance: 300 },
      { address: SOL_ALICE, ethereum_balance: 0, base_balance: 0, solana_balance: 50, polygon_balance: 0 },
    ];
    const tokenTotals = { ethereum: { legacy: 1000 }, base: { legacy: 200 }, solana: { legacy: 50 }, polygon: { legacy: 300 } };
    const logger = quiet();
    const t = computeBridgeNettedSupply({ wallets }, chains, new Set([LOCK]), logger, tokenTotals);
    expect(t.method).toBe("bridge-netting");
    expect(t.totalSupply).toBe(1250); // 1000 origin + 200 burn-mint + 50 native; polygon's 300 is a mirror
    expect(t.bridgeLocked).toBe(300);
    expect(t.nonCirculating).toBe(300);
    expect(t.circulatingSupply).toBe(950);
    expect(t.backingResidual).toBe(0);
    expect(t.bridgeModes).toEqual({ ethereum: "origin", base: "burn-mint", solana: "native", polygon: "lock-mint" });
    expect(Object.values(t.byChain).reduce((s, v) => s + v, 0)).toBe(1250);
    expect(t.byChain).toEqual({ ethereum: 700, base: 200, solana: 50, polygon: 300 });
    expect(t.crossCheckTotal).toBe(1250);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns when lock-mint supply is not backed by labelled locks (>1%)", () => {
    const chains = { ethereum: { origin: true }, polygon: { bridge: "lock-mint" } };
    const wallets = [
      { address: LOCK, ethereum_balance: 100, polygon_balance: 0 },
      { address: A, ethereum_balance: 900, polygon_balance: 400 },
    ];
    const logger = quiet();
    const t = computeBridgeNettedSupply({ wallets }, chains, new Set([LOCK]), logger, { ethereum: { legacy: 1000 }, polygon: { legacy: 400 } }, { symbol: "MIX" });
    expect(t.totalSupply).toBe(1000);
    expect(t.backingResidual).toBe(300);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/300 MIX of lock-mint supply on \[polygon\] is not backed/));
  });

  it("all-native project with no origin (e.g. a Solana-only token) sums every chain", () => {
    const t = computeBridgeNettedSupply(
      { wallets: [{ address: SOL_ALICE, solana_balance: 40 }, { address: SOL_LOCK, solana_balance: 60 }] },
      { solana: { vm: "solana" } },
      new Set(),
      quiet(),
      { solana: { legacy: 100 } },
    );
    expect(t).toMatchObject({ totalSupply: 100, originChain: null, nonCirculating: 0, circulatingSupply: 100, byChain: { solana: 100 } });
  });

  it("matches base58 lock addresses exactly (no lowercasing)", () => {
    const chains = { solana: { vm: "solana", origin: true }, base: { bridge: "lock-mint" } };
    const wallets = [
      { address: SOL_LOCK, solana_balance: 30, base_balance: 0 },
      { address: SOL_ALICE, solana_balance: 70, base_balance: 0 },
      { address: B, solana_balance: 0, base_balance: 30 },
    ];
    const t = computeBridgeNettedSupply({ wallets }, chains, new Set([SOL_LOCK]), quiet(), { solana: { legacy: 100 }, base: { legacy: 30 } });
    expect(t.totalSupply).toBe(100);
    expect(t.bridgeLocked).toBe(30);
    expect(t.lockAddresses).toEqual([SOL_LOCK]);
    const wrongCase = computeBridgeNettedSupply({ wallets }, chains, new Set([SOL_LOCK.toLowerCase()]), quiet(), { solana: { legacy: 100 }, base: { legacy: 30 } });
    expect(wrongCase.bridgeLocked).toBe(0);
  });

  it("enforces supply.target only when set, and rejects lock-mint without origin", () => {
    const wallets = [{ address: A, ethereum_balance: 100 }];
    expect(() => computeBridgeNettedSupply({ wallets }, { ethereum: {} }, new Set(), quiet(), null, { target: 1000 })).toThrow(/supply.target/);
    expect(computeBridgeNettedSupply({ wallets }, { ethereum: {} }, new Set(), quiet(), null).totalSupply).toBe(100);
    expect(() => computeBridgeNettedSupply({ wallets }, { ethereum: {}, polygon: { bridge: "lock-mint" } }, new Set(), quiet())).toThrow(/no chain is marked origin/);
    expect(() => computeBridgeNettedSupply({ wallets }, { ethereum: { bridge: "wrapped" } }, new Set(), quiet())).toThrow(/unknown bridge/);
  });

  it("TEL regression: the generations path ignores chains[].bridge and is unchanged", () => {
    const chains = { ethereum: { origin: true }, polygon: { bridge: "native" }, base: {} };
    const wallets = [
      { address: LOCK, ethereum_balance: 38e9, polygon_balance: 0, base_balance: 0 },
      { address: A, ethereum_balance: 62e9, polygon_balance: 0, base_balance: 0 },
      { address: B, ethereum_balance: 0, polygon_balance: 36e9, base_balance: 2e9 },
    ];
    const withBridge = computeSupplyTotals({ wallets }, chains, new Set([LOCK]), quiet());
    const without = computeSupplyTotals({ wallets }, { ethereum: { origin: true }, polygon: {}, base: {} }, new Set([LOCK]), quiet());
    expect(withBridge).toEqual(without);
    expect(withBridge.totalSupply).toBe(100e9);
    expect(withBridge.method).toBeUndefined();
  });
});
