import { describe, expect, it } from "vitest";
import { chainExplorerLink, chainForAddress, explorerRoot, explorerTemplates, normalizeAddressForChain, resolveChainVm } from "@/lib/explorerLinks";
import { getProject, projectChainMeta, type ProjectChain } from "@/lib/projects";
import { projectTokenLinks, resolveHref } from "@/lib/methodology";
import { addressExplorerUrl } from "@/lib/walletFlowsTypes";
import { isChainStale } from "@/hooks/useChainStatus";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const solana: ProjectChain = { key: "solana", name: "Solana", vm: "solana", cluster: "mainnet-beta", tokens: [{ address: MINT, status: "canonical", generation: "legacy" }] };
const eth: ProjectChain = { key: "ethereum", name: "Ethereum", chainId: 1, explorer: "https://etherscan.io/", tokens: [{ address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", status: "canonical", generation: "legacy" }] };

describe("explorer links (vm-aware)", () => {
  it("resolves vm with an EVM default", () => {
    expect(resolveChainVm(eth)).toBe("evm");
    expect(resolveChainVm(solana)).toBe("solana");
    expect(resolveChainVm({ key: "solana" })).toBe("solana");
    expect(resolveChainVm(null)).toBe("evm");
  });

  it("Solana uses Solscan and never lowercases base58", () => {
    expect(explorerRoot(solana)).toBe("https://solscan.io");
    expect(chainExplorerLink(solana, "token", MINT, { lowercase: true })).toBe(`https://solscan.io/token/${MINT}`);
    expect(chainExplorerLink(solana, "address", OWNER)).toBe(`https://solscan.io/account/${OWNER}`);
    expect(chainExplorerLink(solana, "tx", "5sig")).toBe("https://solscan.io/tx/5sig");
    expect(normalizeAddressForChain(solana, ` ${OWNER} `)).toBe(OWNER);
  });

  it("explorerTemplates override defaults", () => {
    const c = { ...solana, explorerTemplates: { address: "https://explorer.solana.com/address/{address}" } };
    expect(explorerTemplates(c).address).toBe("https://explorer.solana.com/address/{address}");
    expect(chainExplorerLink(c, "address", OWNER)).toBe(`https://explorer.solana.com/address/${OWNER}`);
    expect(chainExplorerLink(c, "token", MINT)).toBe(`https://solscan.io/token/${MINT}`);
  });

  it("EVM links keep the historical shapes", () => {
    expect(chainExplorerLink(eth, "token", eth.tokens[0].address, { lowercase: true })).toBe(
      "https://etherscan.io/token/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    );
    expect(chainExplorerLink(eth, "address", "0xAbC")).toBe("https://etherscan.io/address/0xAbC");
    expect(normalizeAddressForChain(eth, "0xAbC")).toBe("0xabc");
  });
});

describe("Hedera links", () => {
  const hedera: ProjectChain = { key: "hedera", name: "Hedera", vm: "hedera", tokens: [] };

  it("resolves the vm and uses HashScan without lowercasing 0.0.N ids", () => {
    expect(resolveChainVm(hedera)).toBe("hedera");
    expect(explorerRoot(hedera)).toBe("https://hashscan.io/mainnet");
    expect(chainExplorerLink(hedera, "address", " 0.0.1234 ", { lowercase: true })).toBe("https://hashscan.io/mainnet/account/0.0.1234");
    expect(chainExplorerLink(hedera, "token", "0.0.5678")).toBe("https://hashscan.io/mainnet/token/0.0.5678");
    expect(chainExplorerLink(hedera, "tx", "0.0.1@1700000000.000000001")).toBe(
      "https://hashscan.io/mainnet/transaction/0.0.1@1700000000.000000001",
    );
    expect(normalizeAddressForChain(hedera, "0.0.1234")).toBe("0.0.1234");
  });

  it("explorerTemplates still override", () => {
    const c = { ...hedera, explorerTemplates: { address: "https://example.test/a/{address}" } };
    expect(chainExplorerLink(c, "address", "0.0.9")).toBe("https://example.test/a/0.0.9");
  });

  it("chainForAddress picks the vm's chain by address shape, preferring origin, and honours a preferred key", () => {
    const chains = [{ ...eth, origin: true }, solana, hedera];
    expect(chainForAddress(chains, "0xAbC0000000000000000000000000000000000001")?.key).toBe("ethereum");
    expect(chainForAddress(chains, OWNER)?.key).toBe("solana");
    expect(chainForAddress(chains, "0.0.1234")?.key).toBe("hedera");
    expect(chainForAddress(chains, OWNER, "hedera")?.key).toBe("hedera");
    expect(chainForAddress([eth], OWNER)?.key).toBe("ethereum");
    expect(chainForAddress([], OWNER)).toBeUndefined();
  });
});

describe("UI consumers with a Solana chain", () => {
  it("projectChainMeta", () => {
    expect(projectChainMeta({ chains: [eth, solana] })).toEqual([
      { key: "ethereum", label: "Ethereum", explorerUrl: "https://etherscan.io", tokenUrl: "https://etherscan.io/token/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
      { key: "solana", label: "Solana", explorerUrl: "https://solscan.io", tokenUrl: `https://solscan.io/token/${MINT}` },
    ]);
  });

  it("TEL chain meta is unchanged", () => {
    expect(projectChainMeta(getProject("tel")).map((c) => c.explorerUrl)).toEqual([
      "https://etherscan.io",
      "https://polygonscan.com",
      "https://basescan.org",
    ]);
  });

  it("methodology links", () => {
    const p = { ticker: "USDC", chains: [eth, solana], staking: [] };
    expect(projectTokenLinks(p)).toEqual([
      { label: "USDC on Etherscan", href: "https://etherscan.io/token/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
      { label: "USDC on Solscan", href: `https://solscan.io/token/${MINT}` },
    ]);
    expect(resolveHref(p, "{token:solana:legacy}")).toBe(`https://solscan.io/token/${MINT}`);
    expect(resolveHref(p, "{explorer:solana}")).toBe("https://solscan.io");
  });

  it("wallet-flow address links accept {address} templates", () => {
    expect(addressExplorerUrl("solana", OWNER, { solana: "https://solscan.io/account/{address}" })).toBe(`https://solscan.io/account/${OWNER}`);
    expect(addressExplorerUrl("arbitrum", "0xabc", { arbitrum: "https://arbiscan.io/" })).toBe("https://arbiscan.io/address/0xabc");
  });

  it("isChainStale only flags a scan more than an hour behind the feed", () => {
    const gen = "2026-10-25T12:00:00.000Z";
    expect(isChainStale({ lastBlock: 1 }, gen)).toBe(false);
    expect(isChainStale({ vm: "solana", scannedAt: "2026-10-25T11:30:00.000Z" }, gen)).toBe(false);
    expect(isChainStale({ vm: "solana", scannedAt: "2026-10-25T10:30:00.000Z" }, gen)).toBe(true);
    expect(isChainStale({ vm: "solana", scannedAt: "2026-10-25T10:30:00.000Z" }, null)).toBe(false);
  });
});
