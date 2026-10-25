import { useSyncExternalStore } from "react";

/** Live `matchMedia` result. SSR/test-safe: false when matchMedia is absent. */
export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );

/** The desktop terminal shell starts at Tailwind's `xl` (1280px). */
export const TERMINAL_QUERY = "(min-width: 1280px)";

/** Below Tailwind's `sm` — phones, where dense diagrams switch to lists. */
export const PHONE_QUERY = "(max-width: 639px)";
