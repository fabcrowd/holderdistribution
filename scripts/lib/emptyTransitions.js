/**
 * The holder-transitions feed for a project with no snapshot in git history yet
 * (its first run: the commit step comes after the generators). The UI reads
 * `ranges?.[key] ?? null`, so no ranges is a valid feed; the next run, with one
 * committed snapshot behind it, builds the real windows.
 */
export const emptyTransitions = (now = new Date()) => ({ generatedAt: now.toISOString(), ranges: {} });
