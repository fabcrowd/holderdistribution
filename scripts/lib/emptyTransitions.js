/**
 * The holder-transitions feed for a project with no snapshot in git history yet
 * (its first run: the commit step comes after the generators). The UI reads
 * `ranges?.[key] ?? null`, so no ranges is a valid feed; the next run, with one
 * committed snapshot behind it, builds the real windows. `asOf` is the on-disk
 * snapshot's stamp, so the first run's feeds align on one day (an unstamped
 * feed is dated by when it was written).
 */
export const emptyTransitions = (now = new Date(), asOf = null) => ({ generatedAt: now.toISOString(), ...(asOf ? { asOf } : {}), ranges: {} });
