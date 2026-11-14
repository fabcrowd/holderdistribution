/**
 * nightlyPlan.js — one shared nightly job list (config/nightly-jobs.json)
 * applied to every project in config/projects.json.
 *
 * A project runs a job when it has every capability the job `requires`
 * (derived from its config, never from a slug), unless its
 * config/projects/<slug>.json declares `nightly.waivers.<jobId>` with a
 * non-empty reason. Parity is the default; a gap must be written down.
 *
 * Capabilities:
 *   evm / solana / hedera  the project declares a chain on that VM
 *   stakeChanged        a StakeChanged staking contract (TEL staker balances)
 *   zebecStakeV1        a Zebec stake program (Solana staking)
 *   forensicsRegistry   <workDir>/forensics/wallet-flows.registry.json exists
 *   ledgerConfig        config/projects/<slug>/ledger.json exists
 *
 * Consumers: scripts/workflow-paths.js (`matrix <sel> --job <id>`, `job <id>`),
 * scripts/pipeline-health.js (freshness SLAs, pipeline-status.json),
 * scripts/lib/nightlyPlan.test.js (CI parity test).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadRegistry, resolveProject, projectChainKeysByVm, projectStakingContracts, projectWorkDir } from "./projects.js";

export const NIGHTLY_JOBS_FILE = "config/nightly-jobs.json";
export const PROVIDERS = Object.freeze(["public", "blockscout", "etherscan", "helius", "coingecko", "alchemy"]);

export function loadNightlyJobs(root = process.cwd()) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(root, NIGHTLY_JOBS_FILE), "utf8"));
  const jobs = raw.jobs ?? [];
  const ids = new Set();
  for (const j of jobs) {
    if (!j.id || ids.has(j.id)) throw new Error(`${NIGHTLY_JOBS_FILE}: missing or duplicate job id ${JSON.stringify(j.id)}`);
    ids.add(j.id);
    for (const p of j.providers ?? []) if (!PROVIDERS.includes(p)) throw new Error(`${NIGHTLY_JOBS_FILE}: job ${j.id} has unknown provider ${p}`);
    if (j.alchemyOnly && (j.providers ?? []).some((p) => p !== "alchemy")) throw new Error(`${NIGHTLY_JOBS_FILE}: job ${j.id} is alchemyOnly but lists other providers`);
    if ((j.providers ?? []).includes("alchemy") && j.providers.at(-1) !== "alchemy") throw new Error(`${NIGHTLY_JOBS_FILE}: job ${j.id} must list alchemy last`);
  }
  return jobs;
}

export function projectCapabilities(project, root = process.cwd()) {
  const caps = new Set();
  if (projectChainKeysByVm(project.config, "evm").length) caps.add("evm");
  if (projectChainKeysByVm(project.config, "solana").length) caps.add("solana");
  if (projectChainKeysByVm(project.config, "hedera").length) caps.add("hedera");
  if (projectStakingContracts(project, { kind: "stakeChanged" }).length) caps.add("stakeChanged");
  if (projectStakingContracts(project, { kind: "zebecStakeV1" }).length) caps.add("zebecStakeV1");
  if (fs.existsSync(path.resolve(root, projectWorkDir(project), "forensics/wallet-flows.registry.json"))) caps.add("forensicsRegistry");
  if (fs.existsSync(path.resolve(root, "config/projects", project.slug, "ledger.json"))) caps.add("ledgerConfig");
  return caps;
}

/**
 * Providers a job may use for this project. Alchemy serves EVM chains only (no
 * Alchemy Solana nodes), so a project without an EVM chain never lists it.
 */
export function providersFor(job, caps) {
  const list = job.providers ?? [];
  return list.filter((p) => (p !== "alchemy" || caps.has("evm")) && (p !== "helius" || caps.has("solana")));
}

/** @returns {{ id:string, status:"run"|"waived"|"n/a", reason:string|null, providers:string[] }} */
export function jobStatusFor(job, project, caps) {
  const providers = providersFor(job, caps);
  const waiver = project.config?.nightly?.waivers?.[job.id];
  if (waiver !== undefined) {
    const reason = typeof waiver === "string" ? waiver : waiver?.reason;
    if (!reason || !String(reason).trim()) throw new Error(`project ${project.slug}: nightly.waivers.${job.id} needs a reason`);
    return { id: job.id, status: "waived", reason: String(reason), providers };
  }
  const missing = (job.requires ?? []).filter((c) => !caps.has(c));
  if (missing.length) return { id: job.id, status: "n/a", reason: `lacks ${missing.join(", ")}`, providers };
  if (providers.length === 0) return { id: job.id, status: "n/a", reason: "alchemyOnly job and no EVM chain (Alchemy serves no Solana chain)", providers };
  return { id: job.id, status: "run", reason: null, providers };
}

/** Full project × job plan. Broken project configs are reported, never thrown. */
export function nightlyPlan(root = process.cwd()) {
  const jobs = loadNightlyJobs(root);
  const projects = [];
  for (const { slug } of loadRegistry(root)) {
    try {
      const project = resolveProject(slug, root);
      for (const id of Object.keys(project.config?.nightly?.waivers ?? {})) {
        if (!jobs.some((j) => j.id === id)) throw new Error(`nightly.waivers.${id}: no such job in ${NIGHTLY_JOBS_FILE}`);
      }
      const caps = projectCapabilities(project, root);
      projects.push({ slug, capabilities: [...caps].sort(), jobs: jobs.map((j) => jobStatusFor(j, project, caps)) });
    } catch (err) {
      projects.push({ slug, error: err.message, jobs: [] });
    }
  }
  return { jobs, projects };
}

export function findJob(jobId, root = process.cwd()) {
  const job = loadNightlyJobs(root).find((j) => j.id === jobId);
  if (!job) throw new Error(`unknown nightly job ${JSON.stringify(jobId)} (see ${NIGHTLY_JOBS_FILE})`);
  return job;
}

/** True when `slug` runs `jobId` tonight. */
export function projectRunsJob(slug, jobId, root = process.cwd()) {
  const job = findJob(jobId, root);
  const project = resolveProject(slug, root);
  return jobStatusFor(job, project, projectCapabilities(project, root)).status === "run";
}

/** Env a job step exports so rpc.js enforces its provider order and budget. */
export function jobEnv(jobId, root = process.cwd(), slug = null) {
  const job = findJob(jobId, root);
  const caps = slug ? projectCapabilities(resolveProject(slug, root), root) : new Set(["evm"]);
  const evm = caps.has("evm");
  return {
    HD_JOB_ID: job.id,
    HD_JOB_PROVIDERS: providersFor(job, caps).join(","),
    HD_JOB_ALCHEMY_ONLY: job.alchemyOnly ? "true" : "false",
    HD_JOB_ALCHEMY_CU_BUDGET: evm ? String(Number(job.alchemyCuPerNight) || 0) : "0",
    HD_JOB_BUDGET_MODE: evm && job.budgetMode === "warn" ? "warn" : "enforce",
  };
}

/** Map a TEL-layout output path onto `project` (same rule as workflow-paths files mode). */
export function projectOutputPath(project, tPath) {
  // "{slug}" marks a path that is per-project for every project, TEL included (e.g. the ledger).
  if (tPath.includes("{slug}")) return tPath.replaceAll("{slug}", project.slug);
  if (project.config?.data?.legacyRoot === true) return tPath;
  if (tPath.startsWith("public/data/")) return path.posix.join(project.dataDir, tPath.slice("public/data/".length));
  if (tPath.startsWith("data/")) return path.posix.join(projectWorkDir(project), tPath.slice("data/".length));
  return tPath;
}
