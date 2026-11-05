const DAY_MS = 86_400_000;
/** A day or two of lag (nightly snapshot timing) is not "history starts late". */
const SLACK_DAYS = 2;

/**
 * The first data timestamp when a project's history begins after the start of
 * the selected range (e.g. a newly onboarded token tracked only from its
 * onboarding day), else null.
 */
export function historyStartsAfterRange(
  firstTimestamp: number | undefined,
  rangeDays: number,
  now: number = Date.now(),
): number | null {
  if (!Number.isFinite(firstTimestamp) || !(rangeDays > 0)) return null;
  const rangeStart = now - rangeDays * DAY_MS;
  return (firstTimestamp as number) - rangeStart > SLACK_DAYS * DAY_MS ? (firstTimestamp as number) : null;
}
