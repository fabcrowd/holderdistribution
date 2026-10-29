import { describe, expect, it } from "vitest";
import { copyContext, copyTextsByPrefix, fillCopy, hasTokenGenerations, joinList } from "./projectCopy";
import { getProject } from "./projects";

describe("projectCopy", () => {
  it("joins lists in house style", () => {
    expect(joinList([])).toBe("");
    expect(joinList(["A"])).toBe("A");
    expect(joinList(["A", "B"])).toBe("A and B");
    expect(joinList(["A", "B", "C"])).toBe("A, B and C");
  });

  it("derives TEL's copy context from config/projects/tel.json", () => {
    expect(copyContext(getProject("tel"))).toEqual({
      ticker: "TEL",
      name: "Telcoin",
      chains: "Ethereum, Polygon and Base",
      supply: "100B",
    });
  });

  it("fills known placeholders and leaves others alone", () => {
    const ctx = { ticker: "ABC", name: "Abacus", chains: "Ethereum", supply: "21M" };
    expect(fillCopy("{ticker} on {chains}: {supply} {name} {other}", ctx)).toBe("ABC on Ethereum: 21M Abacus {other}");
    expect(fillCopy("{ticker}/{ticker}", ctx)).toBe("ABC/ABC");
  });

  it("falls back when chains or supply are missing", () => {
    expect(copyContext({ ticker: "X", name: "X", chains: [], supply: undefined })).toMatchObject({
      chains: "every supported chain",
      supply: "total",
    });
  });

  it("detects multi-generation tokens", () => {
    expect(hasTokenGenerations(getProject("tel"))).toBe(true);
    expect(
      hasTokenGenerations({ chains: [{ key: "e", name: "E", chainId: 1, explorer: "", tokens: [{ generation: "v1", address: "0x", decimals: 18 }] }] }),
    ).toBe(false);
  });

  it("copyTextsByPrefix returns filled entries under the prefix, sorted, ignoring other ids", () => {
    const project = {
      ticker: "ABC",
      name: "Abacus",
      chains: [],
      copy: {
        text: {
          "treasury.note.2026-10-02": "second {ticker}",
          "treasury.note.2026-09-29": "first {ticker}",
          "treasury.history.info": "unrelated",
        },
      },
    };
    expect(copyTextsByPrefix(project, "treasury.note.")).toEqual([
      { suffix: "2026-09-29", text: "first ABC" },
      { suffix: "2026-10-02", text: "second ABC" },
    ]);
  });
});
