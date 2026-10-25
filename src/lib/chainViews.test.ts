import { describe, expect, it } from "vitest";
import { getProject, type ProjectConfig } from "./projects";
import {
  chainViewKeys,
  chainViewLabel,
  chainViewOptions,
  coerceChainView,
  isChainView,
  projectChainKeys,
  stakingElsewhereNote,
} from "./chainViews";
import { readSettings } from "./historyNav";
import { addressExplorerUrl } from "./walletFlowsTypes";

const tel = getProject("tel");

// A demo project on four chains, one of which (arbitrum) TEL does not have.
const demo: ProjectConfig = {
  slug: "demo",
  name: "Demo",
  ticker: "DMO",
  chains: [
    { key: "ethereum", name: "Ethereum", chainId: 1, explorer: "https://etherscan.io", tokens: [] },
    { key: "arbitrum", name: "Arbitrum One", chainId: 42161, explorer: "https://arbiscan.io/", tokens: [] },
    { key: "polygon", name: "Polygon", chainId: 137, explorer: "https://polygonscan.com", tokens: [] },
    { key: "base", name: "Base", chainId: 8453, explorer: "https://basescan.org", tokens: [] },
  ],
  staking: [{ chain: "arbitrum", address: "0x1", name: "Demo staking" }],
};

describe("chain views: TEL unchanged", () => {
  it("keys and order are combined, ethereum, polygon, base", () => {
    expect(projectChainKeys(tel)).toEqual(["ethereum", "polygon", "base"]);
    expect(chainViewKeys(tel)).toEqual(["combined", "ethereum", "polygon", "base"]);
  });

  it("labels match the old hard-coded maps", () => {
    expect(chainViewOptions(tel)).toEqual([
      { key: "combined", label: "Combined" },
      { key: "ethereum", label: "Ethereum" },
      { key: "polygon", label: "Polygon" },
      { key: "base", label: "Base" },
    ]);
    expect(chainViewOptions(tel, "All chains")[0]).toEqual({ key: "combined", label: "All chains" });
    expect(chainViewLabel(tel, "polygon")).toBe("Polygon");
    expect(chainViewLabel(tel, "combined")).toBe("Combined");
  });

  it("staking note: Polygon only, as before", () => {
    expect(stakingElsewhereNote(tel, "ethereum")).toBe("Staking runs on Polygon");
    expect(stakingElsewhereNote(tel, "base")).toBe("Staking runs on Polygon");
    expect(stakingElsewhereNote(tel, "polygon")).toBeNull();
    expect(stakingElsewhereNote(tel, "combined")).toBeNull();
  });

  it("URL ?chain= accepts TEL's chains and rejects others", () => {
    expect(readSettings("?chain=base", [30])).toEqual({ range: null, chain: "base" });
    expect(readSettings("?chain=arbitrum", [30])).toEqual({ range: null, chain: null });
  });

  it("wallet-flow explorer links are unchanged for TEL chains", () => {
    expect(addressExplorerUrl("polygon", "0xa")).toBe("https://polygonscan.com/address/0xa");
    expect(addressExplorerUrl("base", "0xa", { base: "https://other" })).toBe("https://basescan.org/address/0xa");
  });
});

describe("chain views: multi-chain demo project", () => {
  it("adds the extra chain in config order", () => {
    expect(chainViewKeys(demo)).toEqual(["combined", "ethereum", "arbitrum", "polygon", "base"]);
    expect(chainViewOptions(demo).map((o) => o.label)).toEqual(["Combined", "Ethereum", "Arbitrum One", "Polygon", "Base"]);
    expect(isChainView(demo, "arbitrum")).toBe(true);
    expect(isChainView(tel, "arbitrum")).toBe(false);
  });

  it("falls back to combined for a chain the project lacks", () => {
    expect(coerceChainView(tel, "arbitrum")).toBe("combined");
    expect(coerceChainView(demo, "arbitrum")).toBe("arbitrum");
    expect(coerceChainView(demo, 42)).toBe("combined");
  });

  it("URL ?chain= validates against the given project's chains", () => {
    expect(readSettings("?chain=arbitrum", [30], chainViewKeys(demo)).chain).toBe("arbitrum");
    expect(readSettings("?chain=solana", [30], chainViewKeys(demo)).chain).toBeNull();
  });

  it("staking note names the project's staking chain", () => {
    expect(stakingElsewhereNote(demo, "ethereum")).toBe("Staking runs on Arbitrum One");
    expect(stakingElsewhereNote(demo, "arbitrum")).toBeNull();
    expect(stakingElsewhereNote({ ...demo, staking: [] }, "ethereum")).toBeNull();
    expect(
      stakingElsewhereNote({ ...demo, staking: [...demo.staking!, { chain: "base", address: "0x2", name: "b" }] }, "ethereum"),
    ).toBe("Staking runs on Arbitrum One and Base");
  });

  it("wallet-flow links use the project's explorer for non-built-in chains", () => {
    const explorers = Object.fromEntries(demo.chains.map((c) => [c.key, c.explorer ?? ""]));
    expect(addressExplorerUrl("arbitrum", "0xa", explorers)).toBe("https://arbiscan.io/address/0xa");
    expect(addressExplorerUrl("arbitrum", "0xa")).toBe("https://etherscan.io/address/0xa");
  });
});

describe("chain views: no hard-coded chain unions left", () => {
  it("src/ has no combined|ethereum|polygon|base literal union", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [p] : [];
      });
    const offenders = walk(resolve(__dirname, "..")).filter((p) =>
      /"(combined|all)"\s*\|\s*"ethereum"\s*\|\s*"polygon"\s*\|\s*"base"/.test(readFileSync(p, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
