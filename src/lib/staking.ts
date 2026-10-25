import type { ClassificationEvent } from "@/lib/classificationChangelog";

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
