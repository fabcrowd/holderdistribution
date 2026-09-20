import { useEffect, useRef, useState } from "react";

/**
 * True once `targetRef`'s element has fully scrolled behind a sticky element
 * whose live height is tracked via `stickyRef` — i.e. once no part of the
 * target remains visible below the sticky element's bottom edge.
 *
 * Deliberately NOT a hardcoded scroll-distance threshold: the sticky bar's
 * rendered height varies slightly by breakpoint (padding, tab label sizing),
 * and a guessed pixel offset would trigger a few pixels early or late,
 * exactly the "arbitrary scroll-distance guess" this hook exists to avoid.
 * A ResizeObserver keeps the IntersectionObserver's rootMargin correct
 * across breakpoint/content changes, and the IntersectionObserver itself —
 * not a scroll listener — reports the actual geometric relationship between
 * the two elements.
 *
 * `stickyOffset` is the sticky element's own CSS `top` (its offset from the
 * viewport, e.g. Tailwind's `top-16`/`md:top-20`) plus its live height —
 * i.e. the pixel position of the sticky element's bottom edge once it is
 * stuck. Reading `top` via getComputedStyle rather than hardcoding the
 * Tailwind value keeps this correct if that offset ever changes, and is
 * also what the target's own bottom edge must clear, so it is used for
 * BOTH the IntersectionObserver's rootMargin and returned for callers that
 * need to position something flush under the sticky element themselves
 * (e.g. a second sticky element pinned just below it).
 */
export const useScrolledPastElement = (
  targetRef: React.RefObject<HTMLElement>,
  stickyRef: React.RefObject<HTMLElement>,
) => {
  const [scrolledPast, setScrolledPast] = useState(false);
  const [stickyOffset, setStickyOffset] = useState(0);

  useEffect(() => {
    const stickyEl = stickyRef.current;
    if (!stickyEl || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const top = parseFloat(getComputedStyle(stickyEl).top) || 0;
      setStickyOffset(top + stickyEl.getBoundingClientRect().height);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stickyEl);
    // getComputedStyle(stickyEl).top can change at a breakpoint (e.g.
    // top-16 -> md:top-20) without the element's own size changing, so a
    // window resize listener catches that case too.
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [stickyRef]);

  useEffect(() => {
    const targetEl = targetRef.current;
    if (!targetEl || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolledPast(!entry.isIntersecting),
      { rootMargin: `-${Math.ceil(stickyOffset)}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(targetEl);
    return () => observer.disconnect();
  }, [targetRef, stickyOffset]);

  return { scrolledPast, stickyOffset };
};
