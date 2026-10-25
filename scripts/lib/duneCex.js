/**
 * Pure helpers for CEX wallet lists sourced from Dune (`cex.addresses`) or the
 * public Dune spellbook model that backs it.
 *
 * Address handling is VM-aware: EVM rows keep the historical behaviour
 * (0x-hex only, lowercased) so TEL's config/cex-wallets.json is untouched;
 * Solana rows are base58 public keys kept EXACTLY as written (case-sensitive,
 * never lowercased) — lowercasing a base58 key turns it into a different key.
 */
import { normalizeAddressForVm } from "./address.js";

/** Raw spellbook model for Solana CEX labels (what Dune serves as cex_solana.addresses / cex.addresses). */
export const SPELLBOOK_CEX_SQL_URLS = {
  solana:
    "https://raw.githubusercontent.com/duneanalytics/spellbook/main/dbt_subprojects/hourly_spellbook/models/_sector/cex/addresses/chains/solana/cex_solana_addresses.sql",
};

/** "solana" when every chain the project maps is Solana; otherwise "evm" (TEL and any EVM project). */
export function cexVmForProject(project) {
  const chains = project?.config?.chains;
  if (!Array.isArray(chains) || chains.length === 0) return "evm";
  return chains.every((c) => c?.vm === "solana") ? "solana" : "evm";
}

const pick = (row, keys) => {
  for (const k of keys) if (row?.[k] != null && row[k] !== "") return row[k];
  return null;
};

/**
 * One Dune row -> { address, label, walletName } for `vm`, or null.
 * A `blockchain` column (as in cex.addresses) must match: "solana" for the
 * Solana path, anything but "solana" for the EVM path.
 */
export function extractCexRow(row, vm = "evm") {
  const chain = row?.blockchain != null ? String(row.blockchain).trim().toLowerCase() : null;
  if (chain) {
    if (vm === "solana" && chain !== "solana") return null;
    if (vm !== "solana" && chain === "solana") return null;
  }
  const address = normalizeAddressForVm(vm, pick(row, ["address", "wallet_address", "wallet", "addr"]));
  if (!address) return null;
  const label = pick(row, ["label", "cex_name", "exchange", "entity", "name", "project"]) ?? "Unknown";
  const walletName = pick(row, ["wallet_name", "walletName", "distinct_name", "name_tag", "tag"]) ?? label;
  return { address, label: String(label).trim(), walletName: String(walletName).trim() };
}

/** All valid rows for `vm`, one entry per address (first label wins). */
export function parseDuneCexRows(rows, vm = "evm") {
  const byAddress = new Map();
  for (const row of rows ?? []) {
    const e = extractCexRow(row, vm);
    if (e && !byAddress.has(e.address)) byAddress.set(e.address, e);
  }
  return [...byAddress.values()];
}

const SQL_STR = "'((?:[^']|'')*)'";
const SPELLBOOK_ROW_RE = new RegExp(
  `\\(\\s*${SQL_STR}\\s*,\\s*${SQL_STR}\\s*,\\s*${SQL_STR}\\s*,\\s*${SQL_STR}\\s*,\\s*${SQL_STR}\\s*,\\s*date\\s*${SQL_STR}\\s*\\)`,
  "g",
);
const unq = (s) => s.replace(/''/g, "'");

/**
 * Parses the static `VALUES (...)` rows of a spellbook cex_<chain>_addresses
 * model into Dune-shaped rows (blockchain, address, cex_name, distinct_name,
 * added_by, added_date).
 */
export function parseSpellbookCexSql(sql) {
  const rows = [];
  for (const m of String(sql ?? "").matchAll(SPELLBOOK_ROW_RE)) {
    rows.push({
      blockchain: unq(m[1]),
      address: unq(m[2]),
      cex_name: unq(m[3]),
      distinct_name: unq(m[4]),
      added_by: unq(m[5]),
      added_date: unq(m[6]),
    });
  }
  return rows;
}

/**
 * Labelled CEX entries that actually hold the token in `holderWallets`
 * (exact-key match — case-sensitive for base58). Sorted by balance desc.
 */
export function intersectCexWithHolders(entries, holderWallets, { totalSupply = null } = {}) {
  const ranked = [...(holderWallets ?? [])]
    .map((w) => ({ address: w?.address, balance: Number(w?.total_telcoin_balance ?? w?.totalBalance ?? 0) }))
    .filter((w) => typeof w.address === "string")
    .sort((a, b) => b.balance - a.balance);
  const byAddress = new Map(ranked.map((w, i) => [w.address, { balance: w.balance, rank: i + 1 }]));
  const out = [];
  for (const e of entries ?? []) {
    const h = byAddress.get(e.address);
    if (!h) continue;
    const row = { ...e, balance: h.balance, holderRank: h.rank };
    if (Number(totalSupply) > 0) row.pctOfSupply = Number(((h.balance / Number(totalSupply)) * 100).toFixed(4));
    out.push(row);
  }
  return out.sort((a, b) => b.balance - a.balance);
}
