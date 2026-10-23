/**
 * Entrance-motion policy, kept framework-free so it can be unit-tested.
 *
 * - Motion plays only during a short "intro window" that starts the first time
 *   anything asks (the terminal header mounts first). Components that mount
 *   later — a view switch, a selection, a refetch — render without entrance
 *   motion, so nothing replays.
 * - prefers-reduced-motion: reduce turns every effect off (no intro, count-ups
 *   jump straight to the final value, charts don't draw in).
 * - Budgets: panel stagger is 40ms x at most 6 steps + 320ms, so the last panel
 *   is fully visible by ~560ms; count-ups take 500ms.
 */

export const INTRO_WINDOW_MS = 900;
/** Charts often mount when their data arrives; allow draw-in a bit later. */
export const CHART_INTRO_WINDOW_MS = 2500;
export const COUNT_UP_MS = 500;
export const CHART_DRAW_MS = 450;

type MatchMedia = ((q: string) => { matches: boolean }) | undefined;

export const prefersReducedMotion = (
  matchMedia: MatchMedia = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia.bind(window)
    : undefined,
): boolean => !!matchMedia?.("(prefers-reduced-motion: reduce)").matches;

let introStart: number | null = null;

/**
 * True when an entrance animation may play for a component mounting now.
 * The first call opens the intro window.
 */
export const introActive = (
  windowMs: number = INTRO_WINDOW_MS,
  now: number = Date.now(),
  reduced: boolean = prefersReducedMotion(),
): boolean => {
  if (reduced) return false;
  if (introStart === null) introStart = now;
  return now - introStart < windowMs;
};

/** Test hook: forget that the intro already started. */
export const resetIntro = () => {
  introStart = null;
};

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3);

/** Value shown `elapsed` ms into a count-up from 0 to `target`. */
export const countUpAt = (target: number, elapsed: number, duration: number = COUNT_UP_MS): number => {
  if (!Number.isFinite(target) || duration <= 0 || elapsed >= duration) return target;
  return target * easeOutCubic(elapsed / duration);
};
