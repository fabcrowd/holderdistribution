import fs from "node:fs";
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

  it("an EVM-only project (TEL) never loads the Solana or Hedera module", async () => {
    const tel = resolveProject("tel");
    expect(projectHasVm(tel.config, "solana")).toBe(false);
    projectChainsAllVms(tel);
    projectChains(tel);
    await loadChainAdapter("evm");
    expect(loadedAdapterVms()).not.toContain("solana");
    expect(loadedAdapterVms()).not.toContain("hedera");
  });

  it("only the lazy loader and the pure address table reference lib/hedera (static, bare, multi-line or dynamic)", () => {
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) return p === "scripts/lib/hedera" ? [] : walk(p);
        return /\.(js|mjs|cjs|ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
      });
    // `from "x"`, `import "x"`, `import("x")`, `require("x")`; \s spans newlines, so multi-line imports match.
    const specifier = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]*\/hedera\/[^"'`]*)["'`]/g;
    const found = walk("scripts").flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(specifier)].map((m) => `${file} -> ${m[1]}`));
    expect(found.sort()).toEqual(["scripts/lib/address.js -> ./hedera/address.js", "scripts/lib/chainAdapters.js -> ./hedera/adapter.js"]);
    expect(fs.readFileSync("scripts/lib/chainAdapters.js", "utf8")).toMatch(/await import\("\.\/hedera\/adapter\.js"\)/);
    expect(fs.readFileSync("scripts/lib/address.js", "utf8")).toMatch(/^import \{ parseHederaAddress \} from "\.\/hedera\/address\.js";/m);
    const pure = fs.readFileSync("scripts/lib/hedera/address.js", "utf8");
    expect(pure).not.toMatch(/\bimport\b|\brequire\s*\(|process\.env|\bfetch\b/);
  });

  it("loads the Hedera adapter lazily on demand", async () => {
    const a = await loadChainAdapter("hedera");
    expect(a.vm).toBe("hedera");
    expect(loadedAdapterVms()).toContain("hedera");
    expect(typeof a.clock({}).firstAtOrAfter).toBe("function");
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
