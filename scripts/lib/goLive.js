/**
 * The single answer to "is this project complete and allowed to go live?".
 * A project is complete only when its config, every feed, its wallet-flows
 * report and its developer-wallet ledger exist and are current. There are no
 * skip flags, and a placeholder feed counts as a failure.
 */
import fs from "node:fs";
import path from "node:path";
import { loadRegistry, projectClassificationPath, projectDataPath, projectNonRetailPaths, projectRoleAddresses, projectWorkPath } from "./projects.js";
import { normalizeAddress } from "./nonRetailSet.js";
import { projectHasVm } from "./chainAdapters.js";
import { NULL_TX_RETRY_RUNS } from "./solana/flowScan.js";
import { forensicsRegistryProblems } from "./walletFlowsProject.js";
import { evaluateProjectHealth, isUnhealthy } from "./feedHealth.js";
import { projectHolderTiers } from "./holderTiers.js";
import { tierFingerprint } from "./tierFingerprint.js";
import { workflowPlan } from "../workflow-paths.js";

/** Reports are nightly: two days means one missed run is tolerated, a second one fails. */
export const MAX_REPORT_AGE_HOURS = 48;
export const GO_LIVE_SECTIONS = Object.freeze(["config", "feeds", "wallet-flows", "ledger"]);

const FLOW_FEEDS = Object.freeze(["exchange-flow-history.json", "tier-outflows.json"]);
/** Registry classes that are developer wallets; relays, staking contracts and escrow are exempt from the ledger. */
const DEVELOPER_CLASSES = Object.freeze(["treasury", "holdings", "association"]);
const MS_PER_HOUR = 3_600_000;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${file}: ${error.message}`);
  }
};

function configProblems(project, root) {
  const { config, slug } = project;
  const problems = [];
  if (!(Number(config.supply?.target) > 0)) problems.push(`${slug}: supply.target is not set`);
  if (!config.image) problems.push(`${slug}: image is not set`);
  else if (!fs.existsSync(path.join(root, "public", config.image))) problems.push(`${slug}: image file ${config.image} is missing`);
  const cex = config.classification?.cexWallets ? projectClassificationPath(project, "cexWallets", root) : null;
  if (!cex || !fs.existsSync(cex)) problems.push(`${slug}: classification.cexWallets file is missing`);
  if (config.gated?.forensics !== true) problems.push(`${slug}: gated.forensics must be true`);
  if (config.capabilities?.projectWallets !== true) problems.push(`${slug}: capabilities.projectWallets must be true`);
  if (config.pipeline?.feedsPending !== undefined) problems.push(`${slug}: pipeline.feedsPending is not allowed`);
  // Tiers are join keys sized for one token: every project derives its own (scripts/derive-holder-tiers.js).
  // Keeping the shared default needs an owner decision recorded as holders.defaultTiers.
  if (!Array.isArray(config.holders?.distributionTiers) && !String(config.holders?.defaultTiers ?? "").trim()) {
    problems.push(`${slug}: holders.distributionTiers is not set (derive them with node scripts/derive-holder-tiers.js --project ${slug})`);
  }
  return [...problems, ...sizingProblems(project), ...classificationProblems(project, root)];
}

/** One tier may not hold more than this share of wallets: such tiers cannot show movement between tiers. */
export const MAX_TIER_WALLET_SHARE = 0.9;

const hasEvidence = (value) => typeof value === "string" && value.trim().length >= 3;

/**
 * Thresholds every project must size to its own supply. holders.* falls back to the TEL-sized shared default
 * (config/holder-tiers.default.json), so a project with its own tiers must say its own cut-offs out loud.
 */
function sizingProblems(project) {
  const { config, slug } = project;
  const target = Number(config.supply?.target);
  const file = `config/projects/${slug}.json`;
  let tiers;
  try {
    tiers = projectHolderTiers(project);
  } catch (error) {
    return [`${slug}: ${error.message} (fix: correct the holders block in ${file})`];
  }
  const problems = [];
  const suggestedMega = target > 0 ? target / 5 : "20% of supply.target";
  if (target > 0 && !(tiers.megaHolderThreshold > 0 && tiers.megaHolderThreshold <= target)) {
    problems.push(
      `${slug}: holders.megaHolderThreshold ${tiers.megaHolderThreshold} must be > 0 and <= supply.target ${target}; ` +
        `an unlabelled wallet above it is dropped from holderCount and retail (fix: set "megaHolderThreshold": ${suggestedMega} in the holders block of ${file})`,
    );
  }
  const ownTiers = Array.isArray(config.holders?.distributionTiers) && !String(config.holders?.defaultTiers ?? "").trim();
  if (!ownTiers) return problems;
  for (const field of ["megaHolderThreshold", "retailThreshold"]) {
    if (!Number.isFinite(config.holders?.[field])) {
      problems.push(
        `${slug}: holders.${field} is not set, so it silently takes the shared default from config/holder-tiers.default.json (TEL-sized); ` +
          `fix: add "${field}" to the holders block of ${file} (run node scripts/derive-holder-tiers.js --project ${slug} for the suggested value)`,
      );
    }
  }
  if (Number.isFinite(config.holders?.retailThreshold) && !(tiers.retailThreshold < tiers.distributionTiers[0].min)) {
    problems.push(
      `${slug}: holders.retailThreshold ${tiers.retailThreshold} must be below the top tier's min ${tiers.distributionTiers[0].min} ` +
        `(fix: lower holders.retailThreshold in ${file})`,
    );
  }
  return problems;
}

const answersRel = (slug) => `config/projects/${slug}/onboarding.answers.json`;

/** The onboarding answers file: { doc } (null when absent) or { problem } when it cannot be read. */
function readAnswers(slug, root) {
  try {
    const doc = readJson(path.join(root, answersRel(slug)));
    return { doc: doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null };
  } catch (error) {
    return { problem: `${slug}: ${error.message} (fix: make ${answersRel(slug)} valid JSON)` };
  }
}

function readJsonOrNull(file) {
  return file && fs.existsSync(file) ? readJson(file) : null;
}

/** EVM hex lowercased, Solana base58 as written: the same normalization the non-retail loaders use. */
function addressSet(values) {
  const set = new Set();
  for (const value of values) {
    const address = normalizeAddress(value);
    if (address) set.add(address);
  }
  return set;
}

/** Same files and shapes as loadNonRetailSet (nonRetailSet.js), read synchronously. */
function classificationSets(project, root) {
  const paths = projectNonRetailPaths(project, root);
  const exclusions = readJsonOrNull(paths.exclusionsPath);
  const cex = addressSet((readJsonOrNull(paths.cexPath)?.wallets ?? []).map((w) => w?.address));
  const dexDoc = readJsonOrNull(paths.dexPath);
  const dexFile = addressSet([...(dexDoc?.pools ?? []), ...(dexDoc?.routers ?? [])].map((d) => d?.address));
  const dexRoles = addressSet(Object.values(projectRoleAddresses(project.config, { roles: ["dex"] })).flat().map((e) => e.address));
  const nonRetail = addressSet([
    ...(exclusions?.addresses ?? []),
    ...Object.values(exclusions?.chains ?? {}).flatMap((chain) => chain?.addresses ?? []),
    ...(paths.extraAddresses ?? []),
    ...cex,
    ...dexFile,
  ]);
  return { cex, dex: new Set([...dexFile, ...dexRoles]), nonRetail };
}

/**
 * CEX list, DEX pools and the onboarding answers' wallets. The DEX rule applies to a project that has an
 * answers file or `onboarding: true` in config/projects.json: projects mapped before the answers file existed
 * have no recorded decision to hold them to.
 */
function classificationProblems(project, root) {
  const { config, slug } = project;
  const answers = readAnswers(slug, root);
  if (answers.problem) return [answers.problem];
  const doc = answers.doc;
  const sets = classificationSets(project, root);
  const problems = [];
  const cexFile = config.classification?.cexWallets ? projectClassificationPath(project, "cexWallets", root) : null;
  if (cexFile && fs.existsSync(cexFile) && sets.cex.size === 0 && !(doc?.cex?.decision === "none-known" && hasEvidence(doc.cex.evidence))) {
    problems.push(
      `${slug}: the CEX wallet list ${path.relative(root, cexFile).split(path.sep).join("/")} has no entries; ` +
        `fix: add the exchange wallets that hold ${config.ticker ?? slug} (Solscan/Etherscan labels, proof of reserves), ` +
        `or record "cex": { "decision": "none-known", "evidence": "<where you looked>" } in ${answersRel(slug)}`,
    );
  }
  const registryEntry = loadRegistry(root).find((entry) => entry.slug === slug);
  const dexApplies = doc !== null || registryEntry?.onboarding === true || config.onboarding === true;
  if (dexApplies && sets.dex.size === 0 && !(doc?.dex?.decision === "none" && hasEvidence(doc.dex.evidence))) {
    problems.push(
      `${slug}: no DEX pool is resolved (no contracts{} entry with role "dex" and no pool in classification.dexContracts); ` +
        `fix: list every pool from https://dexscreener.com/ as a contracts{} role "dex" entry in config/projects/${slug}.json, ` +
        `or record "dex": { "decision": "none", "evidence": "<where you looked>" } in ${answersRel(slug)}`,
    );
  }
  for (const wallet of doc?.wallets ?? []) {
    const address = normalizeAddress(wallet?.address);
    if (address && sets.nonRetail.has(address)) continue;
    problems.push(
      `${slug}: ${answersRel(slug)} lists wallet ${wallet?.address} (${wallet?.label ?? "unlabelled"}) but it is not excluded as non-retail, ` +
        `so it counts as a retail holder; fix: add it to addresses in config/projects/${slug}/exclusions.json (or re-apply the answers file)`,
    );
  }
  return problems;
}

/** holders-lite's combined distribution: one tier holding most wallets cannot show movement between tiers. */
function largestTierProblems(project, root) {
  const lite = readJson(projectDataPath(project, "holders-lite.json", root));
  const tiers = (lite?.views?.combined?.distribution ?? []).filter((t) => Number(t?.count) > 0);
  const total = tiers.reduce((sum, t) => sum + Number(t.count), 0);
  if (total === 0) return [];
  const top = tiers.reduce((a, b) => (Number(b.count) > Number(a.count) ? b : a));
  const share = Number(top.count) / total;
  if (share <= MAX_TIER_WALLET_SHARE) return [];
  return [
    `${project.slug}: distribution tier ${top.label} holds ${(share * 100).toFixed(1)}% of wallets (limit ${MAX_TIER_WALLET_SHARE * 100}%); ` +
      `fix: node scripts/derive-holder-tiers.js --project ${project.slug}, put the result in holders.distributionTiers of config/projects/${project.slug}.json, then regenerate the feeds`,
  ];
}

/** Feed files `project` must publish: the refresh workflow's required files plus the flow feeds. */
export function requiredFeedFiles(project, root = process.cwd()) {
  const required = workflowPlan(project, root).HD_REQUIRED_FILES.split(/\s+/).filter(Boolean);
  return [...new Set([...required, ...FLOW_FEEDS])];
}

function feedProblems(project, root) {
  const problems = requiredFeedFiles(project, root)
    .filter((file) => !fs.existsSync(projectDataPath(project, file, root)))
    .map((file) => `${project.slug}: feed ${file} is missing`);
  for (const [file, rule] of Object.entries(project.config.health?.feeds ?? {})) {
    if (rule?.placeholder) problems.push(`${project.slug}: feed ${file} is still a placeholder`);
  }
  return problems;
}

/** A live project's feeds must also be healthy by pipeline-health's own rules (age, stale tail). */
function healthProblems(project, root, now, alreadyMissing) {
  return evaluateProjectHealth(project, { root, now })
    .results.filter((r) => isUnhealthy(r) && !(r.status === "missing" && alreadyMissing.has(r.file)))
    .map((r) => `${project.slug}: feed ${r.file} is ${r.status}${r.tailAgeDays != null ? ` (newest row ${r.tailAgeDays}d old)` : ""}`);
}

/** Tier outflows must have caught up, on the project's current tiers. */
function tierOutflowsProblems(project, root) {
  const doc = readJson(projectDataPath(project, "tier-outflows.json", root));
  if (!doc) return [];
  const problems = [];
  if (doc.complete !== true) problems.push(`${project.slug}: tier-outflows.json is not complete (dispatch generate-tier-outflows.yml until it is)`);
  const want = tierFingerprint(projectHolderTiers(project).distributionTiers);
  if (doc.tierFingerprint && doc.tierFingerprint !== want) {
    problems.push(`${project.slug}: tier-outflows.json was built on other tiers (fingerprint ${doc.tierFingerprint}, config ${want})`);
  }
  return problems;
}

function allFeedProblems(project, root, now) {
  const problems = feedProblems(project, root);
  const missing = new Set(requiredFeedFiles(project, root).filter((file) => !fs.existsSync(projectDataPath(project, file, root))));
  return [
    ...problems,
    ...healthProblems(project, root, now, missing),
    ...tierOutflowsProblems(project, root),
    ...heldCursorProblems(project, root),
    ...hederaFlowProblems(project, root),
    ...largestTierProblems(project, root),
  ];
}

function reportProblems(name, doc, slug, now) {
  if (!doc) return [`${slug}: ${name} report missing`];
  const ageHours = (now - Date.parse(doc.generated)) / MS_PER_HOUR;
  if (ageHours <= MAX_REPORT_AGE_HOURS) return [];
  return [`${slug}: ${name} report is ${Math.round(ageHours)}h old (limit ${MAX_REPORT_AGE_HOURS}h)`];
}

/**
 * A Solana transaction the RPC returns null for holds the flow cursor for
 * NULL_TX_RETRY_RUNS runs (scripts/lib/solana/flowScan.js). While any entry is
 * below that count the feed is incomplete on purpose, so it is not live-ready.
 * Go-live only (the `feeds` section): no workflow calls that section, so a held
 * cursor never fails the daily refresh-wallet-flows run.
 */
function heldCursorProblems(project, root) {
  if (!projectHasVm(project.config, "solana")) return [];
  const checkpoint = readJson(projectDataPath(project, "exchange-flow-checkpoint.json", root));
  return Object.entries(checkpoint?.chains ?? {}).flatMap(([chain, state]) =>
    (state?.unavailable ?? [])
      .filter((tx) => (tx.attempts ?? 0) < NULL_TX_RETRY_RUNS)
      .map((tx) => `${project.slug}: ${chain} flow cursor held, retrying transaction ${tx.signature} (attempt ${tx.attempts ?? 0} of ${NULL_TX_RETRY_RUNS})`),
  );
}

/**
 * A Hedera project's flow feeds claim a day only once every exchange account has been scanned to the settled
 * end (scripts/scan-hedera-flows.js). While any account is behind, or a page failed after retries, the cursor
 * is held on purpose and the feeds stamp no day, so the project is not live-ready (the Solana held-cursor rule).
 */
function hederaFlowProblems(project, root) {
  if (!projectHasVm(project.config, "hedera")) return [];
  const chains = readJson(projectDataPath(project, "exchange-flow-checkpoint.json", root))?.chains ?? {};
  const keys = (project.config.chains ?? []).filter((c) => c.vm === "hedera").map((c) => c.key);
  return keys.flatMap((key) => {
    const state = chains[key];
    if (!state) return [`${project.slug}: ${key} flow scan has not run (no cursors in exchange-flow-checkpoint.json)`];
    if (state.complete === true) return [];
    const failed = (state.failed ?? []).map((f) => `${f.account}: ${f.message}`).join("; ");
    return [`${project.slug}: ${key} flow cursor held, the scan has not reached the settled end${state.throughDate ? ` of ${state.throughDate}` : ""}${failed ? ` (${failed})` : ""}`];
  });
}

function walletFlowProblems(project, root, now) {
  const report = readJson(projectWorkPath(project, "forensics/wallet-flows.json", root));
  return [
    ...forensicsRegistryProblems(project, { root }),
    ...reportProblems("wallet-flows", report, project.slug, now),
  ];
}

const walletKey = (address) => (address.startsWith("0x") ? address.toLowerCase() : address);

function ledgerProblems(project, root, now) {
  const { slug } = project;
  const ledgerConfig = readJson(path.join(root, "config", "projects", slug, "ledger.json"));
  if (!ledgerConfig) return [`${slug}: config/projects/${slug}/ledger.json is missing`];
  const problems = reportProblems("ledger", readJson(path.join(root, "data", slug, "ledger", "ledger.json")), slug, now);
  const registry = readJson(projectWorkPath(project, "forensics/wallet-flows.registry.json", root));
  const known = new Set((registry?.knownWallets ?? []).map((wallet) => walletKey(wallet.address)));
  for (const { address } of ledgerConfig.developerWallets ?? []) {
    if (!known.has(walletKey(address))) problems.push(`${slug}: ledger wallet ${address} is not in the forensics registry`);
  }
  const inLedger = new Set((ledgerConfig.developerWallets ?? []).map((wallet) => walletKey(wallet.address)));
  for (const { address, entityClass } of registry?.knownWallets ?? []) {
    if (DEVELOPER_CLASSES.includes(entityClass) && !inLedger.has(walletKey(address))) {
      problems.push(`${slug}: ${entityClass} wallet ${address} is in the forensics registry but not in the ledger`);
    }
  }
  return problems;
}

/** Every reason `project` may not go live; [] means complete. `section` limits the check to one area. */
export function goLiveProblems(project, { root = process.cwd(), now = Date.now(), section } = {}) {
  if (section && !GO_LIVE_SECTIONS.includes(section)) throw new Error(`unknown section ${section} (use ${GO_LIVE_SECTIONS.join(", ")})`);
  const checks = {
    config: () => configProblems(project, root),
    feeds: () => allFeedProblems(project, root, now),
    "wallet-flows": () => walletFlowProblems(project, root, now),
    ledger: () => ledgerProblems(project, root, now),
  };
  return (section ? [section] : GO_LIVE_SECTIONS).flatMap((name) => checks[name]());
}
