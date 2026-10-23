import { useEffect, useRef, useState } from "react";
import { CHART_DRAW_MS, CHART_INTRO_WINDOW_MS, COUNT_UP_MS, countUpAt, introActive, prefersReducedMotion } from "@/lib/motion";

/** Whether this component should play its entrance animation. Fixed at mount. */
export const useIntro = (windowMs?: number): boolean => {
  const [play] = useState(() => introActive(windowMs));
  return play;
};

/**
 * `isAnimationActive` for a Recharts series: true only for a chart mounted
 * during the intro, and only until its draw-in finishes — later range / chain
 * changes update instantly instead of re-animating.
 */
export const useChartIntro = (): boolean => {
  const [active, setActive] = useState(() => introActive(CHART_INTRO_WINDOW_MS));
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => setActive(false), CHART_DRAW_MS + 150);
    return () => window.clearTimeout(t);
  }, [active]);
  return active;
};

/**
 * Counts from 0 to `target` once, the first time a finite target is seen while
 * the intro is active. Afterwards (and with reduced motion) it returns
 * `target` unchanged, so later data changes never re-count.
 */
export const useCountUp = (target: number | null, duration: number = COUNT_UP_MS): number | null => {
  const [play] = useState(() => duration > 0 && introActive(CHART_INTRO_WINDOW_MS));
  const done = useRef(!play);
  const [shown, setShown] = useState<number | null>(play ? 0 : target);

  useEffect(() => {
    if (target === null || !Number.isFinite(target)) {
      setShown(target);
      return;
    }
    if (done.current || prefersReducedMotion()) {
      done.current = true;
      setShown(target);
      return;
    }
    done.current = true;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const v = countUpAt(target, now - start, duration);
      setShown(v);
      if (v !== target) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setShown(target);
    };
  }, [target, duration]);

  return shown;
};
