#!/usr/bin/env node
/**
 * onboard-run.js — take a scaffolded project from "config on main" to "check-go-live passes".
 *
 *   node scripts/onboard-run.js --project <slug> [--dry-run [--local]]
 *   --local (with --dry-run only) evaluates the plan on the working tree instead of origin/main.
 *   (GitHub Actions: onboard-project.yml runs it with --commit, --push-cmd and --redispatch)
 *
 * Reads the project's files from origin/main (a `git archive` copy, so the local
 * checkout is never touched), works out the first unfinished step of the
 * first-data order (scripts/lib/onboardRun.js), runs it, waits, and repeats:
 *   answers check, CEX list, snapshot, CEX candidate review (Solana: spellbook-labelled exchange
 *   wallets that hold the token, each accepted or rejected in the answers), large-holder review, own tiers and sizing,
 *   snapshot on those tiers, history backfill (or "forward-only"), exchange flows,
 *   treasury/CEX history, tier outflows, staker balances, wallet flows, ledger,
 *   Developer wallets tab, strict alignment (one more refresh until the feeds share
 *   asOf and day cutoffs), check-go-live, then removes the registry's
 *   `onboarding: true` so the next manual deploy lists the token. The review,
 *   history-mode and alignment gates apply only to a project with `onboarding: true`
 *   or an answers file. Every stop prints a `Fix:` block (lib/onboardRun.js).
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
import { appliedMismatches, answersRelPath, readProjectFiles, validateAnswers, writeBlockers } from "./lib/onboardAnswers.js";
import { projectHolderTiers } from "./lib/holderTiers.js";
import {
  MAX_RUNS_PER_STEP,
  blockedMessage,
  cexCandidatesFromSpellbook,
  cexReviewApplies,
  editAwaitsReviewMessage,
  largeHolderFindings,
  megaRaise,
  nextStep,
  noRunAppearedMessage,
  notOnMainMessage,
  onboardingSteps,
  sizingFromSnapshot,
  stuckMessage,
  timeBudgetMessage,
  usageMessage,
  workflowFailedMessage,
} from "./lib/onboardRun.js";

const MAX_ROUNDS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const utcToday = () => new Date().toISOString().slice(0, 10);

export function parseArgs(argv) {
  const out = { dryRun: false, local: false, commit: false, redispatch: false, round: 1, budgetMin: Infinity, pushCmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--project") out.project = v();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--local") out.local = true;
    else if (a === "--commit") out.commit = true;
    else if (a === "--redispatch") out.redispatch = true;
    else if (a === "--round") out.round = Number(v()) || 1;
    else if (a === "--budget-min") out.budgetMin = Number(v());
    else if (a === "--push-cmd") out.pushCmd = v();
    else throw new Error(usageMessage(`unknown argument ${a}`));
  }
  if (!out.project) throw new Error(usageMessage("--project <slug> is required"));
  if (out.local && !out.dryRun) throw new Error(usageMessage("--local reads the working tree and is valid only with --dry-run (a real run must see what is on main)"));
  return out;
}

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The paths the plan reads. A legacy-root project (TEL) keeps its feeds in public/data/ and its work files in data/. */
const statePaths = (slug, legacyRoot) => ["config", "public/tokens", ...(legacyRoot ? ["public/data", "data"] : [`public/data/${slug}`, `data/${slug}`])];

/**
 * --local (dry run only): the same files as snapshotMain, read from the working tree instead of origin/main,
 * so uncommitted config and feeds can be evaluated. A temp copy, so the later cleanup never touches the checkout.
 */
export function snapshotLocal(slug, cwd = process.cwd()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `onboard-${slug}-`));
  let legacyRoot = false;
  try {
    legacyRoot = JSON.parse(fs.readFileSync(path.join(cwd, `config/projects/${slug}.json`), "utf8")).data?.legacyRoot === true;
  } catch {
    // Not scaffolded here: evaluate() reports it.
  }
  for (const rel of statePaths(slug, legacyRoot)) {
    if (fs.existsSync(path.join(cwd, rel))) fs.cpSync(path.join(cwd, rel), path.join(dir, rel), { recursive: true });
  }
  return dir;
}

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
  const wanted = statePaths(slug, legacyRoot);
  const present = wanted.filter((p) => {
    try {
      git(["cat-file", "-e", `origin/main:${p}`]);
      return true;
    } catch {
      return false;
    }
  });
  // tar runs with cwd = dir and a relative name: GNU tar (Git Bash on Windows) reads an absolute "C:\..." path as host "C".
  git(["archive", "--format=tar", "-o", path.join(dir, "main.tar"), "origin/main", ...present]);
  execFileSync("tar", ["-xf", "main.tar"], { cwd: dir });
  fs.rmSync(path.join(dir, "main.tar"));
  return dir;
}

/** Answers record problems: schema errors, else places where main's config no longer reflects the answers. */
function answersProblemsOf(answers, root, slug) {
  const { errors, answers: valid } = validateAnswers(answers);
  if (errors.length > 0) return errors;
  return [...writeBlockers(valid), ...appliedMismatches(valid, readProjectFiles(root, slug), slug)];
}

/** The answers record under `root`, or null when absent. */
function readAnswersOn(root, slug) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, answersRelPath(slug)), "utf8"));
  } catch {
    return null;
  }
}

/** Wallets above 1% of supply that nobody has settled (null when the review does not apply or there is no snapshot). */
async function largeHolderReview(project, root, snapshot, answers) {
  const { loadNonRetailSet, createNonRetailChecker } = await import("./lib/nonRetailSet.js");
  const { projectNonRetailPaths, projectChainEntries } = await import("./lib/projects.js");
  const { chainExplorerUrl } = await import("./lib/chainAdapters.js");
  const { set } = await loadNonRetailSet(projectNonRetailPaths(project, root, snapshot));
  const chains = project.config.chains ?? [];
  const supplyTarget = Number(project.config.supply?.target);
  if (!(supplyTarget > 0)) return [];
  return largeHolderFindings({
    wallets: snapshot.wallets ?? [],
    chainKeys: projectChainEntries(project.config).map((c) => c.key),
    supplyTarget,
    megaThreshold: projectHolderTiers(project).megaHolderThreshold,
    isNonRetail: createNonRetailChecker(set),
    rows: answers?.largeHolders ?? [],
    explorerUrl: (key, address) => {
      try {
        return chainExplorerUrl(chains.find((c) => c.key === key), "address", address);
      } catch {
        return null;
      }
    },
  });
}

/**
 * Labelled exchange wallets of the spellbook Solana list that hold the token (what `sync-cex-wallets-dune.js --source spellbook
 * --candidates` writes), built in-process: it needs only raw.githubusercontent.com and the snapshot, no key, and writes nothing.
 * Returns { candidates, error? }; a failed fetch is an error the step reports (never an empty list that would pass the review).
 */
async function cexReviewCandidates(project, snapshot) {
  const { SPELLBOOK_CEX_SQL_URLS, parseSpellbookCexSql } = await import("./lib/duneCex.js");
  const { chainExplorerUrl } = await import("./lib/chainAdapters.js");
  const chains = project.config.chains ?? [];
  const chainKey = chains.find((c) => c.vm === "solana")?.key ?? "solana";
  try {
    const res = await fetch(SPELLBOOK_CEX_SQL_URLS.solana);
    if (!res.ok) return { candidates: [], error: `spellbook fetch ${res.status}` };
    const sql = await res.text();
    if (parseSpellbookCexSql(sql).length === 0) return { candidates: [], error: "the spellbook Solana list parsed to 0 rows (its format may have changed)" };
    const candidates = cexCandidatesFromSpellbook(sql, snapshot, {
      chainKey,
      supplyTarget: Number(project.config.supply?.target) || null,
      explorerUrl: (key, address) => {
        try {
          return chainExplorerUrl(chains.find((c) => c.key === key), "address", address);
        } catch {
          return null;
        }
      },
    });
    return { candidates };
  } catch (error) {
    return { candidates: [], error: String(error?.message ?? error).slice(0, 160) };
  }
}

/**
 * The owner decisions the plan reads: the committed answers record, else (a native coin has none) the chain
 * adapter's decisions in the same shape. Answers-shaped, so every reader below takes either.
 */
const decisionsOf = (answers, nativeDecisions) => answers ?? nativeDecisions;

async function evaluate(slug, { local = false, cwd = process.cwd() } = {}) {
  const root = local ? snapshotLocal(slug, cwd) : snapshotMain(slug);
  try {
    const { resolveProject, loadRegistry, projectDataRelPath } = await import("./lib/projects.js");
    const { nativeDecisionsFor } = await import("./lib/chainAdapters.js");
    const { goLiveProblems } = await import("./lib/goLive.js");
    const entry = loadRegistry(root).find((p) => p.slug === slug);
    if (!entry) throw new Error(notOnMainMessage(slug));
    const project = resolveProject(slug, root);
    const readJson = (rel) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
      } catch {
        return null;
      }
    };
    const answers = readJson(answersRelPath(slug));
    const nativeDecisions = answers ? null : await nativeDecisionsFor(project.config);
    const onboardingFlag = entry.onboarding === true;
    const snapshot = readJson(projectDataRelPath(project, "tel-holders.json"));
    // Existing projects without answers and without the onboarding flag keep today's behaviour: none of these gates apply.
    const reviewApplies = onboardingFlag || answers !== null;
    const steps = onboardingSteps({
      slug,
      config: project.config,
      readJson,
      today: utcToday(),
      goLive: goLiveProblems(project, { root }),
      onboardingFlag,
      answers,
      answersProblems: answers ? answersProblemsOf(answers, root, slug) : [],
      nativeDecisions,
      cexCandidates: reviewApplies && snapshot && cexReviewApplies(project.config) ? await cexReviewCandidates(project, snapshot) : null,
      largeHolders: reviewApplies ? (snapshot ? await largeHolderReview(project, root, snapshot, decisionsOf(answers, nativeDecisions)) : []) : null,
      alignment: onboardingFlag ? (await import("./check-go-live.js")).alignmentProblems(project, { root }) : null,
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
    if (!id) throw new Error(noRunAppearedMessage(workflow, inputs.project));
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

/** Config edits the orchestrator may make. Each returns the files it changed. Exported so a local rehearsal can run the same action code without git or gh. */
export async function applyEdit(edit, slug, mainRoot, logger) {
  const cwd = process.cwd();
  const cfgRel = `config/projects/${slug}.json`;
  const readCfg = () => JSON.parse(fs.readFileSync(path.join(cwd, cfgRel), "utf8"));
  const writeJson = (rel, doc) => fs.writeFileSync(path.join(cwd, rel), `${JSON.stringify(doc, null, 2)}\n`);
  if (edit === "derive-tiers") {
    const { loadNonRetailSet, createNonRetailChecker } = await import("./lib/nonRetailSet.js");
    const { projectDataPath, projectNonRetailPaths, resolveProject } = await import("./lib/projects.js");
    const project = resolveProject(slug, mainRoot);
    const snap = JSON.parse(fs.readFileSync(projectDataPath(project, "tel-holders.json", mainRoot), "utf8"));
    const { set } = await loadNonRetailSet(projectNonRetailPaths(project, mainRoot, snap));
    const cfg = readCfg();
    const { nativeDecisionsFor } = await import("./lib/chainAdapters.js");
    const answers = decisionsOf(readAnswersOn(mainRoot, slug), await nativeDecisionsFor(project.config));
    const sized = sizingFromSnapshot({
      slug,
      snapshot: snap,
      isNonRetail: createNonRetailChecker(set),
      supplyTarget: Number(project.config.supply?.target),
      today: utcToday(),
      largeHolderRows: answers?.largeHolders ?? [],
      existingMega: cfg.holders?.megaHolderThreshold,
    });
    if (sized.blocked) return { blocked: sized.blocked };
    cfg.holders = { ...(cfg.holders ?? {}), ...sized.holders };
    writeJson(cfgRel, cfg);
    logger.log(`  tiers: ${sized.result.distributionTiers.map((t) => t.label).join(", ")}; megaHolderThreshold ${sized.holders.megaHolderThreshold}`);
    return { files: [cfgRel], message: `${slug}: holder tiers and sizing derived from its own first snapshot` };
  }
  if (edit === "raise-mega-threshold") {
    const { projectDataPath, resolveProject } = await import("./lib/projects.js");
    const project = resolveProject(slug, mainRoot);
    const snap = JSON.parse(fs.readFileSync(projectDataPath(project, "tel-holders.json", mainRoot), "utf8"));
    const { nativeDecisionsFor } = await import("./lib/chainAdapters.js");
    const decisions = decisionsOf(readAnswersOn(mainRoot, slug), await nativeDecisionsFor(project.config));
    const findings = (await largeHolderReview(project, mainRoot, snap, decisions)).filter((f) => f.kind === "dropped");
    const cfg = readCfg();
    const current = projectHolderTiers({ config: cfg }).megaHolderThreshold;
    const next = megaRaise({ supplyTarget: Number(project.config.supply?.target), current, findings });
    if (next === null) return { blocked: findings.length ? `cannot raise holders.megaHolderThreshold above ${findings.map((f) => f.address).join(", ")} without exceeding supply.target.\nFix: label the wallet(s) in config/projects/${slug}/onboarding.answers.json (wallets) and re-apply with npm run onboard -- --address <token address> --answers config/projects/${slug}/onboarding.answers.json --write` : `holders.megaHolderThreshold is already above every acknowledged retail wallet.\nFix: run node scripts/onboard-run.js --project ${slug}` };
    // Tier labels are join keys: only the threshold changes.
    cfg.holders = { ...(cfg.holders ?? {}), megaHolderThreshold: next };
    writeJson(cfgRel, cfg);
    logger.log(`  megaHolderThreshold ${current} -> ${next} (above ${findings.map((f) => f.address).join(", ")})`);
    return { files: [cfgRel], message: `${slug}: megaHolderThreshold raised above acknowledged retail wallets` };
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
    // public/sitemap.xml is tracked and lists every listed project (src/test/siteConfig.test.ts); regenerate it in the same edit so the listing commit is complete.
    const { buildSitemap, SITEMAP_BASE_URL } = await import("./lib/sitemap.js");
    const slugs = reg.projects.filter((p) => p.onboarding !== true).map((p) => p.slug);
    fs.writeFileSync(path.join(cwd, "public/sitemap.xml"), buildSitemap({ baseUrl: SITEMAP_BASE_URL, slugs, today: utcToday() }));
    return { files: ["config/projects.json", "public/sitemap.xml"], message: `${slug}: check-go-live passes; list it on the site (shows after the next manual deploy)` };
  }
  throw new Error(`unknown edit ${edit}`);
}

function commitAndPush(files, message, pushCmd) {
  git(["add", ...files]);
  git(["commit", "-m", `${message} [skip netlify]`]);
  execFileSync(pushCmd.split(" ")[0], pushCmd.split(" ").slice(1), { stdio: "inherit" });
}

export async function main(argv = process.argv.slice(2), { logger = console, cwd = process.cwd() } = {}) {
  const args = parseArgs(argv);
  const slug = args.project;
  const started = Date.now();
  const runs = {};
  logger.log(`Onboarding ${slug} (round ${args.round}${args.dryRun ? ", dry run" : ""}${args.local ? ", local working tree" : ""})`);

  for (;;) {
    const { steps, root } = await evaluate(slug, { local: args.local, cwd });
    try {
      for (const s of steps) logger.log(`  [${s.done ? "x" : " "}] ${s.id.padEnd(22)} ${s.why}`);
      const step = nextStep(steps);
      if (!step) {
        logger.log(`\n${slug} is onboarded: check-go-live passes and it is listed. Deploy from the Netlify dashboard to publish.`);
        return 0;
      }
      if (step.blocked || !step.action) {
        logger.log(`\n${blockedMessage(step)}`);
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
        logger.log(`\n${timeBudgetMessage(step, slug)}`);
        return 0;
      }
      runs[step.id] = (runs[step.id] ?? 0) + 1;
      if (runs[step.id] > MAX_RUNS_PER_STEP) {
        logger.log(`\n${stuckMessage(step, slug)}`);
        return 2;
      }

      if (step.action.edit) {
        const r = await applyEdit(step.action.edit, slug, root, logger);
        if (r.blocked) {
          logger.log(`\nBlocked at ${step.id}:\n${r.blocked}`);
          return 2;
        }
        if (!args.commit) {
          logger.log(`\n${editAwaitsReviewMessage({ files: r.files, message: r.message, slug })}`);
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
          logger.log(`\n${workflowFailedMessage({ workflow: a.workflow, id: result.id, conclusion: result.conclusion, url: result.url, slug })}`);
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
      // Errors from git/gh/fs carry no Fix: line of their own; every other stop message is built in lib/onboardRun.js.
      console.error(`[onboard-run] ${err.message}${/Fix:/.test(err.message) ? "" : `\nFix: re-run (transient network/gh errors clear); if it repeats, run the failing command by hand: git fetch origin main ; gh auth status ; then node scripts/onboard-run.js --project <slug> --dry-run`}`);
      process.exit(1);
    });
}
