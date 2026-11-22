import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHAIN_VMS } from "./chainVms.js";
import { assertNoProblems, compareToAllowlist, listFiles, listSourceFiles, matchLines, readRepoFile, repo, scanSource, stripYamlComments } from "./guardScan.js";

// Owner rule (2026-11-18): every coin is treated the same, and no shared code names a coin. A difference
// between coins belongs in the coin's config; a difference between ledgers belongs in a chain adapter.
// This guard fails when shared code names a registered coin, ships a registered contract address, keeps a
// per-chain-name table of numbers, or reads the default-coin layout flag outside scripts/lib/projects.js.
// Each rule starts with the violations that exist today (audit: tasks/scale-100/design/scaling-audit.md,
// section 1.2). A list may only shrink: a hit in an unlisted file fails, more hits than recorded fails, and
// fewer hits than recorded fails too (so the developer lowers the number and the list stays true).
//
// Scope: non-test source under scripts/ (not scripts/datachecks, not fixtures), netlify/, src/ (not
// src/datachecks), and .github/workflows/*.yml. netlify/functions/forensics-gate.cjs is a 4 MB bundle built
// from netlify/functions-src, which is scanned instead.
//
// What counts as naming a coin, from the registry: a string or template literal equal to a slug, ticker or
// CoinGecko id; a literal holding a slug as a whole path segment or query value ("public/data/ondo/x.json",
// "/api?token=ondo"; slugs only, never tickers); an unquoted object key or a member access equal to one of
// them ({ ondo: 1 }, data.ondo); a regex literal that is just one of them (/^ondo$/i); a workflow value, list
// item, inline list item or `--project x`. A registered word that is exactly a chain key, name or short name
// (config/chains.json, or another coin's chains[]) or a vm name is not a coin word; a coin cannot reserve its
// own word, and there are no prefix rules.
// A config-only coin passes unless its slug, ticker or price id already appears as a literal in shared code
// (SOL, USDC); then the message tells the developer to read the value from config or record the entry, and
// the onboarding fix PR does that.
//
// What this guard does not see (documented limits): a coin split by concatenation ("on" + "do"); a coin inside
// a longer identifier (`telContracts`) or in a message; the display name ("Telcoin"); an address split or
// written as a regex; a chain table whose values are not plain numbers (addresses, URLs, hex, identifiers, a
// Map, an array) or keyed by chain id; a slug that is also a vm name (hedera: chainBranchGuard.test.js counts
// its comparisons); and a schema name swapped between files (the schema rule counts files).

const SKIP_FILES = new Set(["netlify/functions/forensics-gate.cjs"]);
const skipSource = (p) => SKIP_FILES.has(p) || p.startsWith("scripts/datachecks/") || p.startsWith("src/datachecks/");
const SOURCE_ROOTS = ["scripts", "netlify", "src"];
const WORKFLOW_DIR = ".github/workflows";
const PATH_HELPER_MODULE = "scripts/lib/projects.js";

// ---------------------------------------------------------------------------------------------------------
// Today's violations. Entry: file -> { count, reason }. Reasons come from the audit ("accident" or "real ...").
// ---------------------------------------------------------------------------------------------------------

const ENTRY = (count, reason) => ({ count, reason });

// A registered slug, ticker or CoinGecko id used as a string value.
const ALLOWED_COIN_LITERALS = new Map([
  ["netlify/functions-src/gatedProjects.ts", ENTRY(1, "fallback default project slug when the registry is empty (audit 1.2, netlify); accident")],
  ["scripts/lib/hedera/adapter.js", ENTRY(2, "native asset symbol HBAR written in the adapter; real ledger fact that belongs in the chain entry's asset config")],
  ["scripts/lib/hedera/ledgerSource.js", ENTRY(1, "native asset symbol HBAR written in the ledger source; real ledger fact that belongs in the chain entry's asset config")],
  ["scripts/lib/walletFlows.js", ENTRY(20, "distribution classes grouped under the telcoin category in a shared module (audit 1.2, telcoin category); accident Also the default coin's field name tel as a key or property.")],
  ["scripts/onboard.js", ENTRY(1, "CoinGecko id of the native coin in onboarding discovery (audit 1.1, onboard.js:259-266); real, belongs in an adapter discover port")],
  ["scripts/probe-log-ranges.js", ENTRY(3, "probe token symbols per chain (ONDO, TEL); diagnostic script, accident: read the registry")],
  ["scripts/reconcile-supply.js", ENTRY(1, "fallback ticker TEL when the config has none; accident")],
  ["src/components/TelDispositionLedger.tsx", ENTRY(3, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config Also the default coin's field name tel as a key or property.")],
  ["src/components/TierFlowDiagram.tsx", ENTRY(8, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config Also the default coin's field name tel as a key or property.")],
  ["src/components/tierflow/TierFlowTableSheet.tsx", ENTRY(1, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config")],
  ["src/components/tierflow/TierRail.tsx", ENTRY(3, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config Also the default coin's field name tel as a key or property.")],
  ["src/components/tierflow/columnCopy.ts", ENTRY(2, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config")],
  ["src/components/tierflow/geometry.ts", ENTRY(2, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config")],
  ["src/components/tierflow/net.ts", ENTRY(2, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config")],
  ["src/components/tierflow/railSummary.ts", ENTRY(6, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config")],
  ["src/components/tierflow/statCopy.ts", ENTRY(1, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config")],
  ["src/components/tierflow/useFlowField.ts", ENTRY(1, "the default coin's metric key tel in shared site components (audit 1.2, site: tierflow metric key); read the coin's ticker from its config")],
  ["src/lib/salesJournalSort.ts", ENTRY(2, "sort key tel of the council sales journal (audit 1.2, TEL content in shared components)")],
  [".github/workflows/backfill-treasury-cex-history.yml", ENTRY(2, "workflow input and env default is a registered slug; the scheduled watchdog repairs only that coin (audit 1.2, 8 workflows default HD_PROJECT to tel)")],
  [".github/workflows/fill-history-gaps.yml", ENTRY(2, "workflow input and env default is a registered slug; the scheduled watchdog repairs only that coin (audit 1.2, 8 workflows default HD_PROJECT to tel)")],
  [".github/workflows/generate-tier-outflows.yml", ENTRY(2, "workflow input and env default is a registered slug; the scheduled watchdog repairs only that coin (audit 1.2, 8 workflows default HD_PROJECT to tel)")],
  [".github/workflows/pipeline-watchdog.yml", ENTRY(2, "workflow input and env default is a registered slug; the scheduled watchdog repairs only that coin (audit 1.2, 8 workflows default HD_PROJECT to tel)")],
  [".github/workflows/rebuild-holders-history-solana.yml", ENTRY(1, "input default is zebec-network (audit 1.2: defaults to the Solana coin)")],
  [".github/workflows/rebuild-holders-history.yml", ENTRY(2, "workflow input and env default is a registered slug; the scheduled watchdog repairs only that coin (audit 1.2, 8 workflows default HD_PROJECT to tel)")],
  [".github/workflows/recompute-holders-history.yml", ENTRY(2, "workflow input and env default is a registered slug; the scheduled watchdog repairs only that coin (audit 1.2, 8 workflows default HD_PROJECT to tel)")],
  [".github/workflows/refresh-staker-balances.yml", ENTRY(2, "workflow input and env default is a registered slug; the scheduled watchdog repairs only that coin (audit 1.2, 8 workflows default HD_PROJECT to tel)")],
  [".github/workflows/scan-exchange-flows.yml", ENTRY(2, "workflow input and env default is a registered slug; the scheduled watchdog repairs only that coin (audit 1.2, 8 workflows default HD_PROJECT to tel)")],
  ["netlify/functions-src/forensics-gate.ts", ENTRY(1, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
  ["scripts/generate-holder-transitions.js", ENTRY(4, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
  ["scripts/generate-tier-outflows.js", ENTRY(3, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
  ["scripts/generate-wallet-flows.js", ENTRY(2, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
  ["scripts/lib/projects.js", ENTRY(1, "usage text in an error message names --project=tel as an example (a path-like literal); harmless text that still shows the default coin")],
  ["scripts/lib/solana/walletFlowsSolana.js", ENTRY(1, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
  ["scripts/lib/walletFlowsSwaps.js", ENTRY(1, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
  ["src/components/DispositionPnlView.tsx", ENTRY(1, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
  ["src/components/WalletFlowsPanel.tsx", ENTRY(7, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
  ["src/lib/dispositionPnl.ts", ENTRY(23, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
  ["src/lib/walletFlowsTypes.ts", ENTRY(2, "the default coin's field names tel and telcoin as object keys and property reads in shared report and site shapes (audit 1.2, TEL content and metric key in shared components); read the coin's ticker from its config")],
]);

// A registered token or contract address written into shared code.
const ALLOWED_ADDRESS_LITERALS = new Map([
  ["scripts/lib/hedera/treasury.js", ENTRY(1, "Hedera treasury account id written into the adapter folder; per-coin data that belongs in the project config (treasury)")],
  ["scripts/lib/solana/zebecStake.js", ENTRY(1, "ZBCN staking program id in the Solana folder (audit 1.2, staking kinds: each kind is one coin's contract)")],
  ["scripts/probe-log-ranges.js", ENTRY(3, "probe token addresses per chain; diagnostic script, accident: read the registry")],
  ["src/lib/telContracts.ts", ENTRY(8, "TEL v3 and legacy addresses and the upgrade portal in the site (audit 1.2, site telContracts.ts)")],
]);

// An object literal keyed by chain name (ethereum, polygon, base) holding numbers: block ranges, chunk sizes.
const ALLOWED_CHAIN_TABLES = new Map([
  ["scripts/add-project.js", ENTRY(1, "KNOWN_EVM facts for the three chains the code knows; accident: read them from config/chains.json")],
  ["scripts/detect-cex-candidates.js", ENTRY(1, "per-chain chunk and lookback table (audit 1.2: more per-chain-name chunk tables)")],
  ["scripts/diagnose-council-transfers.js", ENTRY(1, "per-chain chunk table (audit 1.2: more per-chain-name chunk tables)")],
  ["scripts/generate-tier-outflows.js", ENTRY(1, "CHAIN_TUNING: chunk and blocks per day by chain name (audit 1.2: more per-chain-name chunk tables)")],
  ["scripts/lib/exchangeFlowChains.js", ENTRY(2, "CHUNK by chain name and TEL's first-scan blocks (audit 1.2; PLAN A: 2,919 requests a night)")],
  ["scripts/lib/logSource.js", ENTRY(1, "confirmation depth by chain name; not in the audit; real chain property that belongs in the chain entry")],
  ["scripts/lib/telTokens.js", ENTRY(1, "LEGACY_SCAN_START: TEL's start blocks apply to any coin on those chains (audit 1.2)")],
  ["scripts/lib/walletFlowsProject.js", ENTRY(1, "TEL_LOG_SPAN: TEL's getLogs spans by chain name; not in the audit")],
  ["scripts/probe-log-ranges.js", ENTRY(1, "probe tokens per chain; diagnostic script; not in the audit")],
  ["scripts/pull-holders-rpc.js", ENTRY(3, "RPC chunk sizes, default from-blocks and v3 chunk sizes by chain name (audit 1.2, pull-holders-rpc; TEL's start blocks)")],
]);

// `legacyRoot` (the default coin's pre-multi-token layout) outside the module that defines the path helpers.
const ALLOWED_LEGACY_ROOT = new Map([
  ["netlify/functions-src/gatedProjects.ts", ENTRY(2, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["netlify/functions/live-data.mjs", ENTRY(4, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["scripts/add-project.js", ENTRY(1, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["scripts/append-treasury-history.js", ENTRY(1, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["scripts/lib/exchangeFlowChains.js", ENTRY(1, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["scripts/lib/nightlyPlan.js", ENTRY(1, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["scripts/lib/onboardRun.js", ENTRY(3, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["scripts/lib/walletFlowsProject.js", ENTRY(1, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["scripts/onboard-run.js", ENTRY(10, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["scripts/prune-dist-data.js", ENTRY(2, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["scripts/workflow-paths.js", ENTRY(2, "path helpers read the default coin's layout flag themselves instead of asking projects.js (audit 1.2, legacyRoot list); removed by PLAN F")],
  ["src/lib/projects.ts", ENTRY(1, "the site's typed copy of the registry reader (audit 1.2: two layouts in every path helper); removed by PLAN F")],
]);

// The default coin's data schema, shared by every coin today. One entry per pattern: the number of FILES that
// match. The count may not rise; when it falls, lower it. (A file swapped for another file keeps the count, so
// this guard cannot see that; the other rules and review do.)
const SCHEMA_PATTERNS = [
  { name: "tel-holders", pattern: /tel-holders/, files: 26, reason: "the default coin's snapshot file name is the shared snapshot name (audit 1.2; naming only, readers tied to it)" },
  { name: "total_telcoin_balance", pattern: /total_telcoin_balance/, files: 11, reason: "the default coin's balance column is the shared column (audit 1.2)" },
  { name: "MIN_TEL_RAW", pattern: /MIN_TEL_RAW/, files: 2, reason: "the default coin's minimum balance constant sits in the shared scan (audit 1.2)" },
  { name: "telTokens", pattern: /telTokens/, files: 8, reason: "the default coin's legacy/v3 token model is the only EVM token model (audit 1.2, telTokens.js)" },
];

// ---------------------------------------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------------------------------------

const EVM_ADDRESS = /0x[0-9a-fA-F]{40}/g;
// Said when a coin word is found. A newly registered coin whose ticker or slug is an ordinary word (a quote
// asset such as USDC) fails here on the literals that already exist; the fix depends on what they mean.
export const COIN_LITERAL_ADVICE =
  "This word is now a registered coin (slug, ticker or CoinGecko id in config), so shared code that writes it reads as naming that coin. If it means the coin, read the value from the project's config or the registry instead. If it does not mean the coin (a quote asset, a chain symbol, an ordinary word), record this file in ALLOWED_COIN_LITERALS with that reason.";
const CLI_PROJECT_ARG = /(?:--project[ =]|HD_PROJECT=)["']?([\w-]+)/g;
const CHAIN_FAMILIES = new Set(CHAIN_VMS);

const readJson = (relPath) => JSON.parse(fs.readFileSync(path.join(repo, relPath), "utf8"));

/**
 * What names a coin, from the registry (config/projects.json) and each config/projects/<slug>.json:
 *   words      lowercase slug, ticker and CoinGecko id (coin -> label)
 *   addresses  lowercase EVM token/contract addresses; other ledgers' addresses keep their case
 * A word that is also a chain family ("hedera") is left out: that literal is a chain branch, counted by
 * chainBranchGuard.test.js, and one pattern should have one owner.
 */
/**
 * Words that name a chain, not a coin: EXACT words only (no prefixes). Fixed words come from
 * config/chains.json (key, name, short name) and the vm names. A chain word from a project config's chains[]
 * is reserved only for a coin other than that project, so a coin cannot un-guard its own ticker by declaring
 * it as one of its chains' names. `has(word, slug)` says whether `word` is reserved for the coin `slug`.
 */
export const reservedChainWords = (chainsJson, configs) => {
  const fixed = new Set();
  const byCoin = new Map();
  const norm = (word) => (typeof word === "string" ? word.trim().toLowerCase() : "");
  const chainWords = (chain) => [chain?.key, chain?.name, chain?.shortName].map(norm).filter(Boolean);
  for (const vm of CHAIN_VMS) fixed.add(norm(vm));
  for (const chain of Object.values(chainsJson ?? {})) chainWords(chain).forEach((w) => fixed.add(w));
  for (const [slug, cfg] of Object.entries(configs ?? {})) {
    for (const chain of cfg?.chains ?? []) {
      for (const w of chainWords(chain)) byCoin.set(w, new Set([...(byCoin.get(w) ?? []), slug]));
    }
  }
  return { fixed, byCoin, has: (word, slug) => fixed.has(word) || [...(byCoin.get(word) ?? [])].some((s) => s !== slug) };
};

/**
 * What names a coin, from the registry (config/projects.json) and each config/projects/<slug>.json:
 *   words      lowercase slug, ticker and CoinGecko id (word -> slug)
 *   slugs      the registered slugs that are coin words
 *   addresses  lowercase EVM token/contract addresses; other ledgers' addresses keep their case
 * A word in `reserved` (see reservedChainWords) is left out: it names a chain, and a family name such as
 * "hedera" is a chain branch, counted by chainBranchGuard.test.js, so one pattern has one owner.
 */
export const coinIdentifiers = (registry, configs, reserved = { has: () => false }) => {
  const words = new Map();
  const slugs = new Set();
  const evmAddresses = new Map();
  const otherAddresses = new Map();
  const addWord = (word, slug) => {
    if (typeof word !== "string") return;
    const w = word.trim().toLowerCase();
    if (w.length >= 2 && !CHAIN_FAMILIES.has(w) && !reserved.has(w, slug)) words.set(w, slug);
  };
  const addAddress = (address, slug) => {
    if (typeof address !== "string" || address.length < 5) return;
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) evmAddresses.set(address.toLowerCase(), slug);
    else otherAddresses.set(address, slug);
  };
  const findCoingeckoIds = (node, slug) => {
    if (Array.isArray(node)) node.forEach((x) => findCoingeckoIds(x, slug));
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "coingeckoId") addWord(v, slug);
        else findCoingeckoIds(v, slug);
      }
    }
  };
  for (const entry of registry.projects ?? []) {
    addWord(entry.slug, entry.slug);
    addWord(entry.ticker, entry.slug);
    if (words.has(String(entry.slug).toLowerCase())) slugs.add(String(entry.slug).toLowerCase());
    const cfg = configs[entry.slug];
    if (!cfg) continue;
    addWord(cfg.ticker, entry.slug);
    findCoingeckoIds(cfg, entry.slug);
    for (const chain of cfg.chains ?? []) {
      for (const token of chain.tokens ?? []) addAddress(token.address, entry.slug);
      for (const contract of Object.values(chain.contracts ?? {})) addAddress(contract?.address, entry.slug);
    }
  }
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const byLength = (a, b) => b.length - a.length;
  const slugList = [...slugs].sort(byLength).map(escape);
  const identList = [...words.keys()].filter((w) => /^[A-Za-z_$][\w$]*$/.test(w)).sort(byLength).map(escape);
  return {
    words,
    slugs,
    evmAddresses,
    otherAddresses,
    slugSegment: slugList.length ? new RegExp(`(?:^|[/=?&\u0000])(${slugList.join("|")})(?=$|[/&?#])`, "gi") : null,
    identKey: identList.length ? new RegExp(`(?:^|[{,])[ \t\r\n]*(${identList.join("|")})[ \t]*:`, "gim") : null,
    identMember: identList.length ? new RegExp(`(?<!\\.)\\.(${identList.join("|")})(?![\\w$])`, "gi") : null,
  };
};

const loadIdentifiers = () => {
  const registry = readJson("config/projects.json");
  const configs = {};
  for (const entry of registry.projects ?? []) configs[entry.slug] = readJson(`config/projects/${entry.slug}.json`);
  return coinIdentifiers(registry, configs, reservedChainWords(readJson("config/chains.json"), configs));
};

/** Coin names in the string literals of one source file's text: [{ line, detail }]. */
export const coinLiteralHits = (text, ids) => {
  const hits = [];
  for (const { line, value } of scanSource(text).strings) hits.push(...valueHits(line, value, ids, false), ...pathSegmentHits(line, value, ids));
  return hits;
};

/**
 * A slug inside a longer literal as a whole path segment or query value: "public/data/ondo/x.json",
 * `${dir}/ondo/`, "/api?token=ondo". The segment must follow the start, "/", "=", "?", "&" or an expression
 * and end at the end, "/", "&", "?" or "#", so "tel-holders.json", "hotel/x", "telephone" and "a tel b" pass.
 * Slugs only: a ticker in a path is not a path segment of the data layout.
 */
const pathSegmentHits = (line, value, ids) => {
  if (!ids.slugSegment || ids.words.has(value.trim().toLowerCase()) || !/[/=?&]/.test(value)) return [];
  return [...value.matchAll(ids.slugSegment)].map((m) => ({ line, detail: `contains the coin slug "${m[1].toLowerCase()}" as a path segment or query value (${JSON.stringify(value)})`, kind: "word" }));
};

const lineAt = (text, index) => {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
};

/** A coin word as an unquoted object key or a member access, or a whole regex literal, in code (not strings). */
export const coinCodeHits = (text, ids) => {
  const { bare, regexes } = scanSource(text);
  const hits = [];
  if (ids.identKey) {
    for (const m of bare.matchAll(ids.identKey)) hits.push({ line: lineAt(bare, m.index + m[0].toLowerCase().lastIndexOf(m[1].toLowerCase())), detail: `uses the coin word "${m[1]}" as an object key`, kind: "word" });
  }
  if (ids.identMember) {
    for (const m of bare.matchAll(ids.identMember)) hits.push({ line: lineAt(bare, m.index), detail: `reads the coin word "${m[1]}" as a property (.${m[1]})`, kind: "word" });
  }
  for (const { line, source } of regexes) {
    const word = source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\b/g, "").replace(/\\-/g, "-").toLowerCase();
    if (ids.words.has(word)) hits.push({ line, detail: `matches the coin word "${word}" with a regular expression`, kind: "word" });
  }
  return hits;
};

/**
 * A literal names a coin when its whole content (trimmed, any case) equals a registered word. Why whole
 * content and not a substring: `tel` must not fire on "tell", "hotel" or "telephone", and `ondo` not on
 * "London"; a coin is named as a value, so the value is the literal. In a workflow (`cli` true) a project
 * argument inside a shell line (`--project tel`) counts too; in JS a longer string is prose (usage text such
 * as "e.g. --project tel"), so it does not.
 */
const valueHits = (line, value, ids, cli) => {
  const hits = [];
  const word = value.trim().toLowerCase();
  if (ids.words.has(word)) hits.push({ line, detail: `reads as coin "${ids.words.get(word)}": the literal ${JSON.stringify(value)} is a registered coin word (slug, ticker or CoinGecko id)`, kind: "word" });
  if (!cli) return hits;
  for (const m of value.matchAll(CLI_PROJECT_ARG)) {
    if (ids.words.has(m[1].toLowerCase()) && !ids.words.has(word)) hits.push({ line, detail: `passes coin "${ids.words.get(m[1].toLowerCase())}" as a project argument`, kind: "word" });
  }
  return hits;
};

/** Registered contract addresses in the string literals of one source file's text. */
export const coinAddressHits = (text, ids) => {
  const hits = [];
  for (const { line, value } of scanSource(text).strings) hits.push(...addressHitsIn(line, value, ids));
  return hits;
};

const addressHitsIn = (line, value, ids) => {
  const hits = [];
  for (const m of value.matchAll(EVM_ADDRESS)) {
    const slug = ids.evmAddresses.get(m[0].toLowerCase());
    if (slug) hits.push({ line, detail: `contains the address ${m[0]} registered for coin "${slug}"` });
  }
  // Solana and Hedera addresses are case-sensitive and not hex: whole-literal match for short ids (0.0.N),
  // substring for long base58 strings, which cannot occur by accident.
  for (const [address, slug] of ids.otherAddresses) {
    const hit = address.length >= 32 ? value.includes(address) : value.trim() === address;
    if (hit) hits.push({ line, detail: `contains the address ${address} registered for coin "${slug}"` });
  }
  return hits;
};

/**
 * Values in a workflow file that name a coin: quoted strings, the scalar after `key:`, list items, and
 * `--project x` / `HD_PROJECT=x` in shell lines. One hit per line and value.
 */
export const workflowCoinHits = (yaml, ids) => {
  const hits = [];
  stripYamlComments(yaml)
    .split("\n")
    .forEach((text, index) => {
      const values = new Set();
      for (const m of text.matchAll(/'([^']*)'|"([^"]*)"/g)) values.add(m[1] ?? m[2]);
      const scalar = /^\s*(?:-\s+)?[\w.$-]+:\s*(\S.*)$/.exec(text);
      if (scalar) values.add(scalar[1].trim().replace(/^['"]|['"]$/g, ""));
      const item = /^\s*-\s+([^:]+)$/.exec(text);
      if (item) values.add(item[1].trim().replace(/^['"]|['"]$/g, ""));
      for (const list of text.matchAll(/\[([^\[\]]*)\]/g)) for (const part of list[1].split(",")) values.add(part.trim().replace(/^['"]|['"]$/g, ""));
      for (const value of values) hits.push(...valueHits(index + 1, value, ids, true));
      for (const value of values) hits.push(...addressHitsIn(index + 1, value, ids));
    });
  return hits;
};

const CHAIN_NAME_KEYS = () => {
  const names = new Set(Object.keys(readJson("config/chains.json")));
  return names;
};

/**
 * Tables keyed by chain name that hold numbers: two or more of the chain names as keys with a number (or a
 * nested object) as value, within 2 lines of each other. One hit per table, at its first line. A table of
 * addresses or URLs per chain is not a number table and is not counted.
 */
export const chainNameTableHits = (text, chainNames) => {
  if (chainNames.size < 2) return [];
  const code = scanSource(text).code;
  const names = [...chainNames].map((n) => n.replace(/[^\w]/g, "")).join("|");
  const pair = new RegExp(String.raw`(?<![\w.$])["']?(${names})["']?\s*:\s*(?:-?[\d_]+(?:\.\d+)?\s*[,}\n]|\{)`, "g");
  const keyHits = [];
  for (const m of code.matchAll(pair)) keyHits.push({ line: code.slice(0, m.index).split("\n").length, key: m[1] });
  const tables = [];
  let current = null;
  for (const hit of keyHits) {
    if (current && hit.line - current.last <= 2) {
      current.keys.add(hit.key);
      current.last = hit.line;
    } else {
      if (current) tables.push(current);
      current = { line: hit.line, last: hit.line, keys: new Set([hit.key]) };
    }
  }
  if (current) tables.push(current);
  return tables.filter((t) => t.keys.size >= 2).map((t) => ({ line: t.line, detail: `a table keyed by chain name (${[...t.keys].join(", ")}) holds per-chain numbers` }));
};

/** The default-coin layout flag, in code (comments stripped). */
export const legacyRootHits = (text) =>
  matchLines(scanSource(text).code, /\blegacyRoot\w*/).map((line) => ({ line, detail: "reads the default coin's layout flag `legacyRoot`" }));

const group = (perFile) => new Map([...perFile].filter(([, hits]) => hits.length > 0));

const sourceFiles = listSourceFiles(SOURCE_ROOTS, skipSource);
const workflowFiles = listFiles([WORKFLOW_DIR], (p) => /\.ya?ml$/.test(p) && !p.slice(WORKFLOW_DIR.length + 1).includes("/"));

const perSourceFile = (scan) => group(new Map(sourceFiles.map((f) => [f, scan(readRepoFile(f))])));
const perWorkflowFile = (scan) => group(new Map(workflowFiles.map((f) => [f, scan(readRepoFile(f))])));
const merge = (...maps) => {
  const out = new Map();
  for (const m of maps) for (const [k, v] of m) out.set(k, [...(out.get(k) ?? []), ...v]);
  return out;
};
const allowedMap = (entries) => new Map(entries);

// ---------------------------------------------------------------------------------------------------------
// Scanner tests, on small inline samples
// ---------------------------------------------------------------------------------------------------------

const SAMPLE_REGISTRY = {
  projects: [
    { slug: "tel", ticker: "TEL" },
    { slug: "zebec-network", ticker: "ZBCN" },
  ],
};
const SAMPLE_CONFIGS = {
  tel: {
    supply: { coingeckoId: "telcoin" },
    chains: [{ key: "ethereum", tokens: [{ address: "0x7E13b43065380acdec1c2d138c579cbbbafa0731" }], contracts: { bridge: { address: "0x6a7e6616653e84eee0c70257ec2e3d79a4476a7e" } } }],
  },
  "zebec-network": { chains: [{ key: "solana", vm: "solana", tokens: [{ address: "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU" }] }] },
};
const sampleIds = coinIdentifiers(SAMPLE_REGISTRY, SAMPLE_CONFIGS);

describe("coinIdentifiers", () => {
  it("collects slugs, tickers, CoinGecko ids and addresses, and leaves out chain family names", () => {
    expect([...sampleIds.words.keys()].sort()).toEqual(["tel", "telcoin", "zbcn", "zebec-network"]);
    expect(sampleIds.evmAddresses.get("0x7e13b43065380acdec1c2d138c579cbbbafa0731")).toBe("tel");
    expect(sampleIds.otherAddresses.get("ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU")).toBe("zebec-network");
    const withHedera = coinIdentifiers({ projects: [{ slug: "hedera", ticker: "HBAR" }] }, {});
    expect([...withHedera.words.keys()]).toEqual(["hbar"]);
  });

  it("reads the real registry, so a new coin is covered without editing this file", () => {
    const real = loadIdentifiers();
    expect(real.words.has("tel")).toBe(true);
    expect(real.words.size).toBeGreaterThanOrEqual(8);
    expect(real.evmAddresses.size).toBeGreaterThan(5);
  });
});

describe("coinLiteralHits", () => {
  it("flags a slug, ticker or CoinGecko id used as a value, in any quote style and case", () => {
    expect(coinLiteralHits('const p = "tel";', sampleIds)).toHaveLength(1);
    expect(coinLiteralHits("const p = 'TEL';", sampleIds)).toHaveLength(1);
    expect(coinLiteralHits("const p = `zebec-network`;", sampleIds)).toHaveLength(1);
    expect(coinLiteralHits('const id = " telcoin ";', sampleIds)).toHaveLength(1);
  });

  it("does not fire on tel inside a longer word: the match is the whole literal, not a substring", () => {
    for (const word of ["tell", "hotel", "telephone", "Intel", "tel-holders.json", "a tel b"]) {
      expect(coinLiteralHits(`const x = ${JSON.stringify(word)};`, sampleIds), word).toEqual([]);
    }
  });

  it("flags the slug as its own argument, and treats usage text in a longer string as prose", () => {
    expect(coinLiteralHits('spawn("node", ["x.js", "--project", "tel"]);', sampleIds)).toHaveLength(1);
    expect(coinLiteralHits('throw new Error("--project needs a slug, e.g. --project tel");', sampleIds)).toEqual([]);
  });

  it("ignores a mention in a comment, a template with an expression, or an identifier", () => {
    expect(coinLiteralHits('// const p = "tel";\n/* "zbcn" */\n/** the "tel" coin */\nconst x = 1;', sampleIds)).toEqual([]);
    expect(coinLiteralHits("const x = `${a}tel`;", sampleIds)).toEqual([]);
    expect(coinLiteralHits("const tel = 1; telTokens(tel);", sampleIds)).toEqual([]);
  });

  it("still sees a literal after a URL, a regex with a quote, a nested template and JSX text with an apostrophe", () => {
    expect(coinLiteralHits('const u = "https://example.com/a"; const p = "tel";', sampleIds)).toHaveLength(1);
    expect(coinLiteralHits('const r = /["\']/.test(s); const p = "tel";', sampleIds)).toHaveLength(1);
    expect(coinLiteralHits("const s = `a${b ? `x` : \"\"}c`; const p = 'tel';", sampleIds)).toHaveLength(1);
    expect(coinLiteralHits('const a = <p>Don\'t</p>;\nconst p = "tel";', sampleIds)).toEqual([{ line: 2, detail: expect.stringContaining('"tel"'), kind: "word" }]);
  });
});

describe("coinAddressHits", () => {
  it("flags a registered address in any case and a registered Solana mint, not an unregistered one", () => {
    expect(coinAddressHits('const a = "0x7e13b43065380acdec1c2d138c579cbbbafa0731";', sampleIds)).toHaveLength(1);
    expect(coinAddressHits('const a = "0X7E13B43065380ACDEC1C2D138C579CBBBAFA0731";', sampleIds)).toEqual([]);
    expect(coinAddressHits('const a = "0x7E13B43065380ACDEC1C2D138C579CBBBAFA0731";', sampleIds)).toHaveLength(1);
    expect(coinAddressHits('const m = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";', sampleIds)).toHaveLength(1);
    expect(coinAddressHits('const a = "0x1111111111111111111111111111111111111111";', sampleIds)).toEqual([]);
    expect(coinAddressHits('// "0x7e13b43065380acdec1c2d138c579cbbbafa0731"', sampleIds)).toEqual([]);
  });
});

describe("workflowCoinHits", () => {
  const yaml = [
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      project:",
    "        default: 'tel'",
    "        # default: zebec-network",
    "      note:",
    "        description: Refresh tell tales",
    "env:",
    "  HD_PROJECT: ${{ inputs.project || 'zebec-network' }}",
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: node scripts/x.js --project tel",
    "      - run: node scripts/y.js --project ${{ env.HD_PROJECT }}",
  ].join("\n");

  it("finds a registered slug as an input default, an env default and a command argument, and nothing else", () => {
    expect(workflowCoinHits(yaml, sampleIds).map((h) => h.line)).toEqual([5, 10, 14]);
  });
});

describe("chain words are not coin words", () => {
  const reserved = reservedChainWords(
    { ethereum: { key: "ethereum", name: "Ethereum" }, base: { key: "base", name: "Base" } },
    { z: { chains: [{ key: "solana", name: "Solana", vm: "solana" }, { key: "x", name: "Xchain", shortName: "XCH" }] } },
  );

  it("reserves exact keys, names, short names (of another coin) and vm names, and no prefix", () => {
    for (const word of ["ethereum", "base", "solana", "xch", "xchain", "evm", "hedera"]) expect(reserved.has(word, "newcoin"), word).toBe(true);
    for (const word of ["eth", "sol", "pol", "bas", "hed", "ba", "usdc"]) expect(reserved.has(word, "newcoin"), word).toBe(false);
  });

  it("does not let a coin reserve its own word, only another coin's chains do", () => {
    expect(reserved.has("xch", "z")).toBe(false);
    expect(reserved.has("xchain", "z")).toBe(false);
    expect(reserved.has("xch", "other")).toBe(true);
    expect(reserved.has("base", "z")).toBe(true); // from config/chains.json: fixed for every coin
  });

  it("drops a slug or ticker that is an exact chain word, and keeps prefixes and every other word", () => {
    const ids = coinIdentifiers({ projects: [{ slug: "base", ticker: "XCH" }, { slug: "newcoin", ticker: "SOL" }, { slug: "pol", ticker: "USDC" }] }, {}, reserved);
    expect([...ids.words.keys()].sort()).toEqual(["newcoin", "pol", "sol", "usdc"]);
    expect(coinLiteralHits('const a = "XCH"; const b = "base"; const c = "Base";', ids)).toEqual([]);
    expect(coinLiteralHits('const a = "SOL";', ids)).toHaveLength(1);
  });

  it("reads the real chain words from config, with no hand-kept list", () => {
    const real = reservedChainWords(readJson("config/chains.json"), { tel: readJson("config/projects/tel.json") });
    expect(real.has("ethereum", "other")).toBe(true);
    expect(real.has("polygon", "other")).toBe(true);
    expect(real.has("evm", "other")).toBe(true);
    expect(real.has("eth", "other")).toBe(true); // tel's chains[] short name, reserved for any other coin
    expect(real.has("eth", "tel")).toBe(false);
    expect(real.has("sol", "other")).toBe(false);
  });
});

describe("a coin whose word already appears in shared code", () => {
  const ids = coinIdentifiers({ projects: [{ slug: "newcoin", ticker: "USDC" }] }, {});

  it("fails on the existing literal and says the word is now a registered coin", () => {
    const hits = coinLiteralHits('const quote = "USDC";', ids);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toMatch(/reads as coin "newcoin".*registered coin word/);
  });

  it("tells the developer both fixes: read it from config, or record the entry with the reason", () => {
    expect(COIN_LITERAL_ADVICE).toMatch(/now a registered coin/);
    expect(COIN_LITERAL_ADVICE).toMatch(/read the value from the project's config/);
    expect(COIN_LITERAL_ADVICE).toMatch(/does not mean the coin.*ALLOWED_COIN_LITERALS.*reason/);
  });
});

describe("coinLiteralHits: a slug as a path segment or query value", () => {
  it("flags a slug that is a whole segment of a path, a template path or a query value", () => {
    expect(coinLiteralHits('const f = "public/data/zebec-network/x.json";', sampleIds)).toHaveLength(1);
    expect(coinLiteralHits("const f = `${dir}/tel/`;", sampleIds)).toHaveLength(1);
    expect(coinLiteralHits('const u = "/api?token=tel";', sampleIds)).toHaveLength(1);
    expect(coinLiteralHits('const u = "/api?a=1&project=tel&b=2";', sampleIds)).toHaveLength(1);
  });

  it("does not flag a word that only contains the slug, a ticker in a path, or a whole-literal match counted once", () => {
    for (const value of ["tel-holders.json", "hotel/x", "telephone", "a tel b", "public/data/telx/y.json", "ZBCN/x", "x/tel.json"]) {
      expect(coinLiteralHits(`const f = ${JSON.stringify(value)};`, sampleIds), value).toEqual([]);
    }
    expect(coinLiteralHits('const f = "tel";', sampleIds)).toHaveLength(1);
  });
});

describe("coinCodeHits", () => {
  const count = (text) => coinCodeHits(text, sampleIds).length;

  it("flags an unquoted object key and a member access that is a coin word", () => {
    expect(count("const a = { tel: 1, zbcn: 2 };")).toBe(2);
    expect(count("const a = {\n  telcoin: 1,\n};")).toBe(1);
    expect(coinCodeHits("const a = 1;\nconst b = { zbcn: 2 };", sampleIds)[0].line).toBe(2);
    expect(count("const x = data.tel;")).toBe(1);
    expect(count("const x = data?.zbcn?.total;")).toBe(1);
  });

  it("does not flag a longer name, a ternary, a quoted or commented mention, or a variable", () => {
    expect(count("const a = { telephone: 1, hotel: 2 };")).toBe(0);
    expect(count("const x = ok ? tel : other;")).toBe(0);
    expect(count("const x = data.telephone + data.tell;")).toBe(0);
    expect(count('const x = "data.tel"; const y = "{ tel: 1 }";')).toBe(0);
    expect(count("// { tel: 1 } and data.tel\nconst z = 1;")).toBe(0);
    expect(count("const tel = 1; use(tel);")).toBe(0);
  });

  it("flags a regex literal that is just a coin word, anchors and flags aside", () => {
    expect(count("const r = /^tel$/i;")).toBe(1);
    expect(count("const r = /tel/;")).toBe(1);
    expect(count("const r = /\\btelcoin\\b/g;")).toBe(1);
    expect(count("const r = /zebec-network/;")).toBe(1);
  });

  it("does not flag a regex that only contains a coin word, or division", () => {
    expect(count("const r = /tel-holders/;")).toBe(0);
    expect(count("const r = /^tell$/i;")).toBe(0);
    expect(count("const r = /^(?:tel|ondo)$/;")).toBe(0);
    expect(count("const r = a / tel / b;")).toBe(0);
  });
});

describe("workflowCoinHits: inline lists", () => {
  it("finds a coin in an inline list and in a matrix flow list, and not an unrelated list", () => {
    const yaml = [
      "inputs:",
      "  project: [tel, ondo]",
      "strategy:",
      "  matrix: { project: [zbcn, other] }",
      "  node: [20, 22]",
      "  names: ['tell', hotel]",
    ].join("\n");
    expect(workflowCoinHits(yaml, sampleIds).map((h) => h.line)).toEqual([2, 4]);
  });
});

describe("chainNameTableHits", () => {
  const names = new Set(["ethereum", "polygon", "base"]);
  it("flags a single-line and a nested multi-line table of numbers keyed by chain name", () => {
    expect(chainNameTableHits("const CHUNK = { ethereum: 800, polygon: 1000, base: 1000 };", names)).toHaveLength(1);
    expect(chainNameTableHits("const S = {\n  ethereum: { chunk: 1 },\n  polygon: { chunk: 2 },\n};", names)).toEqual([{ line: 2, detail: expect.stringContaining("ethereum, polygon") }]);
  });

  it("does not flag one chain, a table of strings, or two tables far apart", () => {
    expect(chainNameTableHits("const a = { ethereum: 1, other: 2 };", names)).toEqual([]);
    expect(chainNameTableHits('const a = { ethereum: "https://e", polygon: "https://p" };', names)).toEqual([]);
    expect(chainNameTableHits("const a = { ethereum: 1 };\n\n\n\nconst b = { polygon: 2 };", names)).toEqual([]);
    expect(chainNameTableHits("// { ethereum: 1, polygon: 2 }", names)).toEqual([]);
  });
});

describe("legacyRootHits", () => {
  it("flags the flag in code, not in a comment", () => {
    expect(legacyRootHits("if (cfg.data?.legacyRoot) return a;")).toHaveLength(1);
    expect(legacyRootHits("const s = legacyRootSlugs();")).toHaveLength(1);
    expect(legacyRootHits("// legacyRoot is TEL's layout\n/* legacyRoot */")).toEqual([]);
  });
});

describe("compareToAllowlist (shared)", () => {
  const advice = "read it from the project's config.";
  const run = (measured, allowed) => compareToAllowlist({ rule: "r", advice, measured: new Map(measured), allowed: new Map(allowed) });
  it("passes when counts match, and names file, line and rule otherwise", () => {
    const hit = (line) => ({ line, detail: "names coin" });
    expect(run([["a.js", [hit(1)]]], [["a.js", ENTRY(1, "x")]])).toEqual([]);
    expect(run([["b.js", [hit(7)]]], [])).toEqual([`b.js:7 [r] names coin. ${advice}`]);
    expect(run([["a.js", [hit(1), hit(2)]]], [["a.js", ENTRY(1, "x")]])[0]).toMatch(/a\.js \[r\] has 2 hits, the allowlist records 1 .*a\.js:2/);
    expect(run([["a.js", [hit(1)]]], [["a.js", ENTRY(3, "x")]])[0]).toMatch(/lower its count in the allowlist to 1/);
    expect(run([], [["c.js", ENTRY(1, "x")]])[0]).toMatch(/remove its allowlist entry/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------------------------------------

describe("shared code names no coin", () => {
  const ids = loadIdentifiers();

  it("scans real files", () => {
    expect(sourceFiles.length).toBeGreaterThan(300);
    expect(workflowFiles.length).toBeGreaterThan(10);
    expect(sourceFiles.some((f) => f.startsWith("src/components/"))).toBe(true);
    expect(sourceFiles.some((f) => f.startsWith("netlify/functions-src/"))).toBe(true);
    expect(sourceFiles.every((f) => !/\.test\.|datachecks|fixtures/.test(f))).toBe(true);
  });

  it("has no unlisted coin slug, ticker or CoinGecko id used as a value, and the list is exact", () => {
    const measured = merge(
      perSourceFile((text) => [...coinLiteralHits(text, ids), ...coinCodeHits(text, ids)]),
      perWorkflowFile((text) => workflowCoinHits(text, ids).filter((h) => h.kind === "word")),
    );
    assertNoProblems(
      compareToAllowlist({
        rule: "coin-literal",
        advice: COIN_LITERAL_ADVICE,
        measured,
        allowed: allowedMap(ALLOWED_COIN_LITERALS),
      }),
    );
  });

  it("has no unlisted registered token or contract address, and the list is exact", () => {
    const measured = merge(
      perSourceFile((text) => coinAddressHits(text, ids)),
      perWorkflowFile((text) => workflowCoinHits(text, ids).filter((h) => !h.kind)),
    );
    assertNoProblems(
      compareToAllowlist({
        rule: "coin-address",
        advice: "Read the address from the project's config (chains[].tokens / contracts) instead of writing it here.",
        measured,
        allowed: allowedMap(ALLOWED_ADDRESS_LITERALS),
      }),
    );
  });

  it("has no unlisted table of per-chain numbers keyed by chain name, and the list is exact", () => {
    const chainNames = CHAIN_NAME_KEYS();
    const measured = perSourceFile((text) => chainNameTableHits(text, chainNames));
    assertNoProblems(
      compareToAllowlist({
        rule: "chain-name-table",
        advice: "Put the number in the chain's entry in the project's config (or the chain adapter's capability), not in a table keyed by chain name.",
        measured,
        allowed: allowedMap(ALLOWED_CHAIN_TABLES),
      }),
    );
  });

  it(`reads legacyRoot only in ${PATH_HELPER_MODULE}, and the list is exact`, () => {
    const measured = perSourceFile((text) => legacyRootHits(text));
    measured.delete(PATH_HELPER_MODULE);
    assertNoProblems(
      compareToAllowlist({
        rule: "legacy-root",
        advice: `Ask the path helpers in ${PATH_HELPER_MODULE} (projectDataDir) for the directory instead of reading the layout flag.`,
        measured,
        allowed: allowedMap(ALLOWED_LEGACY_ROOT),
      }),
    );
  });

  it("keeps the default coin's schema names to the recorded number of files per pattern", () => {
    const problems = [];
    for (const { name, pattern, files, reason } of SCHEMA_PATTERNS) {
      const matching = [
        ...sourceFiles.filter((f) => pattern.test(scanSource(readRepoFile(f)).code)),
        ...workflowFiles.filter((f) => pattern.test(stripYamlComments(readRepoFile(f)))),
      ];
      if (matching.length > files) {
        problems.push(`[default-coin-schema] \`${name}\` appears in ${matching.length} files, the allowlist records ${files}. Name the shared snapshot and column through one helper or the project's config, not the default coin's own name. Why it is listed: ${reason}. Files: ${matching.join(", ")}`);
      } else if (matching.length < files) {
        problems.push(`[default-coin-schema] \`${name}\` appears in ${matching.length} files, fewer than the ${files} recorded: lower its count in SCHEMA_PATTERNS to ${matching.length}.`);
      }
    }
    assertNoProblems(problems);
  });
});
