#!/usr/bin/env node
/**
 * generate-wallet-flows-hedera.js [--project <slug>] [--as-of YYYY-MM-DD]
 *
 * Hedera counterpart of generate-wallet-flows-solana.js: refreshes the GATED "Wallet flows" report of a project's
 * native Hedera coin. Output (served only by the forensics gate):
 *   <work>/forensics/wallet-flows.json               the report
 *   <work>/forensics/wallet-flows-hedera-state.json  per-stream cursors + the 90-day raw sender events
 * <work> is data/<slug>. The senders are the registry wallets (the project-controlled treasury accounts, without
 * the network system accounts the registry lists under notTraced). Rules: scripts/lib/hedera/walletFlowScan.js.
 *
 * Window and settlement: the 90 days end at the settled consensus end of the target day (--as-of | yesterday UTC),
 * the same boundary as the holders snapshot and the exchange flows, so every window is anchored there.
 *
 * A run ends in exactly one of three states. Complete: report written, exit 0. Budget (HEDERA_WALLET_FLOWS_MAX_MS,
 * default 40 min): cursors saved, NO report, exit 0 with GITHUB_OUTPUT partial=true. Error (a stream that still fails
 * after the client's retries, a thrown invariant such as an out-of-order row, a failed validation, anything else):
 * the last consistent state is saved when there is one, the previous report stays, exit 1, and partial=true is also
 * written so the workflow commits the state and applies the stale-report rule. There is no soft exit 0 and no --strict.
 *
 * The state depends on the sender set only (scanHash); the CEX list, DEX list and registry labels are applied
 * when the report is built, so changing them never costs a rescan.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadChainAdapter } from "./lib/chainAdapters.js";
import { resolveSettledDate } from "./lib/asOf.js";
import { projectPaths, projectRoleAddresses, projectWork, selectPipelineProject } from "./lib/projects.js";
import { WALLET_FLOWS_FILE, WALLET_FLOWS_REGISTRY_FILE, walletFlowsNotes } from "./lib/walletFlowsProject.js";
import { validateWalletFlowsReport, WINDOWS } from "./lib/walletFlows.js";
import { aggregateWalletOutflows, buildSolanaWalletRows, distributionFromRecon, solanaSellTotals } from "./lib/solana/walletFlowsSolana.js";

const ROOT = process.cwd();
const STATE_FILE = "forensics/wallet-flows-hedera-state.json";
const DEFAULT_MAX_MS = 40 * 60 * 1000;
const SAVE_EVERY_MS = 20_000;
const PRICE_TIMEOUT_MS = 10_000;
const HBAR_DECIMALS_FALLBACK = 8;

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const readJsonOr = async (file, fallback) => {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};
/** Tmp file + rename: a half-written state would make the next run lose its cursors. */
async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

/** One CoinGecko request for the native coin. Falls back to the previous report's price. */
async function fetchPrice(coingeckoId, previous) {
  const carried = { priceUsd: previous?.priceUsd ?? 0, priceSource: `${previous?.priceSource ?? "unknown"} (carried over)` };
  if (!coingeckoId) return carried;
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coingeckoId)}&vs_currencies=usd`, { signal: AbortSignal.timeout(PRICE_TIMEOUT_MS) });
    const price = Number((await res.json())?.[coingeckoId]?.usd);
    if (price > 0) return { priceUsd: price, priceSource: `CoinGecko simple/price (${coingeckoId})` };
  } catch {
    /* fall through to the carried-over price */
  }
  return carried;
}

const noteLine = (kit, registry, omitted, anchorIso) => kit.HEDERA_REPORT_NOTES(registry.notTraced ?? [], omitted, anchorIso);

/** Report from a complete state. Pure apart from the clock in `generated`. */
export function buildReport({ kit, project, chain, registry, state, balances, roles, price, recon, reconRel, anchorSec }) {
  const ticker = project.config?.ticker ?? project.slug.toUpperCase();
  const name = project.config?.name ?? project.slug;
  const windowEvents = kit.pruneEvents(state.events, anchorSec).filter((e) => e.dir !== "in");
  const labelled = kit.labelEvents(windowEvents, roles);
  kit.outflowTotals(labelled); // exact tinybar invariant (kinds sum to the total) before any HBAR conversion
  const decimals = Number(chain.asset?.decimals ?? HBAR_DECIMALS_FALLBACK);
  const flows = aggregateWalletOutflows(labelled, anchorSec, decimals);
  const active = (registry.knownWallets ?? []).filter((w) => (balances.get(w.address) ?? 0) > 0 || flows.has(w.address));
  const omitted = (registry.knownWallets ?? []).length - active.length;
  const rows = buildSolanaWalletRows({ ...registry, knownWallets: active }, flows, balances, price.priceUsd, kit.hederaSampleTxs(labelled, anchorSec)).map((r) => ({
    ...r,
    balanceDetail: r.balance > 0 ? { [chain.key]: r.balance } : {},
  }));
  const anchorIso = new Date(anchorSec * 1000).toISOString();
  return {
    version: 1,
    generated: new Date().toISOString(),
    generator: "scripts/generate-wallet-flows-hedera.js",
    project: project.slug,
    priceUsd: price.priceUsd,
    priceSource: price.priceSource,
    chains: [chain.key],
    asOf: { date: state.throughDate, through: state.through, anchor: anchorIso, settled: true },
    notes: [...walletFlowsNotes({ legacy: false, ticker, name }), ...noteLine(kit, registry, omitted, anchorIso)],
    notTraced: registry.notTraced ?? [],
    distribution: { ...distributionFromRecon(recon), source: reconRel },
    telcoinTotals: solanaSellTotals(rows, price.priceUsd),
    knownWallets: rows,
    fundingLinks: [],
    botCluster: {
      label: "None tracked",
      chain: chain.key,
      addresses: [],
      balance: 0,
      dexSales: Object.fromEntries(WINDOWS.map((w) => [w, 0])),
      cexDeposits: Object.fromEntries(WINDOWS.map((w) => [w, 0])),
    },
    largeSellers: [],
  };
}

/**
 * Venue sets of the report: the senders and the registry's notTraced accounts (network-controlled treasury, so a
 * transfer to them is internal and carries the registry label), the project's exchange accounts and its DEX/wrapped
 * role contracts.
 */
export function venueRoles({ senders, notTraced = [], cexAccounts, dexIds }) {
  return {
    wallets: new Set([...senders, ...notTraced.map((a) => a.address)]),
    labels: new Map(notTraced.map((a) => [a.address, a.label ?? a.name ?? a.address])),
    cex: new Map(cexAccounts.map((a) => [a.id, a.exchange])),
    dex: new Set(dexIds),
    staking: new Set(),
  };
}

/** Every end that is not a written report: visible as ::error/::notice, a step summary and outputs.partial=true. */
async function announceIncomplete({ headline, line, isError }, ctx) {
  ctx.announced = true;
  console.log(`::${isError ? "error" : "notice"} title=wallet-flows ${headline}::${line}`);
  try {
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### wallet-flows (Hedera): ${headline}\n\n${line}\n`);
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, "partial=true\n");
  } catch (error) {
    console.warn(`generate-wallet-flows-hedera: could not write the step summary or output (${error?.message ?? error})`);
  }
}

async function main(ctx) {
  const argv = process.argv.slice(2);
  const argValue = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const { loadEnv } = await import("./loadEnv.js");
  await loadEnv();
  const project = selectPipelineProject("generate-wallet-flows-hedera", { ported: true });
  const adapter = await loadChainAdapter("hedera");
  const kit = await adapter.walletFlows();
  const flows = await adapter.flows();
  const chains = kit.hederaFlowChains(project.config);
  if (chains.length === 0) {
    console.log(`${project.slug}: no Hedera chain; nothing to do.`);
    return;
  }
  if (chains.length > 1) throw new Error(`${project.slug}: ${chains.length} Hedera chains; the wallet-flows scan supports one native coin per project`);
  const [{ chain, key, decimals }] = chains;

  const work = projectWork(project);
  const data = projectPaths(project);
  const registryFile = work(WALLET_FLOWS_REGISTRY_FILE);
  const registry = await readJsonOr(registryFile, null);
  if (!registry) {
    console.warn(`generate-wallet-flows-hedera: no registry at ${path.relative(ROOT, registryFile)} for ${project.slug}; nothing to do.`);
    return;
  }
  const outFile = work(WALLET_FLOWS_FILE);
  ctx.out = outFile;
  const stateFile = work(STATE_FILE);
  const reconFile = data("supply-reconciliation.json");
  const senders = kit.senderIds(registry);
  if (senders.length === 0) throw new Error(`${project.slug}: the registry lists no wallets to trace`);
  const hash = kit.scanHash(senders, kit.FLOW_CLASSIFIER_VERSION);

  const target = resolveSettledDate({ asOf: argValue("--as-of") ?? null });
  const stored = await readJsonOr(stateFile, null);
  const targetDate = stored?.throughDate && stored.throughDate > target && stored.hash === hash ? stored.throughDate : target;
  const { client, requests } = kit.countRequests(adapter.mirrorClient(chain));
  const clock = adapter.clock(chain, { client });
  const known = stored?.throughDate && stored.dayEnd ? { [stored.throughDate]: stored.dayEnd } : {};
  const { ends } = await kit.resolveDayEnds(project, { key, clock, firstDate: targetDate, lastDate: targetDate, known });
  const dayEnd = ends[targetDate];
  const through = dayEnd.stamp;
  const floor = kit.windowStart(through);
  const anchorSec = kit.secondsOf(through);

  const plan = kit.planResume({ state: stored, hash, key, floor });
  if (plan.rebuilt && stored) console.warn(`  ${key}: ${plan.reason}; rescanning the ${kit.WINDOW_DAYS}-day window.`);
  let state = { ...plan.state, through, throughDate: targetDate, dayEnd, complete: false };
  console.log(`  ${key}: ${senders.length} senders; window ${floor} .. ${through} (${targetDate}, block ${dayEnd.block})`);

  const deadlineMs = Date.now() + (Number(process.env.HEDERA_WALLET_FLOWS_MAX_MS) || DEFAULT_MAX_MS);
  const startedAt = Date.now();
  let lastSave = 0;
  const save = async ({ newEvents, cursors }) => {
    state = { ...kit.mergeEvents(state, newEvents), cursors };
    if (Date.now() - lastSave < SAVE_EVERY_MS) return;
    lastSave = Date.now();
    await writeAtomic(stateFile, `${JSON.stringify(state)}\n`);
  };
  const res = await kit.scanSavingStateOnError({
    scan: () => kit.scanSenderFlows({ client, senders, cursors: state.cursors, start: floor, through, deadlineMs, onProgress: save }),
    snapshot: () => state,
    persist: (s) => writeAtomic(stateFile, `${JSON.stringify(s)}\n`),
    window: { floor, through },
  });
  const behind = res.streams.filter((k) => kit.nanosOf(res.cursors[k].until) < kit.nanosOf(through));
  state = { ...state, cursors: res.cursors, events: kit.pruneEvents(state.events, anchorSec), complete: behind.length === 0 && res.failed.length === 0 };
  await writeAtomic(stateFile, `${JSON.stringify(state)}\n`);

  const s = res.stats;
  console.log(
    `  ${key}: ${s.transactions} records read (${s.owned} counted, ${s.failedTransactions} failed, ${s.rewardRecords} with a staking reward), ${s.events} events, ` +
      `${s.pages} pages, ${requests()} mirror requests, ${((Date.now() - startedAt) / 1000).toFixed(1)} s`,
  );
  if (s.feeUnmatched) console.warn(`  ${key}: ${s.feeUnmatched} records whose fee legs did not match charged_tx_fee; check them`);
  if (res.failed.length) {
    console.error(`  ${key}: ${res.failed.length} sender stream scans failed after retries; no report from partial data`);
    await announceIncomplete(
      { headline: "stream failure, state saved", isError: true, line: `${res.failed.length} sender stream scans failed after retries (${res.failed.map((f) => f.account).join(", ")}); cursors kept, the report was not rebuilt, the next run resumes.` },
      ctx,
    );
    process.exitCode = 1;
    return;
  }
  if (!state.complete) {
    await announceIncomplete(
      { headline: "partial, will continue", isError: false, line: `${behind.length} of ${res.streams.length} sender streams are behind the settled end ${through}; the report was not rebuilt, the next run resumes.` },
      ctx,
    );
    console.log(`  ${key}: partial (${behind.length} streams behind); state saved, no report written`);
    return;
  }

  const previous = await readJsonOr(outFile, null);
  const price = await fetchPrice(project.config?.gated?.walletFlows?.coingeckoId ?? null, previous);
  const balances = await kit.fetchSenderBalances(client, senders);
  const dexIds = (projectRoleAddresses(project.config, { roles: ["dex"] })[key] ?? []).map((e) => e.address);
  const roles = venueRoles({ senders, notTraced: registry.notTraced ?? [], cexAccounts: flows.hederaFlowAccounts(project).map((a) => ({ id: a.id, exchange: a.exchange })), dexIds });
  const recon = await readJson(reconFile);
  const report = buildReport({
    kit, project, chain: { ...chain, asset: { ...chain.asset, decimals } }, registry, state, balances, roles, price, recon,
    reconRel: path.relative(ROOT, reconFile).split(path.sep).join("/"), anchorSec,
  });
  const errors = validateWalletFlowsReport(report, { addressKind: "hedera" });
  if (errors.length) throw new Error(`report failed validation: ${errors.join("; ")}`);
  await writeAtomic(outFile, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`Wrote ${path.relative(ROOT, outFile)} (${report.knownWallets.length} wallets, ${s.owned} records counted, complete through ${targetDate}, ${requests()} mirror requests)`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const ctx = { out: null };
  main(ctx).catch(async (error) => {
    console.error(`generate-wallet-flows-hedera: failed - ${error?.stack ?? error}`);
    if (ctx.out) console.error(`Previous ${path.relative(ROOT, ctx.out)} left unchanged.`);
    // An error that no step above announced still ends visibly: partial=true feeds the commit message and the stale-report rule.
    if (!ctx.announced) await announceIncomplete({ headline: "error, no report written", isError: true, line: String(error?.message ?? error).slice(0, 300) }, ctx);
    process.exitCode = 1;
  });
}
