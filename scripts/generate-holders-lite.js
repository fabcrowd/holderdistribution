#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildSnapshotData,
  buildViewData,
  buildOverlapStats,
  setHolderTiers,
} from "./lib/holdersView.js";
import { projectHolderTiers } from "./lib/holderTiers.js";
import { loadNonRetailSet, createNonRetailChecker } from "./lib/nonRetailSet.js";
import { loadV3StakingPositions } from "./lib/v3Staking.js";
import { loadSolanaStakingPositions } from "./lib/solanaStaking.js";
import { selectPipelineProject, projectPaths, projectChains, projectNonRetailPaths, projectWork } from "./lib/projects.js";

// `--project <slug>` (or HD_PROJECT); defaults to TEL. Ported: reads and writes
// the project's data dir (TEL: public/data/, others: public/data/<slug>/) and
// its own chain/classification config — see scripts/lib/projects.js.
const project = selectPipelineProject("generate-holders-lite", { ported: true });
// Balance ranges / distribution tiers / concentration sizes for this project.
setHolderTiers(projectHolderTiers(project));
const data = projectPaths(project);

const INPUT_PATH = data("tel-holders.json");
const PREVIOUS_PATH = data("tel-holders-previous.json");
const FUNDING_WALLETS_PATH = data("funding-wallets.json");
const CEX_FLOWS_PATH = data("cex-flows.json");
const OUTPUT_PATH = data("holders-lite.json");
const CHECKPOINT_PATH = data("holders-checkpoint.json");
const ASOF_BLOCKS_PATH = projectWork(project)("holders-asof-blocks.json");

const readJson = async (absolutePath, fallback = null) => {
  try {
    const content = await fs.readFile(absolutePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

const main = async () => {
  const snapshot = await readJson(INPUT_PATH);
  if (!snapshot) {
    console.error("tel-holders.json not found. Unable to generate lite snapshot.");
    process.exit(1);
  }

  const previousSnapshot = await readJson(PREVIOUS_PATH);

  // Suppress deltas when the minimum balance threshold changed between runs.
  // This prevents misleading +/- badges when methodology (MIN_TEL_RAW) changes.
  const methodologyChanged =
    snapshot.thresholds?.minTelRaw !== previousSnapshot?.thresholds?.minTelRaw;
  if (methodologyChanged) {
    console.log(
      `Methodology changed (minTelRaw: ${previousSnapshot?.thresholds?.minTelRaw} → ` +
        `${snapshot.thresholds?.minTelRaw}); previous snapshot suppressed — no deltas this run.`,
    );
  }
  const effectivePrevious = methodologyChanged ? null : previousSnapshot;

  const fundingWallets = await readJson(FUNDING_WALLETS_PATH);
  const cexFlows = await readJson(CEX_FLOWS_PATH);
  const { set: nonRetailSet, sizes } = await loadNonRetailSet(projectNonRetailPaths(project));
  console.log(
    `Non-retail set: ${sizes.total} addresses ` +
      `(exclusions ${sizes.exclusions}, CEX config ${sizes.cex}, DEX config ${sizes.dex}).`,
  );

  const isNonRetailAddress = createNonRetailChecker(nonRetailSet);

  // v3 StakingModule positions from the same checkpoint pull-holders-rpc.js
  // just wrote (no RPC needed). Only for the current snapshot: the previous
  // one predates this checkpoint, and staking stats have no "previous" side.
  const [checkpoint, chainConfig, asOfBlocks] = await Promise.all([
    readJson(CHECKPOINT_PATH),
    projectChains(project),
    readJson(ASOF_BLOCKS_PATH),
  ]);
  let v3Staking = loadV3StakingPositions(checkpoint, chainConfig, asOfBlocks);
  // Solana program staking (e.g. zebecStakeV1): same informational overlay as
  // TEL v3. pull-holders-rpc.js already credited each staker and reduced
  // stake-vault custody, so this must not be added to balances again.
  if (!v3Staking) v3Staking = loadSolanaStakingPositions(await readJson(data("solana-staking.json")));
  // A rebuilt past day (pull-holders-rpc.js --as-of) from before the module
  // existed must not pick up today's positions from the live checkpoint.
  const snapshotDate = snapshot?.source?.snapshotDate ?? null;
  if (v3Staking && snapshotDate && v3Staking.modules.every((m) => m.deployDate && snapshotDate < m.deployDate)) {
    console.log(`v3 staking: snapshot ${snapshotDate} predates the StakingModule; skipped.`);
    v3Staking = null;
  }
  if (v3Staking) {
    const total = [...v3Staking.positions.values()].reduce((s, v) => s + v, 0);
    console.log(
      `v3 staking: ${v3Staking.positions.size} stakers, ${Math.round(total).toLocaleString()} TEL ` +
        `(${v3Staking.modules.map((m) => `${m.name} from ${m.deployDate ?? `block ${m.deployBlock}`}`).join(", ")}).`,
    );
  }

  const current = buildSnapshotData(snapshot, fundingWallets, isNonRetailAddress, v3Staking);
  const previous = buildSnapshotData(effectivePrevious, fundingWallets, isNonRetailAddress);

  // Views are derived from the snapshot's own chainOrder — never a hardcoded
  // ethereum/polygon/base literal, which would silently ignore a chain added to
  // config/chains.json (CLAUDE.md: dynamic chain keys).
  const views = {
    combined: {
      key: "combined",
      label: "Combined",
      ...buildViewData("combined", current, previous),
    },
  };
  for (const chainKey of current?.chainOrder ?? Object.keys(current?.chains ?? {})) {
    if (chainKey === "combined") continue;
    views[chainKey] = {
      key: chainKey,
      label: current?.chains?.[chainKey]?.name ?? chainKey,
      ...buildViewData(chainKey, current, previous),
    };
  }

  const liteSnapshot = {
    generatedAt: current?.generatedAt ?? null,
    thresholds: current?.thresholds ?? { retail: 0, megaHolder: 0 },
    totals: current?.totals ?? { totalSupply: 0 },
    source: current?.source ?? null,
    chainOrder: current?.chainOrder ?? [],
    views,
    overlap: buildOverlapStats(current?.chains ?? {}, current?.chainOrder ?? []),
    cex: cexFlows ?? null,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(liteSnapshot, null, 2)}\n`, "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
