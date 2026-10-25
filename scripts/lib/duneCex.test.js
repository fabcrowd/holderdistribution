import { describe, it, expect } from "vitest";
import {
  cexVmForProject,
  extractCexRow,
  parseDuneCexRows,
  parseSpellbookCexSql,
  intersectCexWithHolders,
} from "./duneCex.js";

const SOL_A = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const SOL_B = "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w"; // 43 chars, still 32 bytes
const EVM = "0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE";

describe("extractCexRow", () => {
  it("EVM path is unchanged: hex lowercased, Solana dropped", () => {
    expect(extractCexRow({ address: EVM, cex_name: "Binance", distinct_name: "Binance 1" }, "evm")).toEqual({
      address: EVM.toLowerCase(),
      label: "Binance",
      walletName: "Binance 1",
    });
    expect(extractCexRow({ address: SOL_A, cex_name: "Binance" }, "evm")).toBeNull();
  });

  it("Solana path keeps base58 exactly (never lowercased) and drops hex", () => {
    const r = extractCexRow({ address: SOL_A, cex_name: "Binance", distinct_name: "Binance 1", blockchain: "solana" }, "solana");
    expect(r.address).toBe(SOL_A);
    expect(r.walletName).toBe("Binance 1");
    expect(extractCexRow({ address: SOL_A.toLowerCase(), cex_name: "x" }, "solana")?.address).not.toBe(SOL_A);
    expect(extractCexRow({ address: EVM, cex_name: "x" }, "solana")).toBeNull();
    expect(extractCexRow({ address: SOL_B, cex_name: "Gate.io" }, "solana").address).toBe(SOL_B);
  });

  it("honours a blockchain column: a row tagged for another chain is skipped", () => {
    expect(extractCexRow({ address: SOL_A, cex_name: "x", blockchain: "ethereum" }, "solana")).toBeNull();
    expect(extractCexRow({ address: EVM, cex_name: "x", blockchain: "solana" }, "evm")).toBeNull();
    expect(extractCexRow({ address: EVM, cex_name: "x", blockchain: "base" }, "evm")).not.toBeNull();
  });

  it("parseDuneCexRows dedupes by address, first label wins", () => {
    const out = parseDuneCexRows(
      [
        { address: SOL_A, cex_name: "Binance", distinct_name: "Binance 1" },
        { address: SOL_A, cex_name: "Other" },
        { address: "nope", cex_name: "x" },
      ],
      "solana",
    );
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Binance");
  });
});

describe("cexVmForProject", () => {
  it("solana-only project -> solana; TEL/EVM -> evm", () => {
    expect(cexVmForProject({ config: { chains: [{ key: "solana", vm: "solana" }] } })).toBe("solana");
    expect(cexVmForProject({ config: { chains: [{ key: "ethereum" }, { key: "polygon", vm: "evm" }] } })).toBe("evm");
    expect(cexVmForProject({ config: { data: { legacyRoot: true } } })).toBe("evm");
  });
});

describe("parseSpellbookCexSql", () => {
  it("reads the static VALUES rows of a spellbook cex_<chain>_addresses model", () => {
    const sql = `SELECT blockchain, address, cex_name, distinct_name, added_by, added_date
FROM (VALUES
    ('solana', '${SOL_A}', 'Binance', 'Binance 1', 'hildobby', date '2024-04-19')
    , ('solana', '${SOL_B}', 'Gate.io', 'Gate.io 6', 'hildobby', date '2024-04-19')

    , ('solana', 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'Coinbase', 'Coinbase''s 1', 'x', date '2025-07-07')
    ) AS x (blockchain, address, cex_name, distinct_name, added_by, added_date)`;
    const rows = parseSpellbookCexSql(sql);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      blockchain: "solana",
      address: SOL_A,
      cex_name: "Binance",
      distinct_name: "Binance 1",
      added_by: "hildobby",
      added_date: "2024-04-19",
    });
    expect(rows[2].distinct_name).toBe("Coinbase's 1");
  });
});

describe("intersectCexWithHolders", () => {
  it("returns only labelled addresses that hold the token, with rank + balance", () => {
    const entries = [
      { address: SOL_A, label: "Binance", walletName: "Binance 1" },
      { address: SOL_B, label: "Gate.io", walletName: "Gate.io 6" },
    ];
    const holders = [
      { address: "5rhms6jZQaXnQc6wbicnrxDTkKqKi4iwfWW3612r5rHb", total_telcoin_balance: 100 },
      { address: SOL_B, total_telcoin_balance: 50 },
    ];
    const out = intersectCexWithHolders(entries, holders, { totalSupply: 1000 });
    expect(out).toEqual([
      { address: SOL_B, label: "Gate.io", walletName: "Gate.io 6", balance: 50, holderRank: 2, pctOfSupply: 5 },
    ]);
  });

  it("matching is case-sensitive for base58", () => {
    const out = intersectCexWithHolders(
      [{ address: SOL_A, label: "x", walletName: "x" }],
      [{ address: SOL_A.toLowerCase(), total_telcoin_balance: 1 }],
    );
    expect(out).toEqual([]);
  });
});
