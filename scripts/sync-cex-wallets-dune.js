#!/usr/bin/env node
/**
 * sync-cex-wallets-dune.js
 *
 * Fetches exchange wallet addresses from a Dune Analytics query and merges
 * any net-new addresses into config/cex-wallets.json.
 *
 * Existing entries are never modified or removed — only additions are made.
 * Addresses are normalized to lowercase before comparison.
 *
 * Required env:
 *   DUNE_API_KEY — Dune API key
 *
 * Optional env:
 *   DUNE_QUERY_ID — override the query ID (default: 3761086)
 *   DUNE_RESULT_LIMIT — max rows to fetch (default: 5000)
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";

await loadEnv();

const CEX_CONFIG_PATH = path.resolve(process.cwd(), "config/cex-wallets.json");
const QUERY_ID = process.env.DUNE_QUERY_ID ?? "3761086";
const LIMIT = Number(process.env.DUNE_RESULT_LIMIT ?? 5000);
const API_KEY = process.env.DUNE_API_KEY;

if (!API_KEY) {
  console.error("Missing DUNE_API_KEY environment variable.");
  process.exit(1);
}

const normalizeAddress = (v) => {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(t) ? t : null;
};

// Map common Dune column names to our schema fields.
const extractRow = (row) => {
  // Address — try several common column names
  const rawAddress =
    row.address ?? row.wallet_address ?? row.wallet ?? row.addr ?? null;
  const address = normalizeAddress(rawAddress);
  if (!address) return null;

  // Label (exchange name)
  const label =
    row.label ?? row.cex_name ?? row.exchange ?? row.entity ?? row.name ?? row.project ?? "Unknown";

  // Wallet name / sub-label
  const walletName =
    row.wallet_name ?? row.walletName ?? row.name_tag ?? row.tag ?? label;

  return { address, label: String(label).trim(), walletName: String(walletName).trim() };
};

const main = async () => {
  // --- Fetch from Dune ---
  const url = `https://api.dune.com/api/v1/query/${QUERY_ID}/results?limit=${LIMIT}`;
  console.log(`Fetching Dune query ${QUERY_ID} (limit ${LIMIT})...`);
  const res = await fetch(url, { headers: { "x-dune-api-key": API_KEY } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dune API error ${res.status}: ${body}`);
  }
  const payload = await res.json();

  const rows = payload?.result?.rows ?? [];
  console.log(`Dune returned ${rows.length} rows.`);
  if (rows.length === 0) {
    // Log column names if available so we can debug schema
    const cols = payload?.result?.metadata?.column_names ?? [];
    if (cols.length) console.log("Columns:", cols.join(", "));
    console.log("No rows — nothing to merge.");
    return;
  }

  // Log column names of first row for visibility
  console.log("Columns detected:", Object.keys(rows[0]).join(", "));

  // --- Parse Dune rows ---
  const duneEntries = rows.map(extractRow).filter(Boolean);
  console.log(`Parsed ${duneEntries.length} valid address entries from Dune.`);

  // --- Load existing config ---
  const config = JSON.parse(await fs.readFile(CEX_CONFIG_PATH, "utf8"));
  const existingAddresses = new Set(
    (config.wallets ?? []).map((w) => normalizeAddress(w.address)).filter(Boolean)
  );
  console.log(`Existing addresses in config: ${existingAddresses.size}`);

  // Build lookup from Dune for label repairs
  const duneByAddress = new Map(duneEntries.map((e) => [e.address, e]));

  // --- Repair existing "Unknown" labels using Dune data ---
  let repaired = 0;
  config.wallets = config.wallets.map((w) => {
    if (w.label !== "Unknown") return w;
    const norm = normalizeAddress(w.address);
    const fresh = norm ? duneByAddress.get(norm) : null;
    if (fresh && fresh.label !== "Unknown") {
      repaired++;
      return { ...w, label: fresh.label, walletName: fresh.walletName };
    }
    return w;
  });
  if (repaired > 0) console.log(`Repaired ${repaired} Unknown labels from Dune data.`);

  // --- Find net-new addresses ---
  const additions = duneEntries.filter((e) => !existingAddresses.has(e.address));
  console.log(`Net-new addresses to add: ${additions.length}`);

  if (additions.length === 0 && repaired === 0) {
    console.log("Config is already up to date.");
    return;
  }

  // Log what we're adding
  if (additions.length > 0) {
    const byLabel = {};
    for (const a of additions) {
      byLabel[a.label] = (byLabel[a.label] ?? 0) + 1;
    }
    console.log("Additions by exchange:");
    Object.entries(byLabel)
      .sort((a, b) => b[1] - a[1])
      .forEach(([label, count]) => console.log(`  ${label}: +${count}`));
  }

  // --- Merge and write ---
  config.wallets = [...config.wallets, ...additions];
  await fs.writeFile(CEX_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${config.wallets.length} total wallets → ${CEX_CONFIG_PATH}`);
  console.log("Done. Commit config/cex-wallets.json to apply.");
};

main().catch((e) => { console.error(e); process.exit(1); });
