/**
 * onboarding-answers/1: the ONE file that holds every owner judgement of an
 * onboarding (staking, treasury/team wallets, DEX pools, CEX list, history
 * mode, large-holder acknowledgements) and its expansion into the files the
 * shared pipeline reads. Pure apart from readProjectFiles / writeProjectFiles.
 *
 *   validateAnswers(raw)            -> { errors[], answers }   (self-contained messages)
 *   buildAnswersTemplate(facts)     -> a pre-filled file whose decisions FAIL validation
 *   applyAnswers(files, answers)    -> files with the answers merged in (idempotent)
 *   appliedMismatches(answers, files) -> where the config no longer reflects the answers
 *
 * Entries written by applyAnswers carry `fromAnswers: "<section>"`. A re-apply
 * replaces exactly those entries; hand-written entries (no marker) are never
 * touched, and an answers entry never duplicates a hand-written one for the
 * same address.
 */
import fs from "node:fs";
import path from "node:path";
import { canonicalAddressForVm, isAddressForVm } from "./address.js";
import { CANDIDATE_CHAINS } from "./tokenChains.js";
import { SLUG_RE } from "./projects.js";

export const ANSWERS_VERSION = "onboarding-answers/1";
export const FORWARD_ONLY = "forward-only";
export const PLACEHOLDER = "FILL_ME";
export const WALLET_CLASSES = Object.freeze(["treasury", "team", "holdings", "association", "escrow", "reward-vault"]);
/** stakeChanged: EVM contract emitting StakeChanged + stakedBy(address); zebecStakeV1: Zebec stake program; custody-only: a vault that holds tokens, no staker adapter. */
export const STAKING_KINDS = Object.freeze(["stakeChanged", "zebecStakeV1", "custody-only"]);
/** unresolved: a staking/locking mechanism exists but its address is not verified; validates, but --write refuses it (writeBlockers). */
export const STAKING_DECISIONS = Object.freeze(["none", "contracts", "unresolved"]);
const STAKING_KIND_VM = { stakeChanged: "evm", zebecStakeV1: "solana" };
const CONFIDENCE = ["high", "medium", "low"];
const TOP_KEYS = ["version", "address", "chain", "slug", "name", "ticker", "include", "historyStart", "staking", "wallets", "dex", "cex", "largeHolders", "copy"];
const CHAIN_KEYS = [...CANDIDATE_CHAINS.map((c) => c.key), "solana", "hedera"];

export const vmOfChain = (key) => (key === "solana" ? "solana" : key === "hedera" ? "hedera" : "evm");
export const answersRelPath = (slug) => `config/projects/${slug}/onboarding.answers.json`;
export const answersTemplateRelPath = (slug) => `tasks/onboard-${slug}.answers.json`;
const relPaths = (slug) => ({
  config: `config/projects/${slug}.json`,
  ledger: `config/projects/${slug}/ledger.json`,
  exclusions: `config/projects/${slug}/exclusions.json`,
  cex: `config/projects/${slug}/cex-wallets.json`,
  registry: `data/${slug}/forensics/wallet-flows.registry.json`,
  answers: answersRelPath(slug),
});

const HOW = {
  historyStart: 'a date YYYY-MM-DD (the token deploy date for EVM; the date holder history should start on) or "forward-only" (no backfill; history starts at the first snapshot). Pick one on purpose.',
  staking: 'look in the project docs/app for "stake"/"staking"/"vault"/"lockup" and open the token\'s top holders on the explorer for a contract holding a big balance. "contracts" = you found one and verified its address (list it). "none" = you searched the project docs and the explorer and NO staking, locking or vote-escrow mechanism exists (cite the pages in evidence); the site then states the token has no staking. If a mechanism exists and you cannot verify its address, set "unresolved" and stop: --write refuses it until the owner supplies the address or a source.',
  wallets: "treasury, team, foundation, allocation, escrow and reward-vault wallets from the project docs, a published wallet-disclosure post, or the explorer's labelled top holders. At least one is required (go-live needs a non-empty forensics registry). Delete the FILL_ME example row.",
  dex: 'DexScreener (https://dexscreener.com/<chain>/<token address>) lists every pool; the pool address (EVM) or, on Solana, the OWNER address of the pool\'s token account (the "Owner" column of the token\'s holder list on the explorer, not the token account itself) goes in pools[]. Use decision "none" only if there is no pool, and say where you looked.',
  cex: 'EVM-only projects: decision "spellbook" (the free Dune spellbook sync fills the list nightly). Solana/other VMs: "list" with at least one exchange wallet from a labelled source (Solscan/Arkham/exchange proof of reserves) or "none-known" with where you looked. After the first snapshot the runner lists every labelled exchange wallet that holds the token (Solana): put each in "wallets" (accepted) or in "rejected" with a note, then re-apply.',
  largeHolders: 'after the first snapshot, every top holder that is not a plain retail wallet: decision "labelled" (it must also be listed in wallets/dex/cex/staking), "retail" (checked, an ordinary wallet) or "unknown" (traced but the identity could not be established, and it is not an exchange/treasury/team wallet) plus a note. "retail" and "unknown" both count as holders and the runner raises holders.megaHolderThreshold above the wallet by itself; use "unknown" when you cannot vouch it is an ordinary holder. May be empty at onboarding.',
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const filled = (v) => typeof v === "string" && v.trim().length >= 3 && !v.trim().startsWith(PLACEHOLDER);
const canon = (a) => (/^0x/i.test(a) ? a.toLowerCase() : a);
const tail = (a) => canon(a).slice(-8).toLowerCase();
const uniq = (list) => [...new Set(list)];

/** Normalises + validates an answers object. Errors name the field, the allowed values and what to do. */
export function validateAnswers(raw) {
  const errors = [];
  const bad = (field, msg) => errors.push(`${field}: ${msg}`);
  if (!isObj(raw)) return { errors: ["answers: the file must be a JSON object. Generate one with: npm run onboard -- --address <token>"], answers: null };

  const unknown = Object.keys(raw).filter((k) => !k.startsWith("$") && !TOP_KEYS.includes(k));
  if (unknown.length) bad("answers", `unknown field(s) ${unknown.join(", ")}; allowed: ${TOP_KEYS.join(", ")}. Remove or rename them.`);
  if (raw.version !== ANSWERS_VERSION) bad("version", `must be "${ANSWERS_VERSION}", got ${JSON.stringify(raw.version)}`);

  const chain = typeof raw.chain === "string" ? raw.chain.trim().toLowerCase() : "";
  if (!CHAIN_KEYS.includes(chain)) bad("chain", `${JSON.stringify(raw.chain)} is not supported; use one of: ${CHAIN_KEYS.join(", ")} (the origin chain of the token)`);
  const vm = vmOfChain(chain);
  let address = typeof raw.address === "string" ? raw.address.trim() : "";
  if (chain === "hedera") {
    if (address !== "native") bad("address", 'a hedera project is the native coin; use "native"');
  } else if (CHAIN_KEYS.includes(chain)) {
    if (!isAddressForVm(vm, address)) bad("address", `${JSON.stringify(raw.address)} is not a valid ${vm} address for chain ${chain} (EVM: 0x + 40 hex; Solana: base58 mint)`);
    else address = canonicalAddressForVm(vm, address);
  }

  if (raw.slug !== undefined && !(typeof raw.slug === "string" && SLUG_RE.test(raw.slug))) bad("slug", `${JSON.stringify(raw.slug)} must match ${SLUG_RE} (lower-case letters, digits, dashes) or be removed`);
  for (const key of ["name", "ticker"]) if (raw[key] !== undefined && !filled(raw[key])) bad(key, `must be a non-empty string or be removed (discovery fills it)`);

  const include = [];
  if (raw.include !== undefined && !Array.isArray(raw.include)) bad("include", 'must be an array of chain keys, e.g. ["polygon"] (copies of the token on other chains that you confirmed are the same token)');
  for (const c of Array.isArray(raw.include) ? raw.include : []) {
    const key = String(c).trim().toLowerCase();
    if (key === chain || key === "hedera" || !CHAIN_KEYS.includes(key)) bad("include", `${JSON.stringify(c)} is not an extra chain; use chain keys other than the origin (${chain}) from: ${CHAIN_KEYS.filter((k) => k !== "hedera" && k !== chain).join(", ")}`);
    else include.push(key);
  }
  const projectChains = uniq([chain, ...include]);

  if (raw.historyStart !== FORWARD_ONLY) {
    const s = raw.historyStart;
    const ok = typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if (!ok) bad("historyStart", `${JSON.stringify(s)} is not allowed; use "YYYY-MM-DD" or "${FORWARD_ONLY}". ${HOW.historyStart}`);
  }

  const addressOk = (field, row) => {
    const c = String(row?.chain ?? "").trim().toLowerCase();
    if (!projectChains.includes(c)) {
      bad(`${field}.chain`, `${JSON.stringify(row?.chain)} is not one of this project's chains (${projectChains.join(", ")}); add the chain to include[] or fix the value`);
      return null;
    }
    const rowVm = vmOfChain(c);
    if (!isAddressForVm(rowVm, row?.address)) {
      bad(`${field}.address`, `${JSON.stringify(row?.address)} is not a valid ${rowVm} address (EVM: 0x + 40 hex; Solana: base58)`);
      return null;
    }
    return { chain: c, address: canonicalAddressForVm(rowVm, row.address) };
  };
  const needText = (field, v, what) => {
    if (!filled(v)) bad(field, `required: ${what} (not empty, not ${PLACEHOLDER})`);
    return typeof v === "string" ? v.trim() : "";
  };
  const decision = (section, node, allowed) => {
    if (!isObj(node)) {
      bad(section, `missing. ${HOW[section]}`);
      return null;
    }
    if (!allowed.includes(node.decision)) bad(`${section}.decision`, `${JSON.stringify(node.decision)} is not allowed; use one of: ${allowed.join(" | ")}. ${HOW[section]}`);
    const evidence = needText(`${section}.evidence`, node.evidence, "a URL or one sentence saying where you checked");
    return { decision: node.decision, evidence };
  };
  const rows = (section, list, build, { min = 0, why = "" } = {}) => {
    if (list === undefined) list = [];
    if (!Array.isArray(list)) {
      bad(section, "must be an array");
      return [];
    }
    if (list.length < min) bad(section, `needs at least ${min} row(s)${why}`);
    const seen = new Set();
    const out = [];
    list.forEach((row, i) => {
      const where = `${section}[${i}]`;
      if (!isObj(row)) {
        bad(where, "must be an object");
        return;
      }
      const built = build(row, where);
      if (!built) return;
      const k = `${built.chain}:${built.address}`;
      if (seen.has(k)) bad(where, `duplicate ${k}; list each (chain, address) once`);
      seen.add(k);
      out.push(built);
    });
    return out;
  };
  // A list field that a decision does not read is still checked: {"a": 1} must not validate just because it is ignored.
  const notList = (section, v) => {
    if (v !== undefined && !Array.isArray(v)) bad(section, "must be an array");
  };
  const confidenceOf = (where, row) => {
    if (!CONFIDENCE.includes(row.confidence)) bad(`${where}.confidence`, `${JSON.stringify(row.confidence)} is not allowed; use one of: ${CONFIDENCE.join(" | ")}`);
    return row.confidence;
  };

  // staking
  const staking = decision("staking", raw.staking, STAKING_DECISIONS);
  if (staking) {
    const stakingRows = Array.isArray(raw.staking?.contracts) ? raw.staking.contracts : [];
    if (raw.staking?.decision !== "contracts") notList("staking.contracts", raw.staking?.contracts);
    staking.contracts = raw.staking?.decision === "contracts"
      ? rows("staking.contracts", raw.staking?.contracts, (r, where) => {
          const a = addressOk(where, r);
          const label = needText(`${where}.label`, r.label, "a human label, e.g. \"FOO staking vault\"");
          if (!STAKING_KINDS.includes(r.kind)) bad(`${where}.kind`, `${JSON.stringify(r.kind)} is not allowed; use one of: ${STAKING_KINDS.join(" | ")} (stakeChanged = EVM contract with StakeChanged events and stakedBy(address); zebecStakeV1 = Zebec stake program on Solana; custody-only = vault that only holds tokens)`);
          else if (a && STAKING_KIND_VM[r.kind] && vmOfChain(a.chain) !== STAKING_KIND_VM[r.kind]) bad(where, `kind ${r.kind} needs a ${STAKING_KIND_VM[r.kind]} chain, got ${a.chain}`);
          if (r.kind === "stakeChanged" && !(Number.isInteger(r.deployBlock) && r.deployBlock >= 0)) bad(`${where}.deployBlock`, "required integer for stakeChanged (the block the staking contract was deployed at; read it from the explorer's creation tx)");
          return a && STAKING_KINDS.includes(r.kind) ? { ...a, kind: r.kind, label, ...(Number.isInteger(r.deployBlock) ? { deployBlock: r.deployBlock } : {}) } : null;
        }, { min: 1, why: ' when decision is "contracts"' })
      : [];
    if (["none", "unresolved"].includes(raw.staking?.decision) && stakingRows.length) bad("staking.contracts", `must be empty when decision is "${raw.staking.decision}"; set decision "contracts" or remove the rows`);
  }

  // wallets
  const wallets = rows("wallets", raw.wallets, (r, where) => {
    const a = addressOk(where, r);
    const label = needText(`${where}.label`, r.label, "a human label, e.g. \"FOO Foundation multisig\"");
    if (!WALLET_CLASSES.includes(r.class)) bad(`${where}.class`, `${JSON.stringify(r.class)} is not allowed; use one of: ${WALLET_CLASSES.join(" | ")}`);
    const source = needText(`${where}.source`, r.source, "a URL or sentence proving the wallet belongs to the project");
    const confidence = confidenceOf(where, r);
    return a && WALLET_CLASSES.includes(r.class) ? { ...a, label, class: r.class, source, confidence } : null;
  }, { min: 1, why: `. ${HOW.wallets}` });
  const classByAddress = new Map();
  for (const w of wallets) {
    const prev = classByAddress.get(w.address);
    if (prev && prev !== w.class) bad("wallets", `${w.address} is listed with two classes (${prev}, ${w.class}); pick one`);
    classByAddress.set(w.address, w.class);
  }

  // dex
  const dex = decision("dex", raw.dex, ["none", "pools"]);
  if (dex) {
    dex.pools = raw.dex?.decision === "pools"
      ? rows("dex.pools", raw.dex?.pools, (r, where) => {
          const a = addressOk(where, r);
          const label = needText(`${where}.label`, r.label, "a label, e.g. \"Orca FOO/SOL pool\"");
          const source = needText(`${where}.source`, r.source, "a URL (DexScreener / explorer page of the pool)");
          return a ? { ...a, label, source } : null;
        }, { min: 1, why: ' when decision is "pools"' })
      : [];
    if (raw.dex?.decision !== "pools") notList("dex.pools", raw.dex?.pools);
    if (raw.dex?.decision === "none" && Array.isArray(raw.dex?.pools) && raw.dex.pools.length) bad("dex.pools", 'must be empty when decision is "none"');
  }

  // cex
  const cex = decision("cex", raw.cex, ["spellbook", "list", "none-known"]);
  if (cex) {
    const allEvm = projectChains.every((c) => vmOfChain(c) === "evm");
    if (raw.cex?.decision === "spellbook" && !allEvm) bad("cex.decision", `"spellbook" only works when every chain is EVM (project chains: ${projectChains.join(", ")}); use "list" with at least one exchange wallet, or "none-known" with where you looked. ${HOW.cex}`);
    cex.wallets = raw.cex?.decision === "list"
      ? rows("cex.wallets", raw.cex?.wallets, (r, where) => {
          const a = addressOk(where, r);
          const exchange = needText(`${where}.exchange`, r.exchange, "the exchange name, e.g. \"Binance\"");
          const source = needText(`${where}.source`, r.source, "a URL or sentence (Solscan tag, Arkham, proof of reserves)");
          const confidence = confidenceOf(where, r);
          return a ? { ...a, exchange, source, confidence } : null;
        }, { min: 1, why: ' when decision is "list"' })
      : [];
    if (raw.cex?.decision !== "list") notList("cex.wallets", raw.cex?.wallets);
    if (raw.cex?.decision !== "list" && Array.isArray(raw.cex?.wallets) && raw.cex.wallets.length) bad("cex.wallets", 'only allowed when decision is "list"');
    // One address is either a project wallet or an exchange, never both.
    for (const w of cex.wallets) {
      if (wallets.some((p) => p.chain === w.chain && p.address === w.address)) bad("cex.wallets", `${w.address} is also in wallets; an address is either a project wallet or an exchange wallet, not both`);
    }
    // Exchange-labelled wallets the runner listed after the first snapshot and the owner checked and refused.
    cex.rejected = rows("cex.rejected", raw.cex?.rejected, (r, where) => {
      const a = addressOk(where, r);
      const note = needText(`${where}.note`, r.note, "one sentence on why this is not an exchange wallet of the project's token flow");
      if (a && cex.wallets.some((w) => w.chain === a.chain && w.address === a.address)) bad(where, `${a.address} is also in cex.wallets; accept it or reject it, not both`);
      return a ? { ...a, note } : null;
    });
  }

  // largeHolders (may be empty; each row must be decided)
  const listed = new Set([...wallets, ...(dex?.pools ?? []), ...(cex?.wallets ?? []), ...(staking?.contracts ?? [])].map((r) => `${r.chain}:${r.address}`));
  const largeHolders = rows("largeHolders", raw.largeHolders, (r, where) => {
    const a = addressOk(where, r);
    if (!["retail", "labelled", "unknown"].includes(r.decision)) bad(`${where}.decision`, `${JSON.stringify(r.decision)} is not allowed; use retail | labelled | unknown. ${HOW.largeHolders}`);
    const note = needText(`${where}.note`, r.note, "one sentence on how you decided");
    if (a && r.decision === "labelled" && !listed.has(`${a.chain}:${a.address}`)) bad(where, `decision "labelled" but ${a.address} is not in wallets/dex/cex/staking; add it there first (that is what labels it)`);
    return a && ["retail", "labelled", "unknown"].includes(r.decision) ? { ...a, decision: r.decision, note } : null;
  });

  let copy;
  if (raw.copy !== undefined) {
    if (!isObj(raw.copy) || Object.keys(raw.copy).some((k) => k !== "description")) bad("copy", 'must be { "description": "<one sentence>" } or be removed');
    else copy = { description: needText("copy.description", raw.copy.description, "one sentence describing the token") };
  }

  if (errors.length) return { errors, answers: null };
  const answers = {
    version: ANSWERS_VERSION,
    address,
    chain,
    ...(raw.slug ? { slug: raw.slug } : {}),
    ...(raw.name ? { name: raw.name.trim() } : {}),
    ...(raw.ticker ? { ticker: raw.ticker.trim().toUpperCase() } : {}),
    include,
    historyStart: raw.historyStart,
    staking,
    wallets,
    dex,
    cex,
    largeHolders,
    ...(copy ? { copy } : {}),
  };
  return { errors, answers };
}

/**
 * Reasons valid answers still cannot be written into the config (--write refuses; a dry run and the validator accept them).
 * Each one is a decision the owner must finish, never one a model may pick the nearest legal value for.
 */
export function writeBlockers(answers) {
  const out = [];
  if (answers?.staking?.decision === "unresolved") {
    out.push(
      'staking.decision is "unresolved": a staking or locking mechanism exists and its contract/program address is not verified, so the site must not claim there is none. ' +
        'Ask the owner for the address or a source. Then set decision "contracts" and list it (kind "custody-only" if there is no adapter for that mechanism), with the source as evidence, and run the command again.',
    );
  }
  return out;
}

/** Throws one Error naming every writeBlockers reason; call it before anything is written. */
export function assertWritable(answers, label = "answers file") {
  const blockers = writeBlockers(answers);
  if (blockers.length) throw new Error(`${label} cannot be written yet:\n  - ${blockers.join("\n  - ")}`);
}

/** Throws one Error naming every problem, for CLI use. */
export function assertAnswers(raw, label = "answers file") {
  const { errors, answers } = validateAnswers(raw);
  if (errors.length) throw new Error(`${label} is invalid:\n  - ${errors.join("\n  - ")}`);
  return answers;
}

/** A pre-filled answers file whose decision fields fail validation until a person (or model) answers them. */
export function buildAnswersTemplate({ address, chain, slug, name, ticker, includeCandidates = [], historyStart = null }) {
  return {
    $readme: `Fill every ${PLACEHOLDER} (and delete the example wallet row), then run: npm run onboard -- --address ${address} --answers <this file> --write. Validation errors say what to fix. Every decision needs evidence (a URL or a sentence).`,
    version: ANSWERS_VERSION,
    address,
    chain,
    slug,
    name,
    ticker,
    include: [],
    ...(includeCandidates.length ? { $includeCandidates: `copies discovery found; move a chain key into include[] only after you confirmed it is the same token and bridged: ${includeCandidates.join(", ")}` } : {}),
    historyStart: historyStart ?? PLACEHOLDER,
    $historyStartHow: HOW.historyStart,
    staking: { decision: PLACEHOLDER, evidence: PLACEHOLDER, contracts: [], $howTo: HOW.staking, $contractRow: { chain, address: PLACEHOLDER, kind: STAKING_KINDS.join(" | "), label: PLACEHOLDER, deployBlock: "integer, required for stakeChanged" } },
    wallets: [{ chain, address: PLACEHOLDER, label: PLACEHOLDER, class: WALLET_CLASSES.join(" | "), source: PLACEHOLDER, confidence: CONFIDENCE.join(" | ") }],
    $walletsHow: HOW.wallets,
    dex: { decision: PLACEHOLDER, evidence: PLACEHOLDER, pools: [], $howTo: HOW.dex },
    cex: { decision: PLACEHOLDER, evidence: PLACEHOLDER, wallets: [], rejected: [], $howTo: HOW.cex },
    largeHolders: [],
    $largeHoldersHow: HOW.largeHolders,
  };
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * class -> where it lands. role: contracts{} role (non-retail in the snapshot, feeds the supply
 * categories); exclusion: also an exclusions label (association wallets, as ondo); ledger/registry:
 * developerWallets / knownWallets entityClass+group (escrow is registry-only: go-live exempts it from
 * the ledger); category: treasury.categories bucket; subtract: supply.circulating.subtract;
 * sub: supply.developerHoldings subcategory.
 *
 * Circulating (owner decision 2026-11-12: team/holdings leave circulating on every coin but TEL):
 * treasury, association, team and holdings are subtracted; escrow and reward-vault are not.
 * Both team and holdings land in the `holdings` category (there is no separate `team` bucket).
 * treasury.categories lists ONLY `treasury` (and only when a treasury/association wallet exists): reconcile-supply omits a
 * category whose balance is 0 and append-treasury-history then aborts the whole daily refresh, so a bucket that can be
 * emptied (team/holdings) stays out, as on ONDO and ZBCN. The `holdings` bucket still leaves circulating via `subtract`.
 * TEL keeps its own explicit ["treasury","council"] in config/projects/tel.json.
 */
export const WALLET_EFFECTS = Object.freeze({
  treasury: { role: "treasury", ledger: ["treasury", "Treasury"], registry: ["treasury", "Treasury"], category: "treasury", subtract: "treasury", sub: ["treasury", "Treasury & association wallets"] },
  association: { exclusion: true, ledger: ["association", "Association"], registry: ["association", "Association"], category: "treasury", subtract: "treasury", sub: ["treasury", "Treasury & association wallets"] },
  team: { role: "holdings", ledger: ["holdings", "Team"], registry: ["holdings", "Team"], subtract: "holdings", sub: ["holdings", "Team & holdings wallets"] },
  holdings: { role: "holdings", ledger: ["holdings", "Holdings"], registry: ["holdings", "Holdings"], subtract: "holdings", sub: ["holdings", "Team & holdings wallets"] },
  escrow: { role: "escrow", registry: ["escrow", "Escrow"], sub: ["escrow", "Escrow"] },
  "reward-vault": { role: "staking", ledger: ["holdings", "Reward vault"], registry: ["holdings", "Reward vault"], sub: ["staking", "Reward vaults"] },
});
const CLASS_ORDER = ["treasury", "association", "team", "holdings", "escrow", "reward-vault"];

// Re-applying must not reorder files: marked entries are replaced in place, hand entries stay where they are,
// new entries append. `wanted` is a Map key -> value (values get the marker).
// `report(address, label)` is called for every answers-derived row a re-apply drops (the owner removed the wallet).
function mergeObject(old, section, wanted, report) {
  const out = {};
  for (const [k, v] of Object.entries(old ?? {})) {
    if (v?.fromAnswers !== section) out[k] = v;
    else if (wanted.has(k)) out[k] = { ...wanted.get(k), fromAnswers: section };
    else report?.(v?.address ?? k, v?.label ?? v?.name ?? "");
  }
  for (const [k, v] of wanted) if (!(k in out)) out[k] = { ...v, fromAnswers: section };
  return out;
}

function mergeList(old, section, rows, keyOf, report, conflict) {
  const hand = new Set((old ?? []).filter((r) => r?.fromAnswers !== section).map(keyOf));
  for (const r of rows) if (hand.has(keyOf(r))) conflict?.(r.address, r.label ?? r.name ?? "");
  const wanted = new Map(rows.filter((r) => !hand.has(keyOf(r))).map((r) => [keyOf(r), { ...r, fromAnswers: section }]));
  const out = [];
  for (const r of old ?? []) {
    if (r?.fromAnswers !== section) out.push(r);
    else if (wanted.has(keyOf(r))) {
      out.push(wanted.get(keyOf(r)));
      wanted.delete(keyOf(r));
    } else report?.(r?.address ?? keyOf(r), r?.label ?? r?.name ?? "");
  }
  return [...out, ...wanted.values()];
}

// report(address, label, chainKey); conflict(address, label, chainKey) fires when a hand-written entry (no marker) already holds the address.
function setContracts(cfg, section, entries, report, conflict) {
  for (const c of cfg.chains) {
    const old = c.contracts ?? {};
    const others = Object.entries(old).filter(([, v]) => v?.fromAnswers !== section);
    const takenAddress = new Set(others.map(([, v]) => v?.address && canon(v.address)));
    const handAddress = new Set(others.filter(([, v]) => !v?.fromAnswers).map(([, v]) => v?.address && canon(v.address)));
    const takenKey = new Set(others.map(([k]) => k));
    const wanted = new Map();
    for (const e of entries.filter((x) => x.chain === c.key)) {
      if (takenAddress.has(e.address)) { // a hand-written entry for this address wins
        if (handAddress.has(e.address)) conflict?.(e.address, e.label, c.key);
        continue;
      }
      takenAddress.add(e.address);
      const base = `${e.prefix}-${tail(e.address)}`;
      let key = base;
      for (let n = 2; takenKey.has(key); n++) key = `${base}-${n}`;
      takenKey.add(key);
      wanted.set(key, { address: e.address, role: e.role, label: e.label, $comment: e.comment });
    }
    c.contracts = mergeObject(old, section, wanted, (address, label) => report?.(address, label, c.key));
  }
}

/** What a set of answers wallets writes into the three shared lists (categories, circulating subtract, developerHoldings subcategories). */
function walletDerived(wallets) {
  const effects = CLASS_ORDER.filter((c) => wallets.some((w) => w.class === c)).map((c) => WALLET_EFFECTS[c]);
  return {
    categories: uniq(effects.map((e) => e.category).filter(Boolean)),
    subtract: uniq(effects.map((e) => e.subtract).filter(Boolean)),
    subs: effects.map((e) => e.sub),
  };
}

const CLASS_BUCKET = { treasury: "treasury", association: "treasury", holdings: "holdings", escrow: "escrow" };

/** Buckets still used by a wallet nobody re-derives from the answers' wallets section (hand-written contracts{} roles, labels, ledger and registry rows, answers staking contracts). */
function bucketsInUse(out, rel) {
  const used = new Set();
  for (const c of out[rel.config].chains ?? []) {
    for (const v of Object.values(c.contracts ?? {})) if (v?.fromAnswers !== "wallets" && v?.role) used.add(v.role);
  }
  for (const v of Object.values(out[rel.exclusions]?.labels ?? {})) if (v?.fromAnswers !== "wallets" && v?.category) used.add(v.category);
  for (const file of [out[rel.ledger]?.developerWallets, out[rel.registry]?.knownWallets]) {
    for (const r of file ?? []) if (r?.fromAnswers !== "wallets" && CLASS_BUCKET[r?.entityClass]) used.add(CLASS_BUCKET[r.entityClass]);
  }
  return used;
}

function applyWallets(out, rel, answers, { onRemoved, onReclassified, onConflict }) {
  const cfg = out[rel.config];
  const wallets = answers.wallets ?? [];
  const previousWallets = out[rel.answers]?.wallets ?? [];
  // A row dropped for a wallet the answers still list is a class change (reported once below), not a removal.
  const listed = new Set(wallets.map((w) => `${w.chain}:${w.address}`));
  const listedAddress = new Set(wallets.map((w) => w.address));
  const removed = (file, perChain = false) => (address, label, chain) => {
    if (perChain ? listed.has(`${chain}:${canon(address)}`) : listedAddress.has(canon(address))) return;
    onRemoved?.({ file, address, label });
  };
  const conflict = (file) => (address, label) => onConflict?.({ file, address, label });
  const previousByKey = new Map(previousWallets.map((w) => [`${w.chain}:${w.address}`, w]));
  for (const w of wallets) {
    const was = previousByKey.get(`${w.chain}:${w.address}`);
    if (was && (was.class !== w.class || was.label !== w.label)) onReclassified?.({ chain: w.chain, address: w.address, from: { class: was.class, label: was.label }, to: { class: w.class, label: w.label } });
  }
  const sorted = [...wallets].sort((a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class));
  setContracts(cfg, "wallets", sorted.filter((w) => WALLET_EFFECTS[w.class].role).map((w) => ({
    chain: w.chain, address: w.address, role: WALLET_EFFECTS[w.class].role, prefix: w.class, label: w.label,
    comment: `${w.source} (confidence ${w.confidence}; onboarding.answers.json class ${w.class})`,
  })), removed(rel.config, true), conflict(rel.config));

  const byAddress = new Map();
  for (const w of sorted) {
    const cur = byAddress.get(w.address);
    if (cur) cur.chains = uniq([...cur.chains, w.chain]);
    else byAddress.set(w.address, { ...w, chains: [w.chain] });
  }
  const merged = [...byAddress.values()];
  const row = (w, [entityClass, group]) => ({ address: w.address, label: w.label, group, entityClass, chains: w.chains, confidence: w.confidence, source: w.source });
  out[rel.ledger].developerWallets = mergeList(out[rel.ledger].developerWallets, "wallets", merged.filter((w) => WALLET_EFFECTS[w.class].ledger).map((w) => row(w, WALLET_EFFECTS[w.class].ledger)), (r) => canon(r.address), removed(rel.ledger), conflict(rel.ledger));
  out[rel.registry].knownWallets = mergeList(out[rel.registry].knownWallets, "wallets", merged.filter((w) => WALLET_EFFECTS[w.class].registry).map((w) => row(w, WALLET_EFFECTS[w.class].registry)), (r) => canon(r.address), removed(rel.registry), conflict(rel.registry));

  const ex = (out[rel.exclusions] ??= { addresses: [], labels: {} });
  const previous = Object.entries(ex.labels ?? {}).filter(([, v]) => v?.fromAnswers === "wallets").map(([a]) => a);
  const handLabelled = (m) => Boolean(ex.labels?.[m.address] && ex.labels[m.address].fromAnswers !== "wallets");
  for (const m of merged) if (WALLET_EFFECTS[m.class].exclusion && handLabelled(m)) conflict(rel.exclusions)(m.address, m.label);
  const wantedLabels = new Map(
    merged.filter((m) => WALLET_EFFECTS[m.class].exclusion && !handLabelled(m)).map((w) => [w.address, {
      category: "treasury",
      name: w.label,
      evidenceTier: "owner-supplied",
      confidence: w.confidence,
      note: `${w.source}. Association-controlled wallet: counts as Treasury, not retail (onboarding.answers.json).`,
    }]),
  );
  ex.labels = mergeObject(ex.labels, "wallets", wantedLabels, removed(rel.exclusions));  ex.addresses = [...(ex.addresses ?? []).filter((a) => !previous.includes(a) || wantedLabels.has(a)), ...[...wantedLabels.keys()].filter((a) => !(ex.addresses ?? []).includes(a))];
  cfg.classification = { ...cfg.classification, exclusions: rel.exclusions };

  if (!wallets.length) return;
  // Entries the previous answers derived that no wallet (answers or hand-written) uses any more are dropped, so a removed team wallet leaves no stale bucket.
  const next = walletDerived(wallets);
  const before = walletDerived(previousWallets);
  const used = bucketsInUse(out, rel);
  const stale = (list, nextList) => before[list].filter((x) => !nextList.includes(x) && !used.has(x));
  const reportStale = (file, what, values) => values.forEach((v) => onRemoved?.({ file, address: "-", label: `${what} "${v}" (no wallet uses it any more)` }));

  const dropCategories = stale("categories", next.categories);
  reportStale(rel.config, "treasury.categories", dropCategories);
  cfg.treasury = { ...cfg.treasury, categories: uniq([...(cfg.treasury?.categories ?? []).filter((c) => !dropCategories.includes(c)), ...next.categories]) };

  const dropSubtract = stale("subtract", next.subtract);
  reportStale(rel.config, "supply.circulating.subtract", dropSubtract);
  const supply = { ...cfg.supply };
  const subtract = uniq([...(supply.circulating?.subtract ?? []).filter((c) => !dropSubtract.includes(c)), ...next.subtract]);
  if (subtract.length || supply.circulating) supply.circulating = { ...supply.circulating, subtract };

  const nextSubCategories = next.subs.map(([category]) => category);
  const dropSubs = before.subs.map(([category]) => category).filter((c) => !nextSubCategories.includes(c) && !used.has(c));
  reportStale(rel.config, "supply.developerHoldings.subcategories", dropSubs);
  const subs = (supply.developerHoldings?.subcategories ?? []).filter((s) => !dropSubs.includes(s.category));
  for (const [category, label] of next.subs) if (!subs.some((s) => s.category === category)) subs.push({ category, label });
  supply.developerHoldings = { ...supply.developerHoldings, subcategories: subs };
  cfg.supply = supply;
}

function applyStaking(out, rel, answers, onRemoved) {
  const cfg = out[rel.config];
  const { decision, evidence, contracts } = answers.staking;
  const removed = (address, label) => onRemoved?.({ file: rel.config, address, label });
  setContracts(cfg, "staking", contracts.map((s) => ({ chain: s.chain, address: s.address, role: "staking", prefix: "staking", label: s.label, comment: `${s.kind}; ${evidence}` })), removed);
  cfg.staking = mergeList(cfg.staking, "staking", contracts.filter((s) => s.kind !== "custody-only").map((s) => ({
    chain: s.chain, address: s.address, name: s.label, kind: s.kind, ...(s.deployBlock !== undefined ? { deployBlock: s.deployBlock } : {}),
    attribution: `onboarding.answers.json: ${evidence}`,
  })), (r) => `${r.chain}:${canon(r.address)}`, removed);
  const feeds = { ...cfg.health?.feeds };
  const stakeChanged = contracts.some((s) => s.kind === "stakeChanged");
  if (stakeChanged) {
    if (feeds["funding-wallets.json"]?.disabled === true) delete feeds["funding-wallets.json"];
  } else feeds["funding-wallets.json"] ??= { disabled: true };
  cfg.health = { ...cfg.health, feeds };
  const waivers = Object.fromEntries(Object.entries(cfg.nightly?.waivers ?? {}).filter(([, v]) => !String(typeof v === "string" ? v : v?.reason).startsWith("[answers]")));
  if (!contracts.some((s) => s.kind === "stakeChanged" || s.kind === "zebecStakeV1")) {
    waivers["staker-balances"] ??= `[answers] ${decision === "none" ? "No staking mechanism" : "Staking contracts are custody-only (no staker-balance adapter)"}: ${evidence}`;
  }
  cfg.nightly = { ...cfg.nightly, waivers };
}

function applyDex(out, rel, answers, onRemoved) {
  setContracts(out[rel.config], "dex", answers.dex.pools.map((p) => ({ chain: p.chain, address: p.address, role: "dex", prefix: "dex", label: p.label, comment: p.source })), (address, label) => onRemoved?.({ file: rel.config, address, label }));
}

function applyCex(out, rel, answers, onRemoved) {
  const file = (out[rel.cex] ??= { wallets: [] });
  const rows = answers.cex.decision === "list"
    ? answers.cex.wallets.map((w) => ({ address: w.address, label: w.exchange, walletName: w.exchange, source: w.source, confidence: w.confidence }))
    : [];
  file.wallets = mergeList(file.wallets, "cex", rows, (r) => canon(r.address), (address, label) => onRemoved?.({ file: rel.cex, address, label }));
  out[rel.config].classification = { ...out[rel.config].classification, cexWallets: rel.cex };
}

/**
 * Merges `answers` into `files` ({ relPath: object|undefined }) and returns the new map; `files` is not mutated.
 * `sections` limits the expansion (add-project --wallet uses ["wallets"]).
 * `onRemoved({ file, address, label })` is called for every answers-derived row a re-apply drops for a wallet the answers no longer list.
 * `onReclassified({ chain, address, from, to })` is called once per wallet still listed whose class or label changed (its rows are replaced, not removed).
 * `onConflict({ file, address, label })` is called when a hand-written row (no marker) holds an address the answers list: the hand-written row wins and is not touched.
 */
export function applyAnswers(files, answers, { slug, sections, onRemoved, onReclassified, onConflict } = {}) {
  const rel = relPaths(slug);
  const out = structuredClone(files);
  if (!out[rel.config]) throw new Error(`${rel.config} not found: scaffold the project first`);
  const keys = new Set(out[rel.config].chains.map((c) => c.key));
  const used = [answers.chain, ...(answers.include ?? []), ...(answers.wallets ?? []).map((w) => w.chain), ...(answers.dex?.pools ?? []).map((p) => p.chain), ...(answers.staking?.contracts ?? []).map((s) => s.chain), ...(answers.cex?.wallets ?? []).map((w) => w.chain)];
  const missing = uniq(used.filter((c) => c && !keys.has(c)));
  if (missing.length) throw new Error(`answers use chain(s) ${missing.join(", ")} that config/projects/${slug}.json does not configure (${[...keys].join(", ")}); list them in include[] and re-run discovery`);

  const full = !sections;
  const on = new Set(sections ?? ["wallets", "staking", "dex", "cex", "history", "copy"]);
  if (on.has("wallets") && !(out[rel.ledger] && out[rel.registry])) throw new Error(`${rel.ledger} and ${rel.registry} must exist to apply wallets: scaffold the project first`);
  if (on.has("wallets")) applyWallets(out, rel, answers, { onRemoved, onReclassified, onConflict });
  if (on.has("staking")) applyStaking(out, rel, answers, onRemoved);
  if (on.has("dex")) applyDex(out, rel, answers, onRemoved);
  if (on.has("cex")) applyCex(out, rel, answers, onRemoved);
  if (on.has("history")) {
    const pipeline = { ...out[rel.config].pipeline };
    if (answers.historyStart === FORWARD_ONLY) delete pipeline.historyStart;
    else pipeline.historyStart = answers.historyStart;
    if (Object.keys(pipeline).length) out[rel.config].pipeline = pipeline;
    else delete out[rel.config].pipeline;
  }
  if (on.has("copy") && answers.copy?.description) out[rel.config].description = answers.copy.description;
  if (full) out[rel.answers] = { ...answers, slug };
  return out;
}

const roleOf = (cfg, chain, address, wanted) =>
  Object.values(cfg.chains.find((c) => c.key === chain)?.contracts ?? {}).some((v) => v?.address && canon(v.address) === address && v.role === wanted);

/** Reasons the config no longer reflects `answers` (empty when it does). */
export function appliedMismatches(answers, files, slug) {
  const rel = relPaths(slug);
  const cfg = files[rel.config];
  const ledger = files[rel.ledger];
  const registry = files[rel.registry];
  const labels = files[rel.exclusions]?.labels ?? {};
  const out = [];
  if (!cfg) return [`${rel.config} is missing`];
  const labelled = (address) => Object.keys(labels).some((a) => canon(a) === address);
  for (const w of answers.wallets ?? []) {
    const fx = WALLET_EFFECTS[w.class];
    const id = `wallet ${w.chain}:${w.address} (${w.class}, ${w.label})`;
    if (fx.role && !roleOf(cfg, w.chain, w.address, fx.role)) out.push(`${id}: no contracts{} entry with role "${fx.role}" on ${w.chain}`);
    if (fx.exclusion && !labelled(w.address)) out.push(`${id}: not labelled in exclusions.json (it would count as retail)`);
    if (fx.ledger && !(ledger?.developerWallets ?? []).some((r) => canon(r.address) === w.address)) out.push(`${id}: missing from ledger.json developerWallets`);
    if (fx.registry && !(registry?.knownWallets ?? []).some((r) => canon(r.address) === w.address)) out.push(`${id}: missing from wallet-flows.registry.json knownWallets`);
    if (fx.category && !(cfg.treasury?.categories ?? []).includes(fx.category)) out.push(`${id}: treasury.categories lacks "${fx.category}"`);
    if (fx.subtract && !(cfg.supply?.circulating?.subtract ?? []).includes(fx.subtract)) out.push(`${id}: supply.circulating.subtract lacks "${fx.subtract}"`);
  }
  const staking = answers.staking;
  if (staking?.decision === "none" && (cfg.staking ?? []).length) out.push("staking: answers say none but config staking[] is not empty");
  for (const s of staking?.contracts ?? []) {
    if (!roleOf(cfg, s.chain, s.address, "staking")) out.push(`staking ${s.chain}:${s.address}: no contracts{} entry with role "staking"`);
    if (s.kind !== "custody-only" && !(cfg.staking ?? []).some((e) => e.chain === s.chain && canon(e.address) === s.address && e.kind === s.kind)) out.push(`staking ${s.chain}:${s.address}: missing from staking[] with kind ${s.kind}`);
  }
  if ((staking?.contracts ?? []).some((s) => s.kind === "stakeChanged") && cfg.health?.feeds?.["funding-wallets.json"]?.disabled === true) out.push("staking: funding-wallets.json health feed is disabled but a stakeChanged contract exists");
  for (const p of answers.dex?.pools ?? []) if (!roleOf(cfg, p.chain, p.address, "dex")) out.push(`dex pool ${p.chain}:${p.address}: no contracts{} entry with role "dex"`);
  if (answers.cex) {
    if (!cfg.classification?.cexWallets) out.push("cex: classification.cexWallets is not set");
    if (!files[rel.cex]) out.push(`cex: ${rel.cex} is missing`);
    for (const w of answers.cex.wallets ?? []) if (!(files[rel.cex]?.wallets ?? []).some((r) => canon(r.address) === w.address)) out.push(`cex wallet ${w.address}: missing from ${rel.cex}`);
  }
  if (answers.historyStart === FORWARD_ONLY ? cfg.pipeline?.historyStart !== undefined : cfg.pipeline?.historyStart !== answers.historyStart) out.push(`historyStart: answers say ${answers.historyStart} but pipeline.historyStart is ${cfg.pipeline?.historyStart ?? "unset"}`);
  return out;
}

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined);

/** The files applyAnswers reads/writes for `slug` under `root` (undefined when absent). */
export function readProjectFiles(root, slug) {
  return Object.fromEntries(Object.values(relPaths(slug)).map((r) => [r, readJson(path.join(root, r))]));
}

/** Writes the files of `files` that differ from disk; returns the relative paths written. */
export function writeProjectFiles(root, files, { dryRun = false } = {}) {
  const written = [];
  for (const [r, doc] of Object.entries(files)) {
    if (doc === undefined) continue;
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    const file = path.join(root, r);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) continue;
    written.push(r);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return written;
}
