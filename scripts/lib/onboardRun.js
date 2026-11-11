/**
 * The first-data order for a new project (onboard-project skill, step 6) as
 * data: each step says when it is done, read from the files on `main`, and
 * which workflow (or config edit) moves it forward. scripts/onboard-run.js
 * runs the first step that is not done, waits, re-reads `main` and repeats,
 * so a rerun after any stop resumes where it left off. Pure: callers pass a
 * file reader rooted at a copy of `main`.
 */
import { lastEntryAgeDays } from "./feedHealth.js";
import { projectHolderTiers } from "./holderTiers.js";
import { tierFingerprint } from "./tierFingerprint.js";

/** Flow feeds count as caught up when their newest row is at most this many days old (pipeline-health's stale-tail limit). */
export const FLOW_TAIL_DAYS = 3;
/** Runs of one step per orchestrator invocation before it stops and reports (scans that resume need several). */
export const MAX_RUNS_PER_STEP = 6;

const vmOf = (config) => [...new Set((config.chains ?? []).map((c) => c.vm ?? (c.key === "solana" ? "solana" : "evm")))];
const dayBefore = (today) => new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * @param {object} p
 * @param {string} p.slug
 * @param {object} p.config config/projects/<slug>.json on main
 * @param {(rel: string) => any|null} p.readJson repo-relative JSON reader over main (null when absent)
 * @param {string} p.today YYYY-MM-DD (UTC)
 * @param {string[]} [p.goLive] check-go-live problems on main ([] = complete)
 * @param {boolean} [p.onboardingFlag] registry entry still carries onboarding: true
 * @returns {Array<{id:string, done:boolean, why:string, action?:{workflow?:string, inputs?:Record<string,string>, edit?:string}, blocked?:string}>}
 */
export function onboardingSteps({ slug, config, readJson, today, goLive = null, onboardingFlag = false }) {
  const data = (file) => readJson(`${config.data?.legacyRoot ? "public/data" : `public/data/${slug}`}/${file}`);
  const work = (file) => readJson(`${config.data?.legacyRoot ? "data" : `data/${slug}`}/${file}`);
  const vms = vmOf(config);
  const isEvm = vms.includes("evm");
  const evmChains = (config.chains ?? []).filter((c) => (c.vm ?? "evm") === "evm").map((c) => c.key);
  const historyStart = config.pipeline?.historyStart ?? null;
  const project = { slug, config };
  const steps = [];

  const cexRel = config.classification?.cexWallets ?? null;
  const cex = cexRel ? readJson(cexRel) : null;
  const cexCount = Array.isArray(cex?.wallets) ? cex.wallets.length : 0;
  steps.push({
    id: "cex-wallets",
    done: cexCount > 0,
    why: cexCount > 0 ? `${cexCount} CEX wallets listed` : "no CEX wallets listed yet (the first snapshot would count exchange balances as retail)",
    ...(isEvm && cexRel
      ? { action: { workflow: "sync-cex-wallets.yml", inputs: { project: slug } } }
      : { blocked: `add a reviewed classification.cexWallets list for ${slug} (Solana spellbook writes candidates only: data/${slug}/cex-dune-candidates.json)` }),
  });

  const snapshot = data("tel-holders.json");
  steps.push({
    id: "snapshot",
    done: Boolean(snapshot),
    why: snapshot ? "first holders snapshot is on main" : "no holders snapshot yet",
    action: { workflow: "refresh-holders.yml", inputs: { project: slug } },
  });

  const ownTiers = Array.isArray(config.holders?.distributionTiers) || String(config.holders?.defaultTiers ?? "").trim() !== "";
  steps.push({
    id: "tiers",
    done: ownTiers,
    why: ownTiers ? "tiers set in config" : "tiers not derived yet (never reuse another project's)",
    action: { edit: "derive-tiers" },
  });

  // holders-lite is rewritten by every refresh (a history row for the same day may not be), so it shows the tiers in use.
  const wanted = new Set(projectHolderTiers(project).distributionTiers.map((t) => t.label));
  const liteLabels = (data("holders-lite.json")?.views?.combined?.distribution ?? []).map((d) => d.label);
  const onTiers = liteLabels.length > 0 && liteLabels.every((l) => wanted.has(l));
  steps.push({
    id: "snapshot-on-tiers",
    done: onTiers,
    why: onTiers ? "holders-lite uses the project's tiers" : "feeds still use other tiers (refresh after the tier change)",
    action: { workflow: "refresh-holders.yml", inputs: { project: slug } },
  });

  if (historyStart) {
    const entries = data("holders-history.json")?.entries ?? [];
    // Rows carry each chain separately, so a chain whose rebuild failed is redone on its own.
    const firstFor = (chain) => entries.find((e) => e?.chains?.[chain] != null)?.date ?? null;
    const behind = isEvm ? evmChains.filter((c) => !(firstFor(c) && firstFor(c) <= historyStart)) : [];
    const first = entries[0]?.date ?? null;
    const done = isEvm ? behind.length === 0 : Boolean(first) && first <= historyStart;
    const historyRun = (chain) => ({ workflow: "rebuild-holders-history.yml", inputs: { project: slug, chain, start: historyStart } });
    steps.push({
      id: "history",
      done,
      why: done
        ? `history starts ${first} (wanted ${historyStart})`
        : isEvm
          ? `history before ${historyStart} missing on ${behind.join(", ")}`
          : `history starts ${first ?? "nowhere"}, wanted ${historyStart}`,
      action: isEvm
        ? { ...historyRun(behind[0] ?? evmChains[0]), more: behind.slice(1).map(historyRun) }
        : { workflow: "rebuild-holders-history-solana.yml", inputs: { project: slug, since: historyStart, dry_run: "false" } },
    });
  }

  const flowAge = lastEntryAgeDays(data("exchange-flow-history.json"), Date.parse(`${today}T12:00:00Z`));
  steps.push({
    id: "exchange-flows",
    done: flowAge !== null && flowAge <= FLOW_TAIL_DAYS,
    why: flowAge === null ? "no exchange-flow rows yet" : `newest exchange-flow row is ${flowAge}d old`,
    action: { workflow: "scan-exchange-flows.yml", inputs: { project: slug, ...(isEvm ? { max_blocks_per_run: "3000000" } : {}) } },
  });

  if (historyStart && isEvm) {
    const cexFirst = data("cex-balance-history.json")?.entries?.[0]?.date ?? null;
    const ok = Boolean(cexFirst) && cexFirst <= historyStart;
    steps.push({
      id: "treasury-cex-history",
      done: ok,
      why: ok ? `CEX balance history starts ${cexFirst}` : `CEX balance history starts ${cexFirst ?? "nowhere"}, wanted ${historyStart}`,
      action: { workflow: "backfill-treasury-cex-history.yml", inputs: { project: slug, from: historyStart, to: dayBefore(today), write: "true" } },
    });
  }

  const tiersDoc = data("tier-outflows.json");
  const fpOk = tiersDoc?.tierFingerprint == null || tiersDoc.tierFingerprint === tierFingerprint(projectHolderTiers(project).distributionTiers);
  steps.push({
    id: "tier-outflows",
    done: tiersDoc?.complete === true && fpOk,
    why: !tiersDoc ? "no tier-outflows feed yet" : !fpOk ? "tier-outflows built on other tiers" : tiersDoc.complete ? "tier-outflows complete" : "tier-outflows still catching up",
    action: { workflow: "generate-tier-outflows.yml", inputs: { project: slug } },
  });

  if ((config.staking ?? []).some((s) => s.kind === "stakeChanged" || s.kind === "receiptModule")) {
    const stakers = data("funding-wallets.json");
    steps.push({
      id: "staker-balances",
      done: Boolean(stakers),
      why: stakers ? "staker balances on main" : "no staker balances yet",
      action: { workflow: "refresh-staker-balances.yml", inputs: { project: slug } },
    });
  }

  const flows = work("forensics/wallet-flows.json");
  steps.push({
    id: "wallet-flows",
    done: Boolean(flows),
    why: flows ? "wallet-flows report on main" : "no wallet-flows report yet",
    action: { workflow: "refresh-wallet-flows.yml", inputs: { project: slug } },
  });

  const ledger = readJson(`data/${slug}/ledger/ledger.json`);
  steps.push({
    id: "ledger",
    done: Boolean(ledger),
    why: ledger ? "developer-wallet ledger on main" : "no developer-wallet ledger yet",
    action: { workflow: "refresh-ledger.yml", inputs: { project: slug } },
  });

  const walletsOn = config.capabilities?.projectWallets === true;
  steps.push({
    id: "developer-wallets-tab",
    done: walletsOn,
    why: walletsOn ? "Developer wallets tab on" : "ledger exists but capabilities.projectWallets is off",
    action: { edit: "enable-project-wallets" },
  });

  if (goLive !== null) {
    const live = goLive.length === 0;
    steps.push({
      id: "go-live",
      done: live,
      why: live ? "check-go-live passes" : `check-go-live: ${goLive.length} problem(s)`,
      blocked: live ? undefined : goLive.join("\n"),
    });
    steps.push({
      id: "list-on-site",
      done: !onboardingFlag,
      why: onboardingFlag ? "registry entry still marked onboarding" : "listed (shows after the next manual Netlify deploy)",
      action: { edit: "clear-onboarding-flag" },
    });
  }
  return steps;
}

/** The first step still to do, or null when onboarding is finished. */
export const nextStep = (steps) => steps.find((s) => !s.done) ?? null;
