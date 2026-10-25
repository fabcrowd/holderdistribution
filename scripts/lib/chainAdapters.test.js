import { describe, expect, it } from "vitest";
import {
  chainExplorerUrl,
  defaultExplorerTemplates,
  loadChainAdapter,
  loadedAdapterVms,
  projectHasVm,
  resolveChainBridge,
  resolveChainVm,
} from "./chainAdapters.js";
import { resolveProject, projectChains, projectChainsAllVms } from "./projects.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("chain adapter registry", () => {
  it("resolves vm and bridge with safe defaults", () => {
    expect(resolveChainVm({ key: "ethereum" })).toBe("evm");
    expect(resolveChainVm({ key: "solana" })).toBe("solana");
    expect(resolveChainVm({ key: "sol-main", vm: "solana" })).toBe("solana");
    expect(resolveChainBridge({ key: "polygon" })).toBe("native");
    expect(resolveChainBridge({ key: "polygon", bridge: "lock-mint" })).toBe("lock-mint");
  });

  it("an EVM-only project (TEL) never loads the Solana module", async () => {
    const tel = resolveProject("tel");
    expect(projectHasVm(tel.config, "solana")).toBe(false);
    projectChainsAllVms(tel);
    projectChains(tel);
    await loadChainAdapter("evm");
    expect(loadedAdapterVms()).not.toContain("solana");
  });

  it("loads the Solana adapter lazily on demand", async () => {
    const a = await loadChainAdapter("solana");
    expect(a.vm).toBe("solana");
    expect(loadedAdapterVms()).toContain("solana");
    await expect(loadChainAdapter("cosmos")).rejects.toThrow(/unknown chain vm/i);
  });

  it("builds explorer links: Solscan for Solana (case kept), root paths for EVM", () => {
    expect(defaultExplorerTemplates({ key: "solana" }).address).toBe("https://solscan.io/account/{address}");
    expect(chainExplorerUrl({ key: "solana" }, "token", MINT)).toBe(`https://solscan.io/token/${MINT}`);
    expect(chainExplorerUrl({ key: "solana" }, "tx", "5abc")).toBe("https://solscan.io/tx/5abc");
    expect(
      chainExplorerUrl({ key: "solana", explorerTemplates: { address: "https://explorer.solana.com/address/{address}" } }, "address", MINT),
    ).toBe(`https://explorer.solana.com/address/${MINT}`);
    expect(chainExplorerUrl({ key: "base", explorer: "https://basescan.org/" }, "address", "0x09BE1692ca16e06f536F0038fF11D1dA8524aDB1")).toBe("https://basescan.org/address/0x09be1692ca16e06f536f0038ff11d1da8524adb1");
  });
});
