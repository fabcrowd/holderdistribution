/**
 * The single answer to "is this project complete and allowed to go live?".
 * A project is complete only when its config, every feed, its wallet-flows
 * report and its developer-wallet ledger exist and are current. There are no
 * skip flags, and a placeholder feed counts as a failure.
 */
import fs from "node:fs";
import path from "node:path";
import { projectClassificationPath, projectDataPath, projectWorkPath } from "./projects.js";
import { projectHasVm } from "./chainAdapters.js";
import { NULL_TX_RETRY_RUNS } from "./solana/flowScan.js";
import { forensicsRegistryProblems } from "./walletFlowsProject.js";
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
  return problems;
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
    feeds: () => [...feedProblems(project, root), ...heldCursorProblems(project, root)],
    "wallet-flows": () => walletFlowProblems(project, root, now),
    ledger: () => ledgerProblems(project, root, now),
  };
  return (section ? [section] : GO_LIVE_SECTIONS).flatMap((name) => checks[name]());
}
