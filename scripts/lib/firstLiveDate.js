/**
 * holders-history.json `firstLiveDate`: the day of the project's first live holder snapshot, the floor of a
 * first flow scan (lib/solana/flowConfig.js flowFloor). A rebuild or backfill may add rows before that day and
 * replace rows on and after it, so the rows alone cannot tell it later; the field is the record. Three states:
 *   known    a YYYY-MM-DD string: never changes again.
 *   pending  no history file, no rows, or `firstLiveDate: null` (a rebuild wrote rows before any live row):
 *            the next live row written by generate-holders-history.js sets it.
 *   unknown  rows but no field (history written before the field existed): never guessed from the rows; the only
 *            way out is carryOverRecordedFlowFloor.
 */
import { recordedFlowFloor } from "./solana/flowConfig.js";

const isDay = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

/** "known" | "pending" | "unknown" (see the module comment). */
export function firstLiveDateState(history) {
  if (isDay(history?.firstLiveDate)) return "known";
  if ((history?.entries ?? []).length === 0) return "pending";
  if (Object.hasOwn(history, "firstLiveDate") && history.firstLiveDate === null) return "pending";
  return "unknown";
}

/**
 * Value the live generator writes: the known day; for a pending history the date of the live row this run
 * writes (`liveRowDate`, null when it writes none, which keeps it pending); undefined (write no field) when unknown.
 * Only the live row's own date counts: rows the same run adds from tel-holders-previous.json are not "first live".
 */
export function firstLiveDateOf(existingHistory, liveRowDate) {
  const state = firstLiveDateState(existingHistory);
  if (state === "known") return existingHistory.firstLiveDate;
  if (state === "pending") return isDay(liveRowDate) ? liveRowDate : null;
  return undefined;
}

/**
 * One-time carry-over for coins onboarded before `firstLiveDate` existed: an unknown history takes the floor its
 * flow scan recorded (exchange-flow-checkpoint.json over the project's Solana/Hedera flow chains, read with the
 * same rule as the scans: recordedFlowFloor, so an override run's floor is never copied, its defaultSince is). It
 * copies a recorded value, never guesses one; null when the history is not unknown or nothing is recorded. Once
 * written the field is known, so this applies at most once per project.
 */
export function carryOverRecordedFlowFloor(existingHistory, flowCheckpoint, flowChainKeys) {
  if (firstLiveDateState(existingHistory) !== "unknown") return null;
  return recordedFlowFloor(flowCheckpoint, flowChainKeys);
}

/** Top-level field generate-holders-history.js writes: `{ firstLiveDate: day | null }`, or {} when still unknown. */
export function generatorFirstLiveDate(existingHistory, liveRowDate, flowCheckpoint, flowChainKeys) {
  if (firstLiveDateState(existingHistory) === "unknown") {
    const carried = carryOverRecordedFlowFloor(existingHistory, flowCheckpoint, flowChainKeys);
    return carried ? { firstLiveDate: carried } : {};
  }
  return { firstLiveDate: firstLiveDateOf(existingHistory, liveRowDate) };
}

/**
 * Top-level field a rebuild/backfill writes over an existing history: the known day, `null` when the history was
 * pending (missing or empty file, or already null: rows now exist but no live row has), {} when unknown.
 */
export function keepFirstLiveDate(existingHistory) {
  const state = firstLiveDateState(existingHistory);
  if (state === "known") return { firstLiveDate: existingHistory.firstLiveDate };
  return state === "pending" ? { firstLiveDate: null } : {};
}
