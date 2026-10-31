import type { TierField } from "./useFlowField";
import { signed, fmtInt, fmtTel } from "./format";

/**
 * Single source of truth for every NET number in the Distribution tier-flow
 * view (owner decision 2026-10-31): net = what came in minus what went out
 * over the period, never the snapshot delta. The TEL total across tiers is the sum
 * of the per-tier nets; a wallet total is deliberately absent (always 0: every crossing leaves one tier and joins another). The Tiers table "Change" columns stay snapshot-based.
 */
export type NetField = Pick<TierField, "addedCount" | "removedCount" | "cause">;

/** Wallets that joined the tier minus wallets that left it. */
export const netWalletsOf = (f: Pick<NetField, "addedCount" | "removedCount">): number => f.addedCount - f.removedCount;

/** TEL that flowed into the tier minus TEL that flowed out of it. */
export const netTelOf = (f: Pick<NetField, "cause">): number => f.cause.inTotal - f.cause.total;

export const totalNetTel = (fields: readonly NetField[]): number => fields.reduce((s, f) => s + netTelOf(f), 0);

export type NetSlot = { text: string; tone: "positive" | "negative" | "neutral" };

/** Which feed behind each net exists: wallets need holder-transitions, TEL needs tier-outflows. */
export type FlowAvailability = { hasTransitions: boolean; hasOutflows: boolean };
export const ALL_FLOWS_AVAILABLE: FlowAvailability = { hasTransitions: true, hasOutflows: true };

/** Shown instead of a number when the metric's feed has no data (a real 0 is a different statement). */
export const NET_MISSING = "—";

/** The metric's net, or null when its feed is missing. */
export const netOf = (metric: "wallets" | "tel", f: NetField, avail: FlowAvailability = ALL_FLOWS_AVAILABLE): number | null => {
  if (metric === "wallets") return avail.hasTransitions ? netWalletsOf(f) : null;
  return avail.hasOutflows ? netTelOf(f) : null;
};

/** Neutral "—" for null; otherwise signed, with zero (after display rounding) a neutral "0". */
export const netDisplay = (v: number | null, fmt: (n: number) => string): NetSlot => {
  if (v === null) return { text: NET_MISSING, tone: "neutral" };
  const text = signed(v, fmt);
  return { text, tone: text === "0" ? "neutral" : v > 0 ? "positive" : "negative" };
};

/** The signed net figure shown inside a selected tile; zero reads "0" and a missing feed "—", both neutral. */
export const netSlotText = (metric: "wallets" | "tel", f: NetField, avail: FlowAvailability = ALL_FLOWS_AVAILABLE): NetSlot =>
  netDisplay(netOf(metric, f, avail), metric === "wallets" ? fmtInt : fmtTel);
