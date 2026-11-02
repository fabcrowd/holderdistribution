import { describe, it, expect } from "vitest";
import { deriveRegistry, parseConfidence } from "./forensicsRegistry.js";

const ADDR_A = "Tr4sVbC9xQ2mLpWz7YkHnD5fGj8RuE3aBcXy1MpKqWe";
const ADDR_B = "9hQwErTyUiPpAsDfGhJkLzXcVbNm2345678ABCDEFGHj";
const ADDR_C = "3MnBvCxZkKjHgFdSaPuYtReWq1234567898abcdefgh";
const ADDR_D = "6kLpRiUyTrEwQaSdFgHjKZxCvBnM1234567899zyxwvut";

const fixture = {
  slug: "demo",
  ticker: "DMO",
  chains: [
    {
      key: "solana",
      vm: "solana",
      contracts: {
        a: {
          address: ADDR_A,
          role: "treasury",
          $comment: "Owner-approved (high confidence). https://solscan.io/account/X",
        },
        b: { address: ADDR_B, role: "holdings", $comment: "(medium)" },
        c: { address: ADDR_C, role: "holdings" },
        d: { address: ADDR_D, role: "dex" },
        e: { address: ADDR_A, role: "holdings", $comment: "duplicate of a" },
        f: { address: ADDR_A.toLowerCase(), role: "holdings" },
      },
    },
  ],
};

describe("parseConfidence", () => {
  it("returns the first confidence word, lowercased", () => {
    expect(parseConfidence("Owner-approved (HIGH confidence)")).toBe("high");
    expect(parseConfidence("(medium)")).toBe("medium");
    expect(parseConfidence("medium, not high")).toBe("medium");
  });

  it("returns low when no word matches or the comment is not a string", () => {
    expect(parseConfidence("no signal here")).toBe("low");
    expect(parseConfidence(undefined)).toBe("low");
    expect(parseConfidence(42)).toBe("low");
  });
});

describe("deriveRegistry", () => {
  const registry = deriveRegistry(fixture);
  const byAddress = (address) => registry.knownWallets.find((w) => w.address === address);

  it("returns version 1 with a null botCluster and empty lists", () => {
    expect(registry.version).toBe(1);
    expect(registry.botCluster).toBeNull();
    expect(registry.watchedSellers).toEqual([]);
    expect(registry.extraCex).toEqual([]);
    expect(registry.extraDex).toEqual([]);
  });

  it("excludes roles other than treasury and holdings", () => {
    expect(byAddress(ADDR_D)).toBeUndefined();
  });

  it("maps role to group and entityClass and tags the chain", () => {
    const a = byAddress(ADDR_A);
    expect(a.group).toBe("treasury");
    expect(a.entityClass).toBe("treasury");
    expect(a.chains).toEqual(["solana"]);
  });

  it("derives confidence from the comment, defaulting to low", () => {
    expect(byAddress(ADDR_A).confidence).toBe("high");
    expect(byAddress(ADDR_B).confidence).toBe("medium");
    expect(byAddress(ADDR_C).confidence).toBe("low");
  });

  it("extracts the solscan URL as source, else falls back to the project config path", () => {
    expect(byAddress(ADDR_A).source).toBe("https://solscan.io/account/X");
    expect(byAddress(ADDR_B).source).toBe("config/projects/demo.json");
  });

  it("builds a fallback label from ticker, role and shortened address", () => {
    expect(byAddress(ADDR_C).label).toBe(`DMO holdings ${ADDR_C.slice(0, 4)}…${ADDR_C.slice(-4)}`);
  });

  it("removes exact duplicate addresses, keeping the first", () => {
    const matches = registry.knownWallets.filter((w) => w.address === ADDR_A);
    expect(matches).toHaveLength(1);
    expect(matches[0].group).toBe("treasury");
  });

  it("keeps addresses that differ only in case, with case preserved for Solana", () => {
    const lower = ADDR_A.toLowerCase();
    expect(registry.knownWallets.map((w) => w.address)).toEqual(expect.arrayContaining([ADDR_A, lower]));
    expect(registry.knownWallets.filter((w) => w.address.toLowerCase() === lower)).toHaveLength(2);
  });

  it("filters to a single chain when chainKey is given", () => {
    expect(deriveRegistry(fixture, { chainKey: "solana" }).knownWallets).toHaveLength(registry.knownWallets.length);
    expect(deriveRegistry(fixture, { chainKey: "ethereum" }).knownWallets).toEqual([]);
  });
});
