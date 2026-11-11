#!/usr/bin/env node
/**
 * onboard-run.js — take a scaffolded project from "config on main" to "check-go-live passes".
 *
 *   node scripts/onboard-run.js --project <slug> [--dry-run]
 *   (GitHub Actions: onboard-project.yml runs it with --commit, --push-cmd and --redispatch)
 *
 * Reads the project's files from origin/main (a `git archive` copy, so the local
 * checkout is never touched), works out the first unfinished step of the
 * first-data order (scripts/lib/onboardRun.js), runs it, waits, and repeats:
 *   CEX list, snapshot, own tiers, snapshot on those tiers, history backfill,
 *   exchange flows, treasury/CEX history, tier outflows, staker balances,
 *   wallet flows, ledger, Developer wallets tab, check-go-live, then removes the
 *   registry's `onboarding: true` so the next manual deploy lists the token.
 * Workflow steps are dispatched with `gh workflow run` on main and watched to the end.
 * Config steps (tiers, projectWallets, the onboarding flag) edit the checkout:
 * with --commit they are committed and pushed (--push-cmd); without it the run
 * stops and asks for the edit to be reviewed and merged, then re-run.
 *
 * Exit codes: 0 done or handed to the next round; 1 a workflow failed; 2 blocked
 * on a decision only a person can make (printed); 3 a config edit awaits review.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { MAX_RUNS_PER_STEP, nextStep, onboardingSteps } from "./lib/onboardRun.js";

const MAX_ROUNDS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const utcToday = () => new Date().toISOString().slice(0, 10);

export function parseArgs(argv) {
  const out = { dryRun: false, commit: false, redispatch: false, round: 1, budgetMin: Infinity, pushCmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--project") out.project = v();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--commit") out.commit = true;
    else if (a === "--redispatch") out.redispatch = true;
    else if (a === "--round") out.round = Number(v()) || 1;
    else if (a === "--budget-min") out.budgetMin = Number(v());
    else if (a === "--push-cmd") out.pushCmd = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.project) throw new Error("--project <slug> is required");
  return out;
}

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A copy of origin/main's config, token images and this project's data, in a temp dir. */
function snapshotMain(slug) {
  git(["fetch", "--quiet", "origin", "main"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `onboard-${slug}-`));
  let legacyRoot = false;
  try {
    legacyRoot = JSON.parse(git(["show", `origin/main:config/projects/${slug}.json`])).data?.legacyRoot === true;
  } catch {
    // Not on main yet: evaluate() reports it.
  }
  // A legacy-root project (TEL) keeps its feeds in public/data/ and its work files in data/.
  const wanted = ["config", "public/tokens", ...(legacyRoot ? ["public/data", "data"] : [`public/data/${slug}`, `data/${slug}`])];
  const present = wanted.filter((p) => {
    try {
      git(["cat-file", "-e", `origin/main:${p}`]);
      return true;
    } catch {
      return false;
    }
  });
  const tar = path.join(dir, "main.tar");
  git(["archive", "--format=tar", "-o", tar, "origin/main", ...present]);
  execFileSync("tar", ["-xf", tar, "-C", dir]);
  fs.rmSync(tar);
  return dir;
}

async function evaluate(slug) {
  const root = snapshotMain(slug);
  try {
    const { resolveProject, loadRegistry } = await import("./lib/projects.js");
    const { goLiveProblems } = await import("./lib/goLive.js");
    const entry = loadRegistry(root).find((p) => p.slug === slug);
    if (!entry) throw new Error(`${slug} is not in config/projects.json on main: run npm run onboard -- --write, review, and merge the scaffold first`);
    const project = resolveProject(slug, root);
    const readJson = (rel) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
      } catch {
        return null;
      }
    };
    const steps = onboardingSteps({
      slug,
      config: project.config,
      readJson,
      today: utcToday(),
      goLive: goLiveProblems(project, { root }),
      onboardingFlag: entry.onboarding === true,
    });
    return { steps, root };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

function runsOf(workflow) {
  return JSON.parse(gh(["run", "list", "--workflow", workflow, "--limit", "10", "--json", "databaseId,status,conclusion,createdAt,event"]));
}

async function dispatchAndWait(workflow, inputs, logger) {
  const active = runsOf(workflow).find((r) => ACTIVE.has(r.status));
  let id = active?.databaseId;
  if (id) {
    logger.log(`  ${workflow}: run ${id} already ${active.status}; waiting for it instead of dispatching`);
  } else {
    const since = Date.now() - 10_000;
    gh(["workflow", "run", workflow, "--ref", "main", ...Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`])]);
    for (let i = 0; i < 30 && !id; i++) {
      await sleep(4000);
      id = runsOf(workflow).find((r) => r.event === "workflow_dispatch" && Date.parse(r.createdAt) >= since)?.databaseId;
    }
    if (!id) throw new Error(`${workflow}: dispatched but no run appeared`);
    logger.log(`  ${workflow}: dispatched run ${id} (${Object.entries(inputs).map(([k, v]) => `${k}=${v}`).join(" ")})`);
  }
  try {
    execFileSync("gh", ["run", "watch", String(id), "--interval", "60", "--exit-status"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    // Exit status is read from the run below.
  }
  const { conclusion, url } = JSON.parse(gh(["run", "view", String(id), "--json", "conclusion,url"]));
  return { id, conclusion, url };
}

/** Config edits the orchestrator may make. Each returns the files it changed. */
async function applyEdit(edit, slug, mainRoot, logger) {
  const cwd = process.cwd();
  const cfgRel = `config/projects/${slug}.json`;
  const readCfg = () => JSON.parse(fs.readFileSync(path.join(cwd, cfgRel), "utf8"));
  const writeJson = (rel, doc) => fs.writeFileSync(path.join(cwd, rel), `${JSON.stringify(doc, null, 2)}\n`);
  if (edit === "derive-tiers") {
    const { deriveHolderTiers, MAX_TIER_SHARE } = await import("./lib/deriveHolderTiers.js");
    const snap = JSON.parse(fs.readFileSync(path.join(mainRoot, "public/data", slug, "tel-holders.json"), "utf8"));
    const result = deriveHolderTiers((snap.wallets ?? []).map((w) => Number(w.total_telcoin_balance)));
    if (result.largestTierShare > MAX_TIER_SHARE) {
      return { blocked: `derived tiers put ${(result.largestTierShare * 100).toFixed(1)}% of wallets in one tier (limit ${MAX_TIER_SHARE * 100}%): set holders.distributionTiers by hand` };
    }
    const cfg = readCfg();
    cfg.holders = {
      ...(cfg.holders ?? {}),
      $comment: `Derived by scripts/derive-holder-tiers.js from ${slug}'s own snapshot of ${snap.generatedAt?.slice(0, 10) ?? utcToday()} (${result.holders} holders).`,
      distributionTiers: result.distributionTiers,
      balanceRanges: result.balanceRanges,
    };
    writeJson(cfgRel, cfg);
    logger.log(`  tiers: ${result.distributionTiers.map((t) => t.label).join(", ")}`);
    return { files: [cfgRel], message: `${slug}: holder tiers derived from its own first snapshot` };
  }
  if (edit === "enable-project-wallets") {
    const cfg = readCfg();
    cfg.capabilities = { ...(cfg.capabilities ?? {}), projectWallets: true };
    writeJson(cfgRel, cfg);
    return { files: [cfgRel], message: `${slug}: Developer wallets tab on (ledger report committed)` };
  }
  if (edit === "clear-onboarding-flag") {
    const reg = JSON.parse(fs.readFileSync(path.join(cwd, "config/projects.json"), "utf8"));
    reg.projects = reg.projects.map((p) => (p.slug === slug ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== "onboarding")) : p));
    writeJson("config/projects.json", reg);
    return { files: ["config/projects.json"], message: `${slug}: check-go-live passes; list it on the site (shows after the next manual deploy)` };
  }
  throw new Error(`unknown edit ${edit}`);
}

function commitAndPush(files, message, pushCmd) {
  git(["add", ...files]);
  git(["commit", "-m", `${message} [skip netlify]`]);
  execFileSync(pushCmd.split(" ")[0], pushCmd.split(" ").slice(1), { stdio: "inherit" });
}

export async function main(argv = process.argv.slice(2), { logger = console } = {}) {
  const args = parseArgs(argv);
  const slug = args.project;
  const started = Date.now();
  const runs = {};
  logger.log(`Onboarding ${slug} (round ${args.round}${args.dryRun ? ", dry run" : ""})`);

  for (;;) {
    const { steps, root } = await evaluate(slug);
    try {
      for (const s of steps) logger.log(`  [${s.done ? "x" : " "}] ${s.id.padEnd(22)} ${s.why}`);
      const step = nextStep(steps);
      if (!step) {
        logger.log(`\n${slug} is onboarded: check-go-live passes and it is listed. Deploy from the Netlify dashboard to publish.`);
        return 0;
      }
      if (step.blocked || !step.action) {
        logger.log(`\nBlocked at ${step.id}:\n${step.blocked ?? step.why}`);
        return 2;
      }
      if (args.dryRun) {
        logger.log(`\nNext: ${step.id} -> ${step.action.workflow ? `gh workflow run ${step.action.workflow} ${Object.entries(step.action.inputs ?? {}).map(([k, v]) => `-f ${k}=${v}`).join(" ")}` : `config edit ${step.action.edit}`}`);
        return 0;
      }
      if ((Date.now() - started) / 60_000 > args.budgetMin) {
        if (args.redispatch && args.round < MAX_ROUNDS) {
          gh(["workflow", "run", "onboard-project.yml", "--ref", "main", "-f", `project=${slug}`, "-f", `round=${args.round + 1}`]);
          logger.log(`\nTime budget used; dispatched round ${args.round + 1}.`);
          return 0;
        }
        logger.log(`\nTime budget used at ${step.id}; re-run onboard-project.yml to continue.`);
        return 0;
      }
      runs[step.id] = (runs[step.id] ?? 0) + 1;
      if (runs[step.id] > MAX_RUNS_PER_STEP) {
        logger.log(`\n${step.id} is still not done after ${MAX_RUNS_PER_STEP} runs (${step.why}). Read the last run's log; re-dispatch onboard-project.yml once fixed.`);
        return 2;
      }

      if (step.action.edit) {
        const r = await applyEdit(step.action.edit, slug, root, logger);
        if (r.blocked) {
          logger.log(`\nBlocked at ${step.id}: ${r.blocked}`);
          return 2;
        }
        if (!args.commit) {
          logger.log(`\nEdited ${r.files.join(", ")} (${r.message}). Review, merge to main, then re-run.`);
          return 3;
        }
        commitAndPush(r.files, r.message, args.pushCmd ?? "bash scripts/push-main.sh");
        continue;
      }

      for (const a of [step.action, ...(step.action.more ?? [])]) {
        const result = await dispatchAndWait(a.workflow, a.inputs, logger);
        if (result.conclusion === "cancelled") {
          logger.log(`  ${a.workflow}: run ${result.id} was cancelled (another run took the shared queue slot); retrying`);
          continue;
        }
        if (result.conclusion !== "success") {
          logger.log(`\n${a.workflow} run ${result.id} ended ${result.conclusion}: ${result.url}`);
          return 1;
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[onboard-run] ${err.message}`);
      process.exit(1);
    });
}
