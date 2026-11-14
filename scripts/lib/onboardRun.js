/**
 * The first-data order for a new project (onboard-project skill, step 6) as
 * data: each step says when it is done, read from the files on `main`, and
 * which workflow (or config edit) moves it forward. scripts/onboard-run.js
 * runs the first step that is not done, waits, re-reads `main` and repeats,
 * so a rerun after any stop resumes where it left off. Pure: callers pass a
 * file reader rooted at a copy of `main`.
 *
 * Every stop the runner can make (a blocked step, a failed workflow, a step
 * that never completes, a config edit awaiting review) ends with a `Fix:`
 * block of exact commands and file+field, so a weak model can resolve it from
 * the message alone. The builders for those messages live here.
 */
import { projectHolderTiers } from "./holderTiers.js";
import { tierFingerprint } from "./tierFingerprint.js";
import { deriveHolderTiers, MAX_TIER_SHARE, MEGA_SUPPLY_DIVISOR } from "./deriveHolderTiers.js";
import { intersectCexWithHolders, parseDuneCexRows, parseSpellbookCexSql } from "./duneCex.js";

/** A flow feed counts as caught up when its own asOf stamp (last fully scanned settled day) is at most this many days before today UTC (yesterday = 1). */
export const FLOW_ASOF_MAX_AGE_DAYS = 2;
/** Runs of one step per orchestrator invocation before it stops and reports (scans that resume need several). */
export const MAX_RUNS_PER_STEP = 6;
/** A wallet holding more than this share of supply.target must be traced by a person before tiers are derived. */
export const LARGE_HOLDER_SHARE = 0.01;

/**
 * Chain VMs each data workflow can read today. A step for a project on any other
 * VM stops with a reason instead of dispatching a workflow that cannot read it.
 */
export const STEP_VMS = Object.freeze({
  "cex-wallets": ["evm"],
  history: ["evm", "solana"],
  "exchange-flows": ["evm", "solana", "hedera"],
  "treasury-cex-history": ["evm"],
  "tier-outflows": ["evm", "solana", "hedera"],
  "wallet-flows": ["evm", "solana", "hedera"],
  ledger: ["evm", "solana", "hedera"],
});
const unsupported = (id, vms) => vms.filter((vm) => !(STEP_VMS[id] ?? []).includes(vm));

const vmOf = (config) => [...new Set((config.chains ?? []).map((c) => c.vm ?? (c.key === "solana" ? "solana" : "evm")))];
const dayBefore = (today) => new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const daysBetween = (laterDay, earlierDay) => Math.round((Date.parse(`${laterDay}T00:00:00Z`) - Date.parse(`${earlierDay}T00:00:00Z`)) / 86_400_000);

// ---------------------------------------------------------------------------
// Message pieces (every stop message is built from these and ends with "Fix:")
// ---------------------------------------------------------------------------

export const answersPath = (slug) => `config/projects/${slug}/onboarding.answers.json`;
export const dispatchCmd = (slug) => `gh workflow run onboard-project.yml -f project=${slug}`;
const tokenAddress = (config, answers) => {
  if (typeof answers?.address === "string") return answers.address;
  const chain = (config.chains ?? []).find((c) => c.origin) ?? config.chains?.[0];
  return chain?.tokens?.find((t) => t.status === "canonical")?.address ?? chain?.tokens?.[0]?.address ?? chain?.tokenAddress ?? "<token address>";
};
export const reapplyCmd = (slug, address = "<token address>") => `npm run onboard -- --address ${address} --answers ${answersPath(slug)} --write`;
/** The tail every "edit config, then continue" stop shares. */
const mergeAndDispatch = (slug) => `then commit the edit, merge it to main, and run: ${dispatchCmd(slug)}`;
const workDir = (config, slug) => (config.data?.legacyRoot ? "data" : `data/${slug}`);
const fmtNumber = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });

const cexBlockedNonEvm = (slug, config, vms, address) =>
  `no CEX wallets are listed for ${slug} and no verified public source syncs CEX wallets for ${vms.filter((v) => v !== "evm").join(", ")}, so the first snapshot would count exchange balances as retail.\n` +
  `Fix:\n` +
  `  1. in ${answersPath(slug)} set "cex": {"decision": "list", "evidence": "<where you checked>", "wallets": [{"chain": "<chain>", "address": "<address>", "exchange": "<name>", "source": "<URL>", "confidence": "high|medium|low"}]} with the exchange wallets you can verify (Solscan name tag, Arkham, proof of reserves)\n` +
  `     or, if you found none, "cex": {"decision": "none-known", "evidence": "<where you looked>", "wallets": []}\n` +
  `  2. ${reapplyCmd(slug, address)}\n` +
  `  3. ${mergeAndDispatch(slug)}\n` +
  (cexReviewApplies(config) ? `After the first snapshot the runner lists every labelled exchange wallet that holds the token and stops until each is under cex.wallets or cex.rejected; none-known does not skip that review.` : `The Dune spellbook has no exchange list for ${vms.filter((v) => v !== "evm").join(", ")}, so there is no candidate review: the evidence you record is the only check.`);

const cexBlockedNoFile = (slug, address) =>
  `config/projects/${slug}.json has no classification.cexWallets, so there is no CEX list to fill.\n` +
  `Fix: add the "cex" section to ${answersPath(slug)} (decision spellbook | list | none-known, with evidence), run ${reapplyCmd(slug, address)}, ${mergeAndDispatch(slug)}`;

const answersBlocked = (slug, problems, address) =>
  `${answersPath(slug)} is invalid or no longer matches the config on main:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
  `Fix: correct the fields named above in ${answersPath(slug)}, run ${reapplyCmd(slug, address)}, ${mergeAndDispatch(slug)}`;

const historyBlockedNoAnswers = (slug, address) =>
  `pipeline.historyStart is not set in config/projects/${slug}.json and there is no ${answersPath(slug)}, so nobody has decided whether history is backfilled.\n` +
  `Fix: create ${answersPath(slug)} (template: npm run onboard -- --address ${address}, writes tasks/onboard-${slug}.answers.json), set "historyStart" to a date "YYYY-MM-DD" (token deploy date) or "forward-only", fill the other sections, then run ${reapplyCmd(slug, address)}, ${mergeAndDispatch(slug)}`;

const historyBlockedStale = (slug, wanted, address) =>
  `${answersPath(slug)} says historyStart ${wanted} but pipeline.historyStart is unset in config/projects/${slug}.json.\n` +
  `Fix: run ${reapplyCmd(slug, address)}, ${mergeAndDispatch(slug)}`;

const registryBlocked = (slug, config, address) =>
  `the forensics registry ${workDir(config, slug)}/forensics/wallet-flows.registry.json lists no known wallets, so refresh-wallet-flows.yml would fail by construction.\n` +
  `Fix: add at least one treasury/team/holdings/association/escrow wallet under "wallets" in ${answersPath(slug)}, run ${reapplyCmd(slug, address)}, ${mergeAndDispatch(slug)}` +
  ` (no answers file: node scripts/init-forensics-registry.js --project ${slug} and add the wallets it asks for)`;

const notBuilt = (id, vms, slug) =>
  `${id} is not built for vm ${unsupported(id, vms).join(", ")} yet (tasks/hedera-plan.md lists the remaining slices).\n` +
  `Fix: implement that slice per tasks/hedera-plan.md, merge it to main, then run: ${dispatchCmd(slug)}`;

/** The large-holder review stop: one line per wallet that has no usable largeHolders row (kind "missing"). */
function largeHoldersBlocked({ slug, findings, supplyTarget, address, native = false }) {
  if (native) {
    const rows = findings.map((f) => `  - ${f.address} on ${f.chain}: ${fmtNumber(f.balance)} (${(f.share * 100).toFixed(2)}% of supply)${f.url ? ` ${f.url}` : ""}`);
    return (
      `${findings.length} account(s) hold more than ${LARGE_HOLDER_SHARE * 100}% of supply (${fmtNumber(supplyTarget)}) and the native coin's recorded owner decisions (the chain adapter, scripts/lib/hedera/nativeDecisions.js) do not cover them.\n` +
      `${rows.join("\n")}\n` +
      `Fix:\n` +
      `  1. open each explorer link above and trace the account (who funds it, what it is)\n` +
      `  2. the owner decides: "retail" (a real holder), "unknown" (traced but identity not established, not an exchange/treasury/team wallet) or labelled (add it to the treasury ranges in scripts/lib/hedera/treasury.js or the CEX list in scripts/lib/hedera/cexAccounts.js)\n` +
      `  3. for "retail" | "unknown" add {"chain": "<chain>", "address": "<id>", "decision": "retail" | "unknown", "note": "<one sentence: how you decided>"} to HEDERA_LARGE_HOLDERS in scripts/lib/hedera/nativeDecisions.js; the runner then raises holders.megaHolderThreshold above it by itself when needed\n` +
      `  4. ${mergeAndDispatch(slug)}`
    );
  }
  const lines = findings.map((f) => {
    const why = f.aboveMega ? ` ABOVE megaHolderThreshold, currently dropped from holder counts and retail` : "";
    return `  - ${f.address} on ${f.chain}: ${fmtNumber(f.balance)} (${(f.share * 100).toFixed(2)}% of supply)${f.url ? ` ${f.url}` : ""}${why}`;
  });
  return (
    `${findings.length} wallet(s) hold more than ${LARGE_HOLDER_SHARE * 100}% of supply (${fmtNumber(supplyTarget)}) and have no usable largeHolders row in ${answersPath(slug)}.\n` +
    `${lines.join("\n")}\n` +
    `Fix:\n` +
    `  1. open each explorer link above and trace the wallet (who funds it, what it is)\n` +
    `  2. add one row per wallet to "largeHolders" in ${answersPath(slug)}: {"chain": "<chain>", "address": "<address>", "decision": "retail" | "unknown" | "labelled", "note": "<one sentence: how you decided>"}\n` +
    `     "retail" = traced and it is a real holder: that is enough, the runner raises holders.megaHolderThreshold above it by itself (max(supply.target / ${MEGA_SUPPLY_DIVISOR}, ${MEGA_HEADROOM} x its balance rounded up to 1 / 2.5 / 5 x 10^k)) and refreshes the snapshot.\n` +
    `     "unknown" = traced but the identity could not be established, and it is not an exchange/treasury/team wallet: it behaves the same as "retail" (counts as a holder; the runner raises megaHolderThreshold the same way).\n` +
    `     "labelled" = treasury/team/DEX/CEX/staking: ALSO add it under wallets, dex.pools, cex.wallets or staking.contracts in the same file so it is labelled non-retail\n` +
    `  3. ${reapplyCmd(slug, address)}\n` +
    `  4. ${mergeAndDispatch(slug)}`
  );
}

// ---------------------------------------------------------------------------
// Non-EVM CEX review: labelled exchange wallets that hold the token, after the first snapshot
// ---------------------------------------------------------------------------

/**
 * VMs for which the Dune spellbook publishes an exchange list that --candidates mode can intersect with the holder snapshot
 * (scripts/sync-cex-wallets-dune.js; spellbook has no Hedera model). The review applies to a project that has no EVM chain and one of these.
 */
export const CEX_REVIEW_VMS = Object.freeze(["solana"]);
export const cexReviewApplies = (config) => {
  const vms = vmOf(config);
  return !vms.includes("evm") && vms.some((vm) => CEX_REVIEW_VMS.includes(vm));
};
export const spellbookCexCommand = (slug) => `node scripts/sync-cex-wallets-dune.js --project ${slug} --source spellbook --candidates`;

/** The labelled exchange wallets of the spellbook Solana list that hold the token in `snapshot`, biggest first; each carries chain and explorer url. */
export function cexCandidatesFromSpellbook(sql, snapshot, { chainKey, supplyTarget = null, explorerUrl = () => null }) {
  const entries = parseDuneCexRows(parseSpellbookCexSql(sql), "solana");
  return intersectCexWithHolders(entries, snapshot?.wallets ?? [], { totalSupply: snapshot?.totals?.totalSupply ?? supplyTarget }).map((c) => ({ ...c, chain: chainKey, url: explorerUrl(chainKey, c.address) }));
}

/**
 * Candidates the owner has not settled: in neither answers cex.wallets (accepted) nor cex.rejected.
 * Compared per chain (a settled row on one chain never settles the same address on another) and per address form:
 * 0x addresses ignore case, Solana base58 is case-sensitive. A candidate without a chain matches on address alone.
 */
export function cexReviewPending(candidates, answers) {
  const settledRows = [...(answers?.cex?.wallets ?? []), ...(answers?.cex?.rejected ?? [])];
  const settled = new Set(settledRows.map((r) => `${r?.chain ?? ""}:${canonAddress(String(r?.address ?? ""))}`));
  const settledAddress = new Set(settledRows.map((r) => canonAddress(String(r?.address ?? ""))));
  return candidates.filter((c) => !(c.chain ? settled.has(`${c.chain}:${canonAddress(String(c.address))}`) : settledAddress.has(canonAddress(String(c.address)))));
}

const cexReviewBlocked = ({ slug, pending, supplyTarget, address }) => {
  const lines = pending.map((c) => `  - ${c.address} ${c.label}${c.walletName && c.walletName !== c.label ? ` (${c.walletName})` : ""}: ${fmtNumber(c.balance)}${Number.isFinite(c.pctOfSupply) ? ` (${c.pctOfSupply}% of supply)` : Number(supplyTarget) > 0 ? ` (${((c.balance / Number(supplyTarget)) * 100).toFixed(2)}% of supply)` : ""}${c.url ? ` ${c.url}` : ""}`);
  return (
    `${pending.length} wallet(s) that the Dune spellbook labels as exchange wallets hold this token, and ${answersPath(slug)} neither lists them under cex.wallets nor rejects them. ` +
    `Until each is decided the first snapshot may count exchange balances as retail.\n` +
    `${lines.join("\n")}\n` +
    `Fix:\n` +
    `  1. open each link above and check on the explorer that the wallet really is that exchange's (name tag, funding pattern)\n` +
    `  2. accepted wallets: add {"chain": "<chain>", "address": "<address>", "exchange": "<name>", "source": "<URL>", "confidence": "high|medium|low"} to "cex.wallets" in ${answersPath(slug)} and set "cex.decision" to "list"\n` +
    `  3. every other wallet above: add {"chain": "<chain>", "address": "<address>", "note": "<one sentence: why it is not an exchange wallet>"} to "cex.rejected" in the same file (if you accepted none, "cex.decision" stays "none-known")\n` +
    `  4. ${reapplyCmd(slug, address)}\n` +
    `  5. ${mergeAndDispatch(slug)}\n` +
    `(the same list: ${spellbookCexCommand(slug)}, which writes data/${slug}/cex-dune-candidates.json)`
  );
};

const cexReviewUnavailable = (slug, error) =>
  `the exchange candidate list could not be built (${error}), so the CEX review cannot run.\n` +
  `Fix: run ${spellbookCexCommand(slug)} locally (it needs network access to raw.githubusercontent.com and the holder snapshot in public/data/${slug}/tel-holders.json), then ${mergeAndDispatch(slug)} if you changed ${answersPath(slug)}; otherwise just dispatch again (a network error clears)`;

const megaRaiseBlocked = (slug, findings) =>
  `${findings.map((f) => f.address).join(", ")} is acknowledged as a counted holder ("retail"/"unknown") but its balance cannot be put under holders.megaHolderThreshold without exceeding supply.target, so the snapshot would keep dropping it.\n` +
  `Fix: the balance is implausible for a retail wallet; trace it again. If it is a treasury/team/DEX/CEX/staking wallet change its largeHolders decision to "labelled" and list it under wallets, dex.pools, cex.wallets or staking.contracts in ${answersPath(slug)}, then ${mergeAndDispatch(slug)}`;

const goLiveBlocked = (slug, problems) =>
  `${problems.map((p) => `  - ${p}`).join("\n")}\n` +
  `Fix: apply the "fix:" hint inside each problem above (it names the file and field), ${mergeAndDispatch(slug)}. ` +
  `A problem with no "fix:" hint is a stale or missing report: regenerate it with gh workflow run refresh-wallet-flows.yml -f project=${slug} (wallet-flows), gh workflow run refresh-ledger.yml -f project=${slug} (ledger) or gh workflow run refresh-holders.yml -f project=${slug} (feeds). ` +
  `Reproduce locally: node scripts/check-go-live.js --project ${slug} --alignment strict`;

const alignmentStuckHint = (slug) =>
  `the nightly/refresh did not align the feeds. Run, with RPC env available (ENV_PASSPHRASE set): node scripts/build-cutoffs.js --project ${slug} --from <first holders date>, ` +
  `commit public/data/${slug}/date-blocks.json, merge, then ${dispatchCmd(slug)}; check the feeds with node scripts/check-feed-alignment.js --project ${slug} --strict`;

// ---------------------------------------------------------------------------
// Large-holder review and tier sizing (pure; the driver supplies the snapshot)
// ---------------------------------------------------------------------------

const canonAddress = (a) => (/^0x/i.test(a) ? a.toLowerCase() : a);

/** Addresses the owner acknowledged as counted holders (decision "retail" or "unknown"). A "labelled" row only counts once the wallet really is non-retail (then it never reaches the review). */
const ackedRetailAddresses = (rows) => new Set((rows ?? []).filter((r) => r?.decision !== "labelled").map((r) => canonAddress(String(r?.address ?? ""))));

/** Smallest 1 / 2.5 / 5 x 10^k at or above `x` (the ladder deriveHolderTiers.js floors to). */
export function ceilToLadder(x) {
  for (let k = 0; k <= 18; k += 1) {
    for (const m of [1, 2.5, 5]) {
      const v = m * 10 ** k;
      if (v >= x) return v;
    }
  }
  return x;
}

/** Headroom above the largest acknowledged retail wallet (ZBCN: 20.55B x 1.2 = 24.66B -> 25B). */
export const MEGA_HEADROOM = 1.2;

/**
 * holders.megaHolderThreshold as a function of the owner's recorded decisions, never lower than what is already set:
 * max(supply.target / 5, ceilToLadder(1.2 x largest acknowledged-retail balance) capped at supply.target, existing).
 */
export function megaThresholdFor({ supplyTarget, existing = null, ackedBalances = [] }) {
  const floor = supplyTarget / MEGA_SUPPLY_DIVISOR;
  const largest = Math.max(0, ...ackedBalances.filter(Number.isFinite));
  const needed = largest > 0 ? Math.min(supplyTarget, ceilToLadder(MEGA_HEADROOM * largest)) : 0;
  return Math.max(floor, needed, Number.isFinite(existing) ? existing : 0);
}

/** The raised threshold when an acknowledged-retail wallet sits above `current` (findings of kind "dropped"), else null (nothing to raise, or it cannot be raised). */
export function megaRaise({ supplyTarget, current, findings }) {
  const next = megaThresholdFor({ supplyTarget, existing: current, ackedBalances: findings.map((f) => f.balance) });
  return next > current ? next : null;
}

/**
 * Wallets above LARGE_HOLDER_SHARE of supply that a person has not settled.
 * kind "missing": no usable largeHolders row. kind "dropped": a "retail" row but the balance is above
 * megaHolderThreshold, which the snapshot drops from holder counts: the runner raises the threshold (megaRaise), it is not a stop.
 * Labelled wallets (isNonRetail) never appear: they are already out of retail.
 *
 * @param {object} p
 * @param {Array<Record<string, any>>} p.wallets snapshot wallets (address, total_telcoin_balance, <chain>_balance)
 * @param {string[]} p.chainKeys
 * @param {number} p.supplyTarget
 * @param {number} p.megaThreshold
 * @param {(address: string) => boolean} p.isNonRetail
 * @param {Array<{address: string}>} [p.rows] answers.largeHolders
 * @param {(chain: string, address: string) => string|null} [p.explorerUrl]
 */
export function largeHolderFindings({ wallets, chainKeys, supplyTarget, megaThreshold, isNonRetail, rows = [], explorerUrl = () => null }) {
  const acknowledged = ackedRetailAddresses(rows);
  const floor = supplyTarget * LARGE_HOLDER_SHARE;
  const out = [];
  for (const w of wallets) {
    const balance = Number(w.total_telcoin_balance);
    if (!(balance > floor) || isNonRetail(w.address)) continue;
    const aboveMega = balance > megaThreshold;
    const known = acknowledged.has(canonAddress(w.address));
    if (known && !aboveMega) continue;
    const chain = [...chainKeys].sort((a, b) => Number(w[`${b}_balance`] ?? 0) - Number(w[`${a}_balance`] ?? 0))[0] ?? chainKeys[0];
    out.push({ address: w.address, chain, balance, share: balance / supplyTarget, aboveMega, kind: known ? "dropped" : "missing", url: explorerUrl(chain, w.address) });
  }
  return out.sort((a, b) => b.balance - a.balance);
}

/**
 * The full `holders` sizing block from a project's own retail wallets, or { blocked } with the reason.
 * megaHolderThreshold comes from megaThresholdFor (the owner's acknowledged-retail large holders raise it above
 * supply.target / 5, never below `existingMega`). Retail = not in the non-retail set and not above that threshold
 * (the snapshot drops those as "mega"); acknowledged-retail whales are therefore sized into the tiers.
 * `snapshot.wallets` lists every wallet, including those the snapshot counted as "mega".
 */
export function sizingFromSnapshot({ slug, snapshot, isNonRetail, supplyTarget, today, largeHolderRows = [], existingMega = null }) {
  if (!(Number.isFinite(supplyTarget) && supplyTarget > 0)) {
    return { blocked: `supply.target is not set in config/projects/${slug}.json, so holder tiers cannot be sized.\nFix: set "supply": {"target": <tokens>} in config/projects/${slug}.json, ${mergeAndDispatch(slug)}` };
  }
  const acked = ackedRetailAddresses(largeHolderRows);
  const wallets = snapshot.wallets ?? [];
  const megaCap = megaThresholdFor({
    supplyTarget,
    existing: existingMega,
    ackedBalances: wallets.filter((w) => acked.has(canonAddress(String(w.address))) && !isNonRetail(w.address)).map((w) => Number(w.total_telcoin_balance)),
  });
  const balances = wallets.filter((w) => !isNonRetail(w.address) && Number(w.total_telcoin_balance) <= megaCap).map((w) => Number(w.total_telcoin_balance));
  let result;
  try {
    result = deriveHolderTiers(balances, { supplyTarget });
  } catch (error) {
    return { blocked: `${error.message}.\nFix: check that the first snapshot has retail holders (public/data/${slug}/tel-holders.json), or set holders.distributionTiers, balanceRanges and retailThreshold by hand in config/projects/${slug}.json, ${mergeAndDispatch(slug)}` };
  }
  if (result.largestTierShare > MAX_TIER_SHARE) {
    const shares = Object.entries(result.tierShares).map(([label, share]) => `${label} ${(share * 100).toFixed(1)}%`).join(", ");
    return {
      blocked:
        `derived tiers put ${(result.largestTierShare * 100).toFixed(1)}% of retail wallets in one tier (limit ${MAX_TIER_SHARE * 100}%): ${shares}.\n` +
        `Fix: in the holders block of config/projects/${slug}.json set distributionTiers (edges so that no tier holds more than ${MAX_TIER_SHARE * 100}% of wallets; node scripts/derive-holder-tiers.js --project ${slug} prints a starting point), ` +
        `balanceRanges, retailThreshold and concentrationBuckets (leave megaHolderThreshold alone: it is ${fmtNumber(megaCap)}, derived from supply.target and the acknowledged large holders), ${mergeAndDispatch(slug)}`,
    };
  }
  const date = String(snapshot.generatedAt ?? "").slice(0, 10) || today;
  return {
    result,
    holders: {
      $comment: `Derived by the onboarding runner (scripts/onboard-run.js) from ${slug}'s own snapshot of ${date} (${result.holders} retail holders; non-retail and mega wallets excluded). distributionTiers labels are JOIN KEYS into holder-transitions.json / tier-outflows.json / holders-history.json: changing them needs the history replay and downstream regeneration (README).`,
      distributionTiers: result.distributionTiers,
      balanceRanges: result.balanceRanges,
      megaHolderThreshold: megaCap,
      retailThreshold: result.retailThreshold,
      concentrationBuckets: result.concentrationBuckets,
    },
  };
}

/**
 * @param {object} p
 * @param {string} p.slug
 * @param {object} p.config config/projects/<slug>.json on main
 * @param {(rel: string) => any|null} p.readJson repo-relative JSON reader over main (null when absent)
 * @param {string} p.today YYYY-MM-DD (UTC)
 * @param {string[]} [p.goLive] check-go-live problems on main ([] = complete)
 * @param {boolean} [p.onboardingFlag] registry entry still carries onboarding: true
 * @param {object|null} [p.answers] the onboarding answers record on main (null when absent)
 * @param {string[]} [p.answersProblems] validation errors / applied mismatches of that record
 * @param {{historyStart?: string, largeHolders?: Array<object>}|null} [p.nativeDecisions] a native coin's owner decisions from its chain adapter (answers-file shape); used only when there is no answers record
 * @param {{candidates: Array<object>, error?: string}|null} [p.cexCandidates] labelled exchange wallets holding the token (cexCandidatesFromSpellbook), or the error that stopped the lookup (null = the CEX review does not apply)
 * @param {Array<object>|null} [p.largeHolders] findings of the large-holder review (null = review does not apply)
 * @param {string[]|null} [p.alignment] strict alignment problems (null = gate does not apply)
 * @param {Array<{id:string, done:boolean, why:string, action?:object, blocked?:string, stuck?:string}>} returns
 */
export function onboardingSteps({ slug, config, readJson, today, goLive = null, onboardingFlag = false, answers = null, answersProblems = [], nativeDecisions = null, cexCandidates = null, largeHolders = null, alignment = null }) {
  const data = (file) => readJson(`${config.data?.legacyRoot ? "public/data" : `public/data/${slug}`}/${file}`);
  const work = (file) => readJson(`${config.data?.legacyRoot ? "data" : `data/${slug}`}/${file}`);
  const vms = vmOf(config);
  const isEvm = vms.includes("evm");
  const evmChains = (config.chains ?? []).filter((c) => (c.vm ?? "evm") === "evm").map((c) => c.key);
  const historyStart = config.pipeline?.historyStart ?? null;
  const project = { slug, config };
  const address = tokenAddress(config, answers);
  const steps = [];

  if (answersProblems.length > 0) {
    steps.push({ id: "answers", done: false, why: `${answersProblems.length} problem(s) with ${answersPath(slug)}`, blocked: answersBlocked(slug, answersProblems, address) });
  }

  const cexRel = config.classification?.cexWallets ?? null;
  const cex = cexRel ? readJson(cexRel) : null;
  const cexCount = Array.isArray(cex?.wallets) ? cex.wallets.length : 0;
  const cexNone = answers?.cex?.decision === "none-known";
  steps.push({
    id: "cex-wallets",
    done: cexCount > 0 || cexNone,
    why: cexCount > 0 ? `${cexCount} CEX wallets listed` : cexNone ? "no CEX wallets by owner decision (answers cex.decision none-known)" : "no CEX wallets listed yet (the first snapshot would count exchange balances as retail)",
    stuck: `the sync found no exchange wallet for ${slug}. If none exist, set "cex": {"decision": "none-known", "evidence": "<where you looked>", "wallets": []} in ${answersPath(slug)}, run ${reapplyCmd(slug, address)}, ${mergeAndDispatch(slug)}`,
    ...(!isEvm
      ? { blocked: cexBlockedNonEvm(slug, config, vms, address) }
      : cexRel
        ? { action: { workflow: "sync-cex-wallets.yml", inputs: { project: slug } } }
        : { blocked: cexBlockedNoFile(slug, address) }),
  });

  const snapshot = data("tel-holders.json");
  steps.push({
    id: "snapshot",
    done: Boolean(snapshot),
    why: snapshot ? "first holders snapshot is on main" : "no holders snapshot yet",
    action: { workflow: "refresh-holders.yml", inputs: { project: slug } },
  });

  // none-known is "done" only when the machine-built candidate list is empty or fully decided (accepted under cex.wallets or rejected).
  if (cexCandidates !== null) {
    const pending = cexReviewPending(cexCandidates.candidates ?? [], answers);
    const failed = Boolean(cexCandidates.error);
    const reviewed = Boolean(snapshot) && !failed && pending.length === 0;
    steps.push({
      id: "cex-review",
      done: reviewed,
      why: !snapshot ? "waits for the first snapshot" : failed ? `exchange candidate list unavailable: ${cexCandidates.error}` : reviewed ? `${(cexCandidates.candidates ?? []).length} labelled exchange wallet(s) holding the token, all decided` : `${pending.length} labelled exchange wallet(s) holding the token need a decision`,
      ...(!reviewed && snapshot ? { blocked: failed ? cexReviewUnavailable(slug, cexCandidates.error) : cexReviewBlocked({ slug, pending, supplyTarget: Number(config.supply?.target), address }) } : {}),
    });
  }

  if (largeHolders !== null) {
    // "dropped" findings (acknowledged retail, above the threshold) are not a stop: the mega-threshold step raises it.
    const unresolved = largeHolders.filter((f) => f.kind !== "dropped");
    const reviewed = Boolean(snapshot) && unresolved.length === 0;
    steps.push({
      id: "large-holders",
      done: reviewed,
      why: !snapshot ? "waits for the first snapshot" : reviewed ? `every wallet above ${LARGE_HOLDER_SHARE * 100}% of supply is accounted for` : `${unresolved.length} wallet(s) above ${LARGE_HOLDER_SHARE * 100}% of supply need a decision`,
      ...(!reviewed && snapshot ? { blocked: largeHoldersBlocked({ slug, findings: unresolved, supplyTarget: Number(config.supply?.target), address, native: !answers && nativeDecisions !== null }) } : {}),
    });
  }

  const ownTiers = Array.isArray(config.holders?.distributionTiers) || String(config.holders?.defaultTiers ?? "").trim() !== "";
  steps.push({
    id: "tiers",
    done: ownTiers,
    why: ownTiers ? "tiers set in config" : "tiers not derived yet (never reuse another project's)",
    action: { edit: "derive-tiers" },
  });

  // Acknowledged-retail wallets above the threshold (acked after the tiers were derived, or grown): raise ONLY megaHolderThreshold.
  const tiersNow = projectHolderTiers(project);
  if (largeHolders !== null) {
    const dropped = largeHolders.filter((f) => f.kind === "dropped");
    const raised = megaRaise({ supplyTarget: Number(config.supply?.target), current: tiersNow.megaHolderThreshold, findings: dropped });
    steps.push({
      id: "mega-threshold",
      done: dropped.length === 0,
      why: dropped.length === 0 ? "every acknowledged retail wallet is under holders.megaHolderThreshold" : `${dropped.length} acknowledged retail wallet(s) above megaHolderThreshold ${fmtNumber(tiersNow.megaHolderThreshold)}${raised ? `; raising it to ${fmtNumber(raised)}` : ""}`,
      stuck: `holders.megaHolderThreshold in config/projects/${slug}.json must stay above every wallet acknowledged "retail" in ${answersPath(slug)}; compare it with the wallets listed by: node scripts/onboard-run.js --project ${slug} --dry-run`,
      ...(dropped.length === 0 ? {} : raised ? { action: { edit: "raise-mega-threshold" } } : { blocked: megaRaiseBlocked(slug, dropped) }),
    });
  }

  // holders-lite is rewritten by every refresh (a history row for the same day may not be), so it shows the tiers in use.
  const wanted = new Set(tiersNow.distributionTiers.map((t) => t.label));
  const liteLabels = (data("holders-lite.json")?.views?.combined?.distribution ?? []).map((d) => d.label);
  const onTiers = liteLabels.length > 0 && liteLabels.every((l) => wanted.has(l));
  // The snapshot records the threshold it ran with: after a raise the feeds must be refreshed even though the tier labels did not change.
  const snapMega = snapshot?.thresholds?.megaHolder;
  const megaFresh = largeHolders === null || !Number.isFinite(snapMega) || snapMega === tiersNow.megaHolderThreshold;
  steps.push({
    id: "snapshot-on-tiers",
    done: onTiers && megaFresh,
    why: !onTiers ? "feeds still use other tiers (refresh after the tier change)" : !megaFresh ? `the snapshot ran with megaHolderThreshold ${fmtNumber(snapMega)}, config says ${fmtNumber(tiersNow.megaHolderThreshold)} (refresh after the threshold change)` : "holders-lite uses the project's tiers",
    stuck: `holders-lite.json (views.combined.distribution) must list exactly the labels of holders.distributionTiers in config/projects/${slug}.json; compare them with: node -e "console.log(require('./public/data/${slug}/holders-lite.json').views.combined.distribution.map(d=>d.label))"`,
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
      stuck: `a chain that was deployed after ${historyStart} can never have a row that early. Set "historyStart" in ${answersPath(slug)} to the date the latest chain was deployed (or "forward-only"), run ${reapplyCmd(slug, address)}, ${mergeAndDispatch(slug)}`,
      action: isEvm
        ? { ...historyRun(behind[0] ?? evmChains[0]), more: behind.slice(1).map(historyRun) }
        : { workflow: "rebuild-holders-history-solana.yml", inputs: { project: slug, since: historyStart, dry_run: "false" } },
    });
  } else if ((answers ?? nativeDecisions)?.historyStart === "forward-only") {
    steps.push({ id: "history", done: true, why: `history: forward-only by owner decision (${answers ? "answers historyStart" : "the chain adapter's native decisions"}); no backfill steps` });
  } else if (answers) {
    steps.push({ id: "history", done: false, why: `answers say historyStart ${answers.historyStart} but the config has none`, blocked: historyBlockedStale(slug, answers.historyStart, address) });
  } else if (onboardingFlag) {
    steps.push({ id: "history", done: false, why: "no historyStart and no answers file: history mode was never decided", blocked: historyBlockedNoAnswers(slug, address) });
  }

  // The scan stamps asOf.date with the last day it fully covered (null while it is behind), so the stamp is the completeness signal;
  // a token with no exchange transfers in the window still stamps, where "newest row age" never would.
  const flowFeed = data("exchange-flow-history.json");
  const flowStamp = flowFeed?.asOf;
  const flowAge = flowStamp?.settled === true && flowStamp.date ? daysBetween(today, flowStamp.date) : null;
  steps.push({
    id: "exchange-flows",
    done: flowAge !== null && flowAge <= FLOW_ASOF_MAX_AGE_DAYS,
    why: !flowFeed
      ? "no exchange-flow feed yet"
      : !flowStamp
        ? "exchange-flow-history.json carries no asOf stamp (written by an older scan)"
        : flowAge === null
          ? "exchange-flow scan has not reached a settled day yet (asOf.date null)"
          : `exchange-flow scan covers through ${flowStamp.date} (${flowAge}d ago)`,
    stuck: `the scan did not reach the settled end. Read the scan log (gh run list --workflow scan-exchange-flows.yml --limit 3, then gh run view <id> --log) for RPC errors or a capped backlog, then ${dispatchCmd(slug)}`,
    action: { workflow: "scan-exchange-flows.yml", inputs: { project: slug, ...(isEvm ? { max_blocks_per_run: "3000000" } : {}) } },
  });

  if (historyStart && isEvm) {
    const cexFirst = data("cex-balance-history.json")?.entries?.[0]?.date ?? null;
    const ok = Boolean(cexFirst) && cexFirst <= historyStart;
    steps.push({
      id: "treasury-cex-history",
      done: ok,
      why: ok ? `CEX balance history starts ${cexFirst}` : `CEX balance history starts ${cexFirst ?? "nowhere"}, wanted ${historyStart}`,
      stuck: `no CEX or treasury wallet had a balance on ${historyStart}? Check public/data/${slug}/cex-balance-history.json and the backfill log (gh run list --workflow backfill-treasury-cex-history.yml --limit 3); if the wallets are newer than ${historyStart}, set a later "historyStart" in ${answersPath(slug)}, run ${reapplyCmd(slug, address)}, ${mergeAndDispatch(slug)}`,
      action: { workflow: "backfill-treasury-cex-history.yml", inputs: { project: slug, from: historyStart, to: dayBefore(today), write: "true" } },
    });
  }

  const tiersDoc = data("tier-outflows.json");
  const fpOk = tiersDoc?.tierFingerprint == null || tiersDoc.tierFingerprint === tierFingerprint(projectHolderTiers(project).distributionTiers);
  steps.push({
    id: "tier-outflows",
    done: tiersDoc?.complete === true && fpOk,
    why: !tiersDoc ? "no tier-outflows feed yet" : !fpOk ? "tier-outflows built on other tiers" : tiersDoc.complete ? "tier-outflows complete" : "tier-outflows still catching up",
    stuck: `tier-outflows.json must have "complete": true and tierFingerprint matching holders.distributionTiers; read the generate-tier-outflows log (gh run list --workflow generate-tier-outflows.yml --limit 3, then gh run view <id> --log)`,
    action: { workflow: "generate-tier-outflows.yml", inputs: { project: slug } },
  });

  if ((config.staking ?? []).some((s) => s.kind === "stakeChanged" || s.kind === "receiptModule")) {
    const stakers = data("funding-wallets.json");
    steps.push({
      id: "staker-balances",
      done: Boolean(stakers),
      why: stakers ? "staker balances on main" : "no staker balances yet",
      stuck: `refresh-staker-balances.yml wrote no funding-wallets.json; read its log (gh run list --workflow refresh-staker-balances.yml --limit 3) and check staking[] in config/projects/${slug}.json (kind, deployBlock)`,
      action: { workflow: "refresh-staker-balances.yml", inputs: { project: slug } },
    });
  }

  const flows = work("forensics/wallet-flows.json");
  const registry = work("forensics/wallet-flows.registry.json");
  const registryKnown = Array.isArray(registry?.knownWallets) && registry.knownWallets.length > 0;
  steps.push({
    id: "wallet-flows",
    done: Boolean(flows),
    why: flows ? "wallet-flows report on main" : registryKnown ? "no wallet-flows report yet" : "no wallet-flows report yet and the forensics registry has no known wallets",
    stuck: `wallet-flows.json was not written; read the log (gh run list --workflow refresh-wallet-flows.yml --limit 3, then gh run view <id> --log-failed) and check the wallets in ${answersPath(slug)}`,
    ...(!flows && !registryKnown ? { blocked: registryBlocked(slug, config, address) } : { action: { workflow: "refresh-wallet-flows.yml", inputs: { project: slug } } }),
  });

  const ledger = readJson(`data/${slug}/ledger/ledger.json`);
  steps.push({
    id: "ledger",
    done: Boolean(ledger),
    why: ledger ? "developer-wallet ledger on main" : "no developer-wallet ledger yet",
    stuck: `ledger.json was not written; read the log (gh run list --workflow refresh-ledger.yml --limit 3, then gh run view <id> --log-failed) and check developerWallets in config/projects/${slug}/ledger.json`,
    action: { workflow: "refresh-ledger.yml", inputs: { project: slug } },
  });

  const walletsOn = config.capabilities?.projectWallets === true;
  steps.push({
    id: "developer-wallets-tab",
    done: walletsOn,
    why: walletsOn ? "Developer wallets tab on" : "ledger exists but capabilities.projectWallets is off",
    action: { edit: "enable-project-wallets" },
  });

  // Cutoffs: every workflow above (refresh-holders, scan-exchange-flows, generate-tier-outflows, rebuild history) resolves
  // and commits its own date-blocks.json cutoffs, so a settled refresh is what aligns the feeds. No runner step calls
  // build-cutoffs (it needs RPC env this job does not have and the job may not stage date-blocks.json).
  if (alignment !== null) {
    const aligned = alignment.length === 0;
    steps.push({
      id: "alignment",
      done: aligned,
      why: aligned ? "strict alignment passes (feeds share asOf and day cutoffs)" : `strict alignment: ${alignment.length} problem(s): ${alignment.slice(0, 3).join(" | ")}${alignment.length > 3 ? " | ..." : ""}`,
      stuck: `${alignment.join("; ")}. ${alignmentStuckHint(slug)}`,
      action: { workflow: "refresh-holders.yml", inputs: { project: slug } },
    });
  }

  if (goLive !== null) {
    const live = goLive.length === 0;
    steps.push({
      id: "go-live",
      done: live,
      why: live ? "check-go-live passes" : `check-go-live: ${goLive.length} problem(s)`,
      blocked: live ? undefined : goLiveBlocked(slug, goLive),
    });
    steps.push({
      id: "list-on-site",
      done: !onboardingFlag,
      why: onboardingFlag ? "registry entry still marked onboarding" : "listed (shows after the next manual Netlify deploy)",
      action: { edit: "clear-onboarding-flag" },
    });
  }
  for (const s of steps) {
    if (s.id === "cex-wallets" || s.done || !STEP_VMS[s.id] || unsupported(s.id, vms).length === 0) continue;
    delete s.action;
    s.blocked = notBuilt(s.id, vms, slug);
  }
  return steps;
}

/** The first step still to do, or null when onboarding is finished. */
export const nextStep = (steps) => steps.find((s) => !s.done) ?? null;

// ---------------------------------------------------------------------------
// Stop messages (exit 1 / 2 / 3 and "not done after N runs")
// ---------------------------------------------------------------------------

/** Exit 2: a step only a person can unblock. */
export const blockedMessage = (step) => `Blocked at ${step.id}:\n${step.blocked ?? step.why}`;

/** Exit 2: the step ran MAX_RUNS_PER_STEP times and is still not done. */
export function stuckMessage(step, slug, runs = MAX_RUNS_PER_STEP) {
  const workflow = step.action?.workflow;
  return (
    `${step.id} is still not done after ${runs} runs (${step.why}).\n` +
    `Fix:\n` +
    (workflow ? `  1. gh run list --workflow ${workflow} --limit 3   then   gh run view <id> --log-failed\n` : "") +
    `  ${workflow ? "2" : "1"}. ${step.stuck ?? `node scripts/check-go-live.js --project ${slug} --alignment strict shows what is missing`}\n` +
    `  ${workflow ? "3" : "2"}. after the cause is fixed (edits ${mergeAndDispatch(slug)})`
  );
}

/** Exit 1: a dispatched workflow ended in anything but success. */
export const workflowFailedMessage = ({ workflow, id, conclusion, url, slug }) =>
  `${workflow} run ${id} ended ${conclusion}: ${url}\n` +
  `Fix: gh run view ${id} --log-failed   (read the error, fix its cause in the file it names, merge to main), then run: ${dispatchCmd(slug)}`;

/** Exit 1: gh accepted the dispatch but no run showed up. */
export const noRunAppearedMessage = (workflow, slug) =>
  `${workflow}: dispatched but no run appeared.\n` +
  `Fix: gh run list --workflow ${workflow} --limit 5 (check the workflow exists on main and Actions is enabled), then run: ${dispatchCmd(slug)}`;

/** Exit 1: the slug is not in the registry on main. */
export const notOnMainMessage = (slug) =>
  `${slug} is not in config/projects.json on main.\n` +
  `Fix: npm run onboard -- --address <token address> --answers ${answersPath(slug)} --write, review the diff, merge to main, then run: ${dispatchCmd(slug)}`;

/** Exit 3: the runner edited the checkout and wants the edit reviewed (no --commit). */
export const editAwaitsReviewMessage = ({ files, message, slug }) =>
  `Edited ${files.join(", ")} (${message}).\n` +
  `Fix: review the diff (git diff -- ${files.join(" ")}), commit it, merge to main, then run: ${dispatchCmd(slug)} (or: node scripts/onboard-run.js --project ${slug})`;

/** Exit 0 with work left: the time budget ran out and no further round is dispatched. */
export const timeBudgetMessage = (step, slug) =>
  `Time budget used at ${step.id}.\nFix: run ${dispatchCmd(slug)} to continue; it resumes at ${step.id}.`;

/** Exit 1: bad invocation. */
export const usageMessage = (reason) =>
  `${reason}.\nFix: node scripts/onboard-run.js --project <slug> [--dry-run [--local]]   (flags: --commit --redispatch --round N --budget-min N --push-cmd "<cmd>")`;
