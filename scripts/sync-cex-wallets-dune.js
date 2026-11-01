#!/usr/bin/env node
/**
 * sync-cex-wallets-dune.js
 *
 * Fetches exchange wallet addresses from a Dune Analytics query and merges
 * any net-new addresses into the project's classification.cexWallets file
 * (TEL: config/cex-wallets.json).
 *
 * Existing entries are never modified or removed — only additions are made.
 * Address handling follows the project's VM (scripts/lib/duneCex.js):
 *   EVM    — 0x-hex only, lowercased (TEL, unchanged).
 *   Solana — base58 public keys kept exactly as written (never lowercased);
 *            rows tagged with another `blockchain` are skipped.
 *
 * Candidates mode (`--candidates`, and forced for any project that has no
 * classification.cexWallets file, e.g. ZBCN) NEVER touches a production list:
 * it intersects the labelled addresses with the project's current holder
 * snapshot and writes <workDir>/cex-dune-candidates.json for owner review.
 *
 * Sources (`--source`):
 *   dune      (default) — Dune API, query id from DUNE_QUERY_ID or
 *                         pipeline.duneCexQueryId (TEL keeps its built-in
 *                         3761086; other projects must bring their own).
 *   spellbook           — the public Dune spellbook static lists behind
 *                         cex_<chain>.addresses; no Dune key or credits needed.
 *                         EVM    — cex_evms_addresses.sql; works in the normal
 *                                  additions-only merge (and in --candidates).
 *                                  Fails (non-zero) if the list parses below
 *                                  MIN_SPELLBOOK_EVM_ROWS rows (format changed?).
 *                         Solana — candidates mode only (`--candidates`).
 *
 * Env (dune source): DUNE_API_KEY (required), DUNE_QUERY_ID, DUNE_RESULT_LIMIT (default 5000).
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./loadEnv.js";
import {
  selectPipelineProject,
  projectClassificationPath,
  projectClassificationRelPath,
  projectPaths,
  projectWork,
} from "./lib/projects.js";
import { normalizeAddressForVm } from "./lib/address.js";
import {
  cexVmForProject,
  intersectCexWithHolders,
  mergeCexAdditions,
  parseDuneCexRows,
  parseSpellbookCexSql,
  parseSpellbookEvmCexSql,
  spellbookUrlForVm,
} from "./lib/duneCex.js";

// The EVM spellbook list holds ~5,000 rows; far fewer means the format changed, not that the list shrank.
const MIN_SPELLBOOK_EVM_ROWS = 1000;

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: merges into the
// project's own `classification.cexWallets` file (TEL: config/cex-wallets.json).
// A non-legacy project must declare its own Dune query (`pipeline.duneCexQueryId`
// or DUNE_QUERY_ID) — TEL's query is never reused.
const project = selectPipelineProject("sync-cex-wallets-dune", { ported: true });

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
};

await loadEnv();

const VM = cexVmForProject(project);
const SOURCE = (argValue("--source") ?? "dune").toLowerCase();
const CEX_CONFIG_PATH = projectClassificationPath(project, "cexWallets", process.cwd());
const CEX_CONFIG_REL = projectClassificationRelPath(project, "cexWallets", process.cwd());
// No production list declared = candidates only; never invent one.
const CANDIDATES = argv.includes("--candidates") || !CEX_CONFIG_PATH;
const IS_LEGACY = project.config?.data?.legacyRoot === true;
const QUERY_ID = process.env.DUNE_QUERY_ID ?? project.config?.pipeline?.duneCexQueryId ?? (IS_LEGACY ? "3761086" : null);
const LIMIT = Number(process.env.DUNE_RESULT_LIMIT ?? 5000);
const API_KEY = process.env.DUNE_API_KEY;
const CANDIDATES_PATH = projectWork(project)("cex-dune-candidates.json");
const CANDIDATES_REL = projectWork(project).rel("cex-dune-candidates.json");

const fail = (code, msg) => {
  console.error(`[sync-cex-wallets-dune] ${msg}`);
  process.exit(code);
};

if (!["dune", "spellbook"].includes(SOURCE)) fail(2, `unknown --source "${SOURCE}" (dune | spellbook).`);
if (SOURCE === "spellbook") {
  if (!CANDIDATES && VM !== "evm") fail(2, "--source spellbook for Solana is candidates-only; add --candidates (it never writes a production list).");
  try {
    spellbookUrlForVm(VM);
  } catch (e) {
    fail(2, e.message);
  }
}
if (SOURCE === "dune") {
  if (!QUERY_ID) {
    fail(
      2,
      `project "${project.slug}" needs its own Dune query: set pipeline.duneCexQueryId (or DUNE_QUERY_ID). ` +
        (VM === "solana"
          ? `TODO(owner): create a Dune query over cex.addresses WHERE blockchain = 'solana' (see docs/MULTI-TOKEN.md "Solana CEX wallets"). ` +
            `Until then: --candidates --source spellbook.`
          : `TEL's query is never reused for another project.`),
    );
  }
  if (!CANDIDATES && !CEX_CONFIG_PATH) fail(2, `project "${project.slug}" needs classification.cexWallets before it can sync.`);
  if (!API_KEY) fail(1, "Missing DUNE_API_KEY environment variable.");
}

const fetchRows = async () => {
  if (SOURCE === "spellbook") {
    const url = spellbookUrlForVm(VM);
    console.log(`Fetching Dune spellbook CEX model (${VM}): ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`spellbook fetch ${res.status}`);
    const text = await res.text();
    const rows = VM === "evm" ? parseSpellbookEvmCexSql(text) : parseSpellbookCexSql(text);
    return { rows, source: { type: "dune-spellbook", url, vm: VM } };
  }
  const url = `https://api.dune.com/api/v1/query/${QUERY_ID}/results?limit=${LIMIT}`;
  console.log(`Fetching Dune query ${QUERY_ID} (limit ${LIMIT})...`);
  const res = await fetch(url, { headers: { "x-dune-api-key": API_KEY } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dune API error ${res.status}: ${body}`);
  }
  const payload = await res.json();
  const rows = payload?.result?.rows ?? [];
  if (rows.length === 0) {
    const cols = payload?.result?.metadata?.column_names ?? [];
    if (cols.length) console.log("Columns:", cols.join(", "));
  }
  return { rows, source: { type: "dune-query", queryId: String(QUERY_ID), vm: VM } };
};

const writeCandidates = async (duneEntries, source) => {
  const snapshot = JSON.parse(await fs.readFile(projectPaths(project)("tel-holders.json"), "utf8"));
  const candidates = intersectCexWithHolders(duneEntries, snapshot.wallets ?? [], {
    totalSupply: snapshot?.totals?.totalSupply ?? null,
  }).map((c) => ({ ...c, status: "candidate", source: source.type }));
  const out = {
    $comment:
      "CANDIDATES ONLY — not production. Dune-labelled CEX addresses that hold this token in the current holder snapshot. " +
      "Nothing here is classified until the owner approves entries and they are copied into a classification.cexWallets file.",
    generatedAt: new Date().toISOString(),
    project: project.slug,
    vm: VM,
    source,
    holderSnapshotGeneratedAt: snapshot.generatedAt ?? null,
    labelledAddresses: duneEntries.length,
    holderCount: (snapshot.wallets ?? []).length,
    intersectCount: candidates.length,
    intersectBalance: candidates.reduce((s, c) => s + c.balance, 0),
    candidates,
  };
  await fs.mkdir(path.dirname(CANDIDATES_PATH), { recursive: true });
  await fs.writeFile(CANDIDATES_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`${candidates.length} of ${duneEntries.length} labelled address(es) hold ${project.config?.ticker ?? "the token"}.`);
  for (const c of candidates) console.log(`  #${c.holderRank} ${c.address} ${c.label} (${c.walletName}) ${c.balance}`);
  console.log(`Wrote candidates (review only, no production list touched) → ${CANDIDATES_REL}`);
};

const main = async () => {
  const { rows, source } = await fetchRows();
  console.log(`Source returned ${rows.length} rows.`);
  if (rows.length > 0) console.log("Columns detected:", Object.keys(rows[0]).join(", "));

  const duneEntries = parseDuneCexRows(rows, VM);
  console.log(`Parsed ${duneEntries.length} valid ${VM} address entries.`);

  if (SOURCE === "spellbook" && VM === "evm" && (rows.length < MIN_SPELLBOOK_EVM_ROWS || duneEntries.length === 0)) {
    fail(
      1,
      `spellbook EVM list parsed ${rows.length} rows / ${duneEntries.length} entries (expected >= ${MIN_SPELLBOOK_EVM_ROWS}); ` +
        `the file format may have changed. Nothing written.`,
    );
  }

  if (CANDIDATES) return writeCandidates(duneEntries, source);

  if (rows.length === 0) {
    console.log("No rows — nothing to merge.");
    return;
  }

  // --- Load existing config ---
  const normalize = (v) => normalizeAddressForVm(VM, v);
  const config = JSON.parse(await fs.readFile(CEX_CONFIG_PATH, "utf8"));
  console.log(`Existing addresses in config: ${(config.wallets ?? []).length}`);

  // Additions-only; existing "Unknown" labels are repaired from the source data.
  const { wallets: mergedWallets, additions, repaired } = mergeCexAdditions(config.wallets, duneEntries, normalize);
  if (repaired > 0) console.log(`Repaired ${repaired} Unknown labels from ${source.type} data.`);
  console.log(`Net-new addresses to add: ${additions.length}`);

  if (additions.length === 0 && repaired === 0) {
    console.log("Config is already up to date.");
    return;
  }

  if (additions.length > 0) {
    const byLabel = {};
    for (const a of additions) byLabel[a.label] = (byLabel[a.label] ?? 0) + 1;
    console.log("Additions by exchange:");
    Object.entries(byLabel)
      .sort((a, b) => b[1] - a[1])
      .forEach(([label, count]) => console.log(`  ${label}: +${count}`));
  }

  config.wallets = mergedWallets;
  await fs.writeFile(CEX_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${config.wallets.length} total wallets → ${CEX_CONFIG_PATH} (source=${source.type})`);
  console.log(`Done. Commit ${CEX_CONFIG_REL} to apply.`);
};

main().catch((e) => { console.error(e); process.exit(1); });
