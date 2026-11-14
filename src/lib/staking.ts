import type { ClassificationEvent } from "@/lib/classificationChangelog";
import { copyText } from "@/lib/projectCopy";
import type { ProjectConfig } from "@/lib/projects";

/**
 * Staked TEL = legacy staking contract + v3 StakingModule.
 *
 * The v3 StakingModule (Polygon 0x5731…5731) went live on 2026-09-01 UTC
 * (block 93,048,895). The archived holder snapshots don't include its
 * positions, so its history can't be rebuilt:
 *   - before the deploy date it held nothing, so v3 = 0 (and the legacy
 *     figure IS the whole staked total);
 *   - from the deploy date until the pipeline started measuring it the value
 *     is unknown (null), never interpolated;
 *   - dates that carry `combined.stakingV3Balance` are measured.
 * holders-lite's `stakingStats.v3.deployDate` is the source of truth; this
 * constant is only the fallback for payloads that predate that field.
 */
export const V3_STAKING_DEPLOY_DATE = "2026-09-01";
export const V3_STAKING_DEPLOY_BLOCK = 93_048_895;
/** Polygon address of the v3 StakingModule (config/chains.json polygon.tokens.v3.staking). */
export const V3_STAKING_MODULE = "0x573105be2148b8621f202a6d510016a2aa825731";

type StakingProject = Pick<ProjectConfig, "ticker" | "name" | "chains" | "supply" | "copy" | "staking">;

/** True when the project's staking[] has both a legacy and a v3 generation (the split-and-migration story). */
export const hasStakingGenerations = (project: Pick<ProjectConfig, "staking">): boolean => {
  const generations = new Set((project.staking ?? []).map((s) => s.token));
  return generations.has("legacy") && generations.has("v3");
};

/**
 * Deploy date of the v3 channel: the feed's `stakingStats.v3.deployDate`, else
 * (payloads that predate that field) the constant, but only for a project that
 * has both generations. Null means the channel has no deploy cut-off: its
 * values are never dropped and no migration marker is drawn.
 */
export const stakingDeployDate = (
  feedDeployDate: string | null | undefined,
  project: Pick<ProjectConfig, "staking">,
): string | null => feedDeployDate ?? (hasStakingGenerations(project) ? V3_STAKING_DEPLOY_DATE : null);

/**
 * A history row's v3-channel value: null before the module's deploy (it held
 * nothing); untouched when there is no deploy date, because a program-only
 * token records its staking on that channel from day one.
 */
export const v3ChannelValue = (deployMs: number | null, timestampMs: number, value: number | null): number | null =>
  deployMs != null && timestampMs < deployMs ? null : value;

export type StakingWording = {
  legacy: string;
  v3: string;
  legacyShort: string;
  v3Short: string;
  marker: string;
  markerNote: string;
};

/** "Legacy 1.2M / v3 3.4M" from already-formatted amounts. */
export const stakingSplitText = (wording: StakingWording, legacyAmount: string, v3Amount: string): string =>
  `${wording.legacyShort} ${legacyAmount} / ${wording.v3Short} ${v3Amount}`;

/**
 * Labels for the legacy/v3 split. Only shown for a project that has both
 * channels; override per project with copy.text `staking.legacyLabel`,
 * `staking.v3Label`, `staking.migrationMarker`, `staking.migrationNote`.
 */
export const stakingWording = (project: StakingProject): StakingWording => ({
  legacy: copyText(project, "staking.legacyLabel", "Legacy contract"),
  v3: copyText(project, "staking.v3Label", "v3 StakingModule"),
  legacyShort: copyText(project, "staking.legacyShort", "Legacy"),
  v3Short: copyText(project, "staking.v3Short", "v3"),
  marker: copyText(project, "staking.migrationMarker", "v3 migration"),
  markerNote: copyText(
    project,
    "staking.migrationNote",
    "The v3 StakingModule went live and stakers began migrating from the legacy contract",
  ),
});

const DAY = /^\d{4}-\d{2}-\d{2}/;
const dayOf = (date: string | number | null | undefined): string | null => {
  if (date == null) return null;
  if (typeof date === "number") return Number.isFinite(date) ? new Date(date).toISOString().slice(0, 10) : null;
  return DAY.test(date) ? date.slice(0, 10) : null;
};

/** v3 staked balance on a history date: measured, 0 before the deploy, else null. */
export const v3StakedOn = (
  date: string | number | null | undefined,
  measured: number | null | undefined,
  deployDate: string = V3_STAKING_DEPLOY_DATE,
): number | null => {
  if (typeof measured === "number" && Number.isFinite(measured)) return measured;
  const day = dayOf(date);
  if (!day) return null;
  return day < deployDate ? 0 : null;
};

/** Legacy + v3, or null when either side is unknown for that date. */
export const combinedStaked = (legacy: number | null | undefined, v3: number | null | undefined): number | null =>
  typeof legacy === "number" && Number.isFinite(legacy) && typeof v3 === "number" && Number.isFinite(v3)
    ? legacy + v3
    : null;

export type HistoryStakingPoint = {
  /** Legacy contract. Null when that contract reported nothing (Solana program staking). */
  staking: number | null;
  /** v3 StakingModule, or Solana program staking recorded on that channel. */
  stakingV3: number | null;
  /** Sum, or the program total alone when there is no legacy figure. Null in the TEL v3 gap. */
  stakingTotal: number | null;
};

/**
 * One holders-history row for the Staked chart.
 * A row with only `stakingV3Balance` (Solana program total from solana-staking.json,
 * no funding-wallets legacy figure) still plots: the total is that measured number,
 * not a sum with an invented legacy balance.
 * A legacy row whose v3 side was not measured (after the module's deploy) keeps
 * `stakingTotal` null so the total line breaks instead of treating v3 as 0.
 */
export const historyStakingPoint = (
  date: string | number | null | undefined,
  stakingBalance: number | null | undefined,
  stakingV3Balance: number | null | undefined,
): HistoryStakingPoint | null => {
  const staking =
    typeof stakingBalance === "number" && Number.isFinite(stakingBalance) && stakingBalance > 0
      ? stakingBalance
      : null;
  const stakingV3 = v3StakedOn(date, stakingV3Balance);
  const programOnly = staking == null && typeof stakingV3 === "number" && stakingV3 > 0;
  if (staking == null && !programOnly) return null;
  const stakingTotal = combinedStaked(staking ?? (programOnly ? 0 : null), stakingV3);
  return { staking, stakingV3, stakingTotal };
};

/**
 * Network-wide staked amount of a native coin (holders-lite `networkStake`, written by
 * scripts/generate-holders-lite.js through the chain adapter's optional `stakingInfo` port).
 * Informational only: staked coins stay in the holder's own account and are already inside every
 * holder balance, so it is never subtracted from anything. It has its own as-of (the staking period),
 * separate from the snapshot's settled day.
 */
export type NetworkStake =
  | { available: true; stakedTotal: number; stakingPeriod: { start: string; end: string } }
  | { available: false; reason: string };

/**
 * The feed's `networkStake` block, validated. Null when the feed carries none (no tile at all).
 * A block that claims data but is not usable counts as unavailable, never as a zero.
 */
export const networkStakeOf = (snapshot: object | null | undefined): NetworkStake | null => {
  const raw = (snapshot as { networkStake?: unknown } | null | undefined)?.networkStake;
  if (raw == null || typeof raw !== "object") return null;
  const n = raw as { available?: unknown; stakedTotal?: unknown; stakingPeriod?: { start?: unknown; end?: unknown }; reason?: unknown };
  const unavailable = { available: false as const, reason: typeof n.reason === "string" ? n.reason : "no figure published" };
  if (n.available !== true) return unavailable;
  const { start, end } = n.stakingPeriod ?? {};
  const usable =
    typeof n.stakedTotal === "number" && Number.isFinite(n.stakedTotal) && n.stakedTotal > 0 &&
    typeof start === "string" && typeof end === "string" && dayOf(start) != null && Number.isFinite(Date.parse(end));
  return usable ? { available: true, stakedTotal: n.stakedTotal as number, stakingPeriod: { start: start as string, end: end as string } } : unavailable;
};

export type NetworkStakeTile =
  | { kind: "available"; amount: number; shareOfSupply: number | null; periodDay: string }
  | { kind: "unavailable" };

/** Tile numbers: the staked amount, its share of `supply.target` (null without a positive target) and the period's UTC start day. */
export const networkStakeTile = (stake: NetworkStake, supplyTarget: number | null | undefined): NetworkStakeTile => {
  if (!stake.available) return { kind: "unavailable" };
  const periodDay = dayOf(stake.stakingPeriod.start);
  if (periodDay == null) return { kind: "unavailable" };
  const shareOfSupply = typeof supplyTarget === "number" && Number.isFinite(supplyTarget) && supplyTarget > 0 ? stake.stakedTotal / supplyTarget : null;
  return { kind: "available", amount: stake.stakedTotal, shareOfSupply, periodDay };
};

export const NETWORK_STAKE_NOTE =
  "Staked coins stay in the holder's own account and are already counted in holder balances, so this number is not subtracted from anything.";
export const NETWORK_STAKE_UNAVAILABLE = "The network staking figure is unavailable right now.";

/**
 * A synthetic changelog event for the staked metric when the comparison's
 * start date falls in the unmeasured v3 window: rendered as the same "†"
 * explainer the other reclassified metrics use, instead of a delta that
 * would read the v3 migration as an inflow (or the legacy drain as an
 * outflow).
 */
export const v3StakingGapEvents = (
  baselineDate: string | number | null | undefined,
  baselineV3: number | null | undefined,
  deployDate: string = V3_STAKING_DEPLOY_DATE,
  /** Active project's ticker for the explainer; omitted → "The staked total". */
  ticker?: string,
): ClassificationEvent[] => {
  if (!dayOf(baselineDate)) return [];
  if (v3StakedOn(baselineDate, baselineV3, deployDate) !== null) return [];
  return [
    {
      id: "v3-staking-module-history",
      date: deployDate,
      type: "other",
      summary: `${ticker ? `Staked ${ticker}` : "The staked total"} now includes the v3 StakingModule, live since this date. Its balance wasn't recorded for this comparison's start date, so the change since then can't be computed.`,
      affects: { artifacts: ["holders-history.json"], metrics: ["stakingBalance"] },
      backfillStatus: "not-planned",
      backfillNote: "Archived snapshots predate the module's indexing; ranges that start before the deploy date compare normally.",
    },
  ];
};
