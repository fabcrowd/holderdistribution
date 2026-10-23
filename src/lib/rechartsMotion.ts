import { Area, Bar, Line, Pie, Scatter } from "recharts";
import { prefersReducedMotion } from "./motion";

/**
 * Recharts animates every series by default. The terminal charts pass
 * isAnimationActive explicitly (useChartIntro already honours reduced
 * motion); the stacked-layout charts rely on the default. Flip that default
 * from the reader's prefers-reduced-motion setting, and keep it in sync if
 * they change it while the page is open. Side-effect module: chart files
 * import it next to recharts, so it lands in the same chunk.
 */
type WithDefaults = { defaultProps?: { isAnimationActive?: boolean } };
const SERIES = [Area, Bar, Line, Pie, Scatter] as unknown as WithDefaults[];

export const setRechartsAnimation = (enabled: boolean) => {
  for (const c of SERIES) {
    if (c.defaultProps) c.defaultProps.isAnimationActive = enabled;
  }
};

if (typeof window !== "undefined") {
  setRechartsAnimation(!prefersReducedMotion());
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  mq?.addEventListener?.("change", (e) => setRechartsAnimation(!e.matches));
}
