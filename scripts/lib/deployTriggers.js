/**
 * How many production builds a normal day triggers, derived from the workflows.
 *
 * Every commit pushed to `main` is a Netlify build unless its message carries
 * `[skip netlify]`, so deploy frequency is decided entirely by which workflows
 * commit, how often they are scheduled, and whether they mark their commits.
 * Before 2026-09-13 that was 7-12 builds a day — each scan in the holders chain
 * had both a `workflow_run` chain and its own cron, so it ran and committed
 * twice — and it drained the site's build credits with no number anywhere to
 * show it.
 *
 * Commented-out schedules are counted deliberately: while the feeds are paused
 * they are the configuration a resume restores, and a paused config still has
 * to be a correct config.
 */
import fs from "node:fs";
import path from "node:path";

export const WORKFLOW_DIR = path.resolve(process.cwd(), ".github/workflows");

const commitMessage = (src) => src.match(/git commit -m "([^"]*)"/)?.[1] ?? null;
const cronLines = (src) => [...src.matchAll(/^#?\s*#?\s*- cron: '([^']+)'/gm)].map((m) => m[1]);

/** Daily firings for a cron. Weekly/monthly schedules return 0 — real, but not a daily cost. */
export const runsPerDay = (cron) => {
  const [minute, hour, dom, , dow] = cron.trim().split(/\s+/);
  if (dom !== "*" || (dow !== "*" && dow !== undefined)) return 0;
  const count = (field, max) =>
    field === "*" ? max : field.startsWith("*/") ? Math.floor(max / Number(field.slice(2))) : field.split(",").length;
  return count(hour, 24) * count(minute, 60);
};

/** True when the commit step is gated by an `if:` — i.e. it does not commit every run. */
const commitIsConditional = (src) => {
  const idx = src.indexOf("git commit -m");
  if (idx < 0) return false;
  const stepStart = src.lastIndexOf("- name:", idx);
  return /\n\s+if:\s/.test(src.slice(stepStart, idx));
};

export const readWorkflows = (dir = WORKFLOW_DIR) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((file) => ({ file, src: fs.readFileSync(path.join(dir, file), "utf8") }))
    .map(({ file, src }) => {
      const message = commitMessage(src);
      if (!message) return null; // commits nothing, so it can never trigger a build
      const scheduled = cronLines(src).reduce((sum, c) => sum + runsPerDay(c), 0);
      return {
        name: file.replace(/\.(yml|yaml)$/, ""),
        // Read from the COMMIT MESSAGE, never the surrounding prose: the
        // workflows explain the marker in comments, and an earlier version of
        // this check matched those and called the daily publisher a skipper.
        publishes: !message.includes("[skip netlify]"),
        scheduled,
        infrequent: cronLines(src).length > 0 && scheduled === 0,
        conditional: commitIsConditional(src),
        paused: src.includes("PAUSED 2026-09-13"),
        chained: src.includes("workflow_run:"),
      };
    })
    .filter(Boolean);

/** Builds a normal day triggers, plus the conditional publishers that stand by. */
export const deployBudget = (workflows = readWorkflows()) => {
  const unconditional = workflows.filter((w) => w.publishes && !w.conditional && w.scheduled > 0);
  return {
    perDay: unconditional.reduce((sum, w) => sum + w.scheduled, 0),
    unconditional,
    standby: workflows.filter((w) => w.publishes && w.conditional && w.scheduled > 0),
    allPaused: workflows.every((w) => w.paused || w.scheduled === 0),
  };
};
