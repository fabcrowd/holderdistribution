import { describe, expect, it } from "vitest";
import { HEDERA_UNRELEASED_RANGES, WHBAR_CONTRACT, hederaChainContracts, hederaTreasuryAccounts, hederaTreasuryExclusions } from "./treasury.js";
import { hederaAdapter } from "./adapter.js";
import { parseHederaAddress } from "./address.js";

describe("hedera network treasury", () => {
  it("lists every id of the corrected unreleased ranges plus 98, 800 and 801, once each", () => {
    const ids = hederaTreasuryAccounts().map((a) => a.address);
    expect(new Set(ids).size).toBe(ids.length);
    const rangeIds = HEDERA_UNRELEASED_RANGES.reduce((n, r) => n + r.to - r.from + 1, 0);
    expect(ids).toHaveLength(rangeIds + 3);
    expect(ids).toEqual(expect.arrayContaining(["0.0.2", "0.0.42", "0.0.400", "0.0.750", "0.0.98", "0.0.800", "0.0.801"]));
    for (const id of ids) expect(parseHederaAddress(id)).toBe(id);
  });

  it("leaves 0.0.900-1000, 0.0.43, 0.0.72 and 0.0.802 circulating", () => {
    const ids = new Set(hederaTreasuryAccounts().map((a) => a.address));
    for (const id of ["0.0.900", "0.0.950", "0.0.1000", "0.0.43", "0.0.72", "0.0.802", "0.0.1"]) expect(ids.has(id), id).toBe(false);
  });

  it("writes an exclusions file whose every address carries a treasury label", () => {
    const ex = hederaTreasuryExclusions();
    expect(Object.keys(ex.labels).sort()).toEqual([...ex.addresses].sort());
    for (const l of Object.values(ex.labels)) expect(l).toMatchObject({ category: "treasury", evidenceTier: "owner-supplied" });
  });

  it("tags WHBAR as dex, and the adapter hands all of it to onboarding", async () => {
    expect(hederaChainContracts().whbar).toMatchObject({ address: WHBAR_CONTRACT, role: "dex" });
    const cls = await hederaAdapter.nativeClassification();
    expect(cls.exclusions.addresses).toHaveLength(hederaTreasuryAccounts().length);
    expect(cls.treasuryCategories).toEqual(["treasury"]);
    expect(cls.workflowTimeoutMinutes).toBeGreaterThan(93);
  });

  it("seeds a CEX list of valid, unique 0.0.N accounts, each with a source, none also treasury", async () => {
    const { wallets } = (await hederaAdapter.nativeClassification()).cexWallets;
    const ids = wallets.map((w) => w.address);
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of wallets) {
      expect(parseHederaAddress(w.address)).toBe(w.address);
      expect(w.label && w.walletName && w.$comment, w.address).toBeTruthy();
    }
    expect(wallets.find((w) => w.address === "0.0.615421")).toMatchObject({ label: "Bybit", $comment: expect.stringMatching(/proof-of-reserves/) });
    expect(ids).not.toContain("0.0.640701");
    const treasury = new Set(hederaTreasuryAccounts().map((a) => a.address));
    expect(ids.filter((id) => treasury.has(id))).toEqual([]);
  });
});
