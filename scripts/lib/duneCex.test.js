import { describe, it, expect } from "vitest";
import {
  cexVmForProject,
  extractCexRow,
  parseDuneCexRows,
  parseSpellbookCexSql,
  parseSpellbookEvmCexSql,
  mergeCexAdditions,
  intersectCexWithHolders,
  SPELLBOOK_CEX_SQL_URLS,
  spellbookUrlForVm,
} from "./duneCex.js";
import { normalizeAddressForVm } from "./address.js";

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

describe("parseSpellbookEvmCexSql", () => {
  const A1 = "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be";
  const A2 = "0xABCDEF0123456789abcdef0123456789ABCDEF01";
  const sql = `SELECT address, cex_name, distinct_name, added_by, added_date
FROM (VALUES
-- Binance
(${A1}, 'Binance', 'Binance 1', 'hildobby', date '2022-08-28')
,(  ${A2}  ,   'Binance US' ,'Binance US 2','hildobby', date '2022-08-28')
-- Coinbase
,(0x1111111111111111111111111111111111111111, 'Coin''base', 'Coin''base 1', 'x', date '2023-01-01')
,(${A1}, 'Other', 'Other 1', 'x', date '2023-01-01')
,(0x1234, 'Short', 'Short 1', 'x', date '2023-01-01')
,(0x2222222222222222222222222222222222222222, 'NoSecondName'
) AS x (address, cex_name, distinct_name, added_by, added_date)`;

  it("parses rows, lowercases, handles apostrophes and odd spacing, skips comments and malformed rows", () => {
    const rows = parseSpellbookEvmCexSql(sql);
    expect(rows).toEqual([
      { address: A1, cex_name: "Binance", distinct_name: "Binance 1" },
      { address: A2.toLowerCase(), cex_name: "Binance US", distinct_name: "Binance US 2" },
      { address: "0x1111111111111111111111111111111111111111", cex_name: "Coin'base", distinct_name: "Coin'base 1" },
      { address: A1, cex_name: "Other", distinct_name: "Other 1" },
    ]);
  });

  it("feeds parseDuneCexRows unchanged: duplicates collapse, first label wins", () => {
    const entries = parseDuneCexRows(parseSpellbookEvmCexSql(sql), "evm");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ address: A1, label: "Binance", walletName: "Binance 1" });
  });

  it("returns [] for empty/non-string input and exposes the EVM url", () => {
    expect(parseSpellbookEvmCexSql("")).toEqual([]);
    expect(parseSpellbookEvmCexSql(null)).toEqual([]);
    expect(SPELLBOOK_CEX_SQL_URLS.evm).toContain("cex_evms_addresses.sql");
  });
});

describe("spellbook sourcing is project-agnostic", () => {
  it("VM picks the URL; an unwired VM throws a clear error naming it", () => {
    expect(spellbookUrlForVm("evm")).toBe(SPELLBOOK_CEX_SQL_URLS.evm);
    expect(spellbookUrlForVm("solana")).toBe(SPELLBOOK_CEX_SQL_URLS.solana);
    expect(() => spellbookUrlForVm("move")).toThrow(/vm "move"/);
  });

  it("candidates path for a synthetic non-TEL EVM project (no chain/slug hardcoding)", () => {
    const project = { slug: "acme", config: { chains: [{ key: "arbitrum", vm: "evm" }, { key: "optimism" }] } };
    const vm = cexVmForProject(project);
    expect(vm).toBe("evm");
    const held = "0x" + "d".repeat(40);
    const sql = `(${held}, 'Kraken', 'Kraken 9', 'x', date '2024-01-01'),\n(0x${"e".repeat(40)}, 'OKX', 'OKX 1', 'x', date '2024-01-01')`;
    const entries = parseDuneCexRows(parseSpellbookEvmCexSql(sql), vm);
    const holders = [{ address: "0x" + "1".repeat(40), total_telcoin_balance: 900 }, { address: held, total_telcoin_balance: 100 }];
    expect(intersectCexWithHolders(entries, holders, { totalSupply: 1000 })).toEqual([
      { address: held, label: "Kraken", walletName: "Kraken 9", balance: 100, holderRank: 2, pctOfSupply: 10 },
    ]);
  });
});

describe("mergeCexAdditions", () => {
  const norm = (v) => normalizeAddressForVm("evm", v);
  const a = "0x" + "a".repeat(40);
  const b = "0x" + "b".repeat(40);
  const c = "0x" + "c".repeat(40);

  it("adds only net-new addresses and leaves existing entries untouched", () => {
    const existing = [{ address: a.toUpperCase().replace("0X", "0x"), label: "Kraken", walletName: "Kraken 1" }];
    const before = JSON.stringify(existing);
    const entries = [
      { address: a, label: "Other", walletName: "Other 1" },
      { address: b, label: "Binance", walletName: "Binance 1" },
    ];
    const out = mergeCexAdditions(existing, entries, norm);
    expect(out.additions).toEqual([entries[1]]);
    expect(out.repaired).toBe(0);
    expect(out.wallets).toEqual([existing[0], entries[1]]);
    expect(JSON.stringify(existing)).toBe(before);
  });

  it("repairs Unknown labels only when the source has a real label", () => {
    const existing = [
      { address: a, label: "Unknown", walletName: "Unknown" },
      { address: c, label: "Unknown", walletName: "Unknown" },
    ];
    const entries = [{ address: a, label: "OKX", walletName: "OKX 1" }];
    const out = mergeCexAdditions(existing, entries, norm);
    expect(out.repaired).toBe(1);
    expect(out.additions).toEqual([]);
    expect(out.wallets).toEqual([{ address: a, label: "OKX", walletName: "OKX 1" }, existing[1]]);
  });

  it("handles empty/missing inputs", () => {
    expect(mergeCexAdditions(undefined, undefined, norm)).toEqual({ wallets: [], additions: [], repaired: 0 });
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
