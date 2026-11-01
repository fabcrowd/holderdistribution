/**
 * Pure helpers behind scripts/summarize-run-metrics.js: fold the per-process
 * NDJSON lines written by rpcMetrics.js into a per-project daily usage file and
 * check the month-to-date totals against config/budgets.json.
 */

export const USAGE_SCHEMA_VERSION = 1;
export const KEEP_DAYS = 62;

const ZERO_DAY = Object.freeze({ runs: 0, alchemyCu: 0, heliusCredits: 0, alchemyCalls: 0, heliusCalls: 0, publicCalls: 0 });

/** @param {string} text NDJSON, one object per line; malformed lines are skipped. */
export function parseNdjson(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a truncated line from a killed process: ignore it */
    }
  }
  return out;
}

const sum = (rows, key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

/**
 * rpcMetrics.js flushes a process's usage in several lines (periodic flushes
 * plus the exit flush), so a process is counted once per (script, pid). Lines
 * without a pid are older single-line records and count one each.
 *
 * @param {object[]} lines parsed NDJSON rows @returns {object} totals plus a per-script breakdown
 */
export function aggregateRuns(lines) {
  const byScript = {};
  const seenProcesses = new Set();
  let runs = 0;
  for (const r of lines) {
    const script = r.script ?? "unknown";
    const s = (byScript[script] ??= { processes: 0, alchemyCu: 0, heliusCredits: 0, publicCalls: 0 });
    const isNewProcess = r.pid == null || !seenProcesses.has(JSON.stringify([script, r.pid]));
    if (r.pid != null) seenProcesses.add(JSON.stringify([script, r.pid]));
    if (isNewProcess) {
      s.processes += 1;
      runs += 1;
    }
    s.alchemyCu += Number(r.alchemyCu) || 0;
    s.heliusCredits += Number(r.heliusCredits) || 0;
    s.publicCalls += Number(r.publicCalls) || 0;
  }
  return {
    runs,
    alchemyCu: sum(lines, "alchemyCu"),
    heliusCredits: sum(lines, "heliusCredits"),
    alchemyCalls: sum(lines, "alchemyCalls"),
    heliusCalls: sum(lines, "heliusCalls"),
    publicCalls: sum(lines, "publicCalls"),
    byScript,
  };
}

/**
 * Adds `agg` to the `date` (YYYY-MM-DD, UTC) entry of a project's usage file and
 * drops entries older than `keepDays`. Returns a new object.
 */
export function mergeUsage(existing, date, agg, { keepDays = KEEP_DAYS } = {}) {
  const days = { ...(existing?.days ?? {}) };
  const prev = days[date] ?? ZERO_DAY;
  const scripts = { ...(prev.byScript ?? {}) };
  for (const [name, s] of Object.entries(agg.byScript ?? {})) {
    const p = scripts[name] ?? { processes: 0, alchemyCu: 0, heliusCredits: 0, publicCalls: 0 };
    scripts[name] = {
      processes: p.processes + s.processes,
      alchemyCu: p.alchemyCu + s.alchemyCu,
      heliusCredits: p.heliusCredits + s.heliusCredits,
      publicCalls: p.publicCalls + s.publicCalls,
    };
  }
  days[date] = {
    runs: prev.runs + 1,
    alchemyCu: prev.alchemyCu + agg.alchemyCu,
    heliusCredits: prev.heliusCredits + agg.heliusCredits,
    alchemyCalls: prev.alchemyCalls + agg.alchemyCalls,
    heliusCalls: prev.heliusCalls + agg.heliusCalls,
    publicCalls: prev.publicCalls + agg.publicCalls,
    byScript: scripts,
  };
  const cutoff = new Date(Date.parse(`${date}T00:00:00Z`) - keepDays * 86400000).toISOString().slice(0, 10);
  for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
  return { schemaVersion: USAGE_SCHEMA_VERSION, days };
}

/** @param {{days?: Record<string, object>}[]} usages one per project @param {string} month "YYYY-MM" */
export function monthToDate(usages, month) {
  const total = { alchemyCu: 0, heliusCredits: 0 };
  for (const u of usages) {
    for (const [d, v] of Object.entries(u?.days ?? {})) {
      if (!d.startsWith(month)) continue;
      total.alchemyCu += Number(v.alchemyCu) || 0;
      total.heliusCredits += Number(v.heliusCredits) || 0;
    }
  }
  return total;
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * Fails only on the run that first crosses a monthly budget (failAt * budget);
 * later runs in the same month warn "still over budget" so one overrun does
 * not turn every nightly job red. The warn threshold and the per-run warning
 * are unchanged.
 *
 * @param {{alchemyCu: number, heliusCredits: number}} mtd month-to-date, all projects, including this run
 * @param {{alchemyCu: number, heliusCredits: number, [key: string]: number|undefined}} run this run's totals
 * @param {object} budgets config/budgets.json
 * @returns {{level: "ok"|"warn"|"fail", rows: object[], messages: {level: "warn"|"fail", text: string}[]}}
 */
export function evaluateBudget(mtd, run, budgets) {
  const warnAt = budgets.warnAt ?? 0.8;
  const failAt = budgets.failAt ?? 1;
  const rows = [];
  const messages = [];
  let level = "ok";
  const raise = (l) => {
    if (l === "fail" || (l === "warn" && level === "ok")) level = l;
  };
  for (const [key, label] of [["alchemyCu", "Alchemy CU"], ["heliusCredits", "Helius credits"]]) {
    const budget = budgets.monthly?.[key] ?? 0;
    const used = mtd[key];
    const usedBeforeRun = used - (run[key] ?? 0);
    const failLine = failAt * budget;
    rows.push({ key, label, run: run[key], used, budget, percent: pct(used, budget) });
    if (budget > 0 && used >= failLine) {
      const detail = `${label}: ${used.toLocaleString("en-US")} of ${budget.toLocaleString("en-US")} used this month (${pct(used, budget)}%)`;
      if (usedBeforeRun < failLine) {
        raise("fail");
        messages.push({ level: "fail", text: `${detail} — over budget` });
      } else {
        raise("warn");
        messages.push({ level: "warn", text: `${detail} — still over budget` });
      }
    } else if (budget > 0 && used / budget >= warnAt) {
      raise("warn");
      messages.push({ level: "warn", text: `${label}: ${pct(used, budget)}% of the monthly budget used (${used.toLocaleString("en-US")} of ${budget.toLocaleString("en-US")})` });
    }
    const perRun = budgets.perRunWarn?.[key];
    if (perRun && run[key] > perRun) {
      raise("warn");
      messages.push({ level: "warn", text: `${label}: this run used ${run[key].toLocaleString("en-US")}, above the per-run warning of ${perRun.toLocaleString("en-US")}` });
    }
  }
  return { level, rows, messages };
}

/** Markdown for $GITHUB_STEP_SUMMARY. */
export function renderSummary({ project, date, agg, evaluation }) {
  const n = (v) => Number(v).toLocaleString("en-US");
  const lines = [`### RPC usage — ${project} — ${date}`, "", "| Provider | Calls | Estimated units | This month (all projects) | Budget |", "|---|---:|---:|---:|---:|"];
  const [cu, helius] = evaluation.rows;
  lines.push(`| Alchemy | ${n(agg.alchemyCalls)} | ${n(agg.alchemyCu)} CU | ${n(cu.used)} CU (${cu.percent}%) | ${n(cu.budget)} |`);
  lines.push(`| Helius | ${n(agg.heliusCalls)} | ${n(agg.heliusCredits)} credits | ${n(helius.used)} (${helius.percent}%) | ${n(helius.budget)} |`);
  lines.push(`| Public / other | ${n(agg.publicCalls)} | — | — | — |`, "");
  const top = Object.entries(agg.byScript).sort((a, b) => b[1].alchemyCu + b[1].heliusCredits - (a[1].alchemyCu + a[1].heliusCredits)).slice(0, 8);
  if (top.length) {
    lines.push("| Script | Processes | Alchemy CU | Helius credits | Public calls |", "|---|---:|---:|---:|---:|");
    for (const [name, s] of top) lines.push(`| ${name} | ${s.processes} | ${n(s.alchemyCu)} | ${n(s.heliusCredits)} | ${n(s.publicCalls)} |`);
    lines.push("");
  }
  lines.push("_Estimates from published rate cards; the provider dashboards are the billing source of truth._");
  return lines.join("\n");
}
