import { useCallback, useEffect, useState } from "react";
import {
  nextThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";
import { useMediaQuery } from "@/hooks/useMediaQuery";

const readStored = (): ThemePreference => {
  try {
    return readThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
};

/** Theme preference persisted in localStorage, applied as `.dark` on <html>. */
export const useTheme = () => {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    typeof window === "undefined" ? "system" : readStored(),
  );
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolved = resolveTheme(preference, systemDark);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", resolved === "dark" ? "#0b1314" : "#017276");
  }, [resolved]);

  const cycle = useCallback(() => {
    setPreference((p) => {
      const next = nextThemePreference(p);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        /* private mode: the choice just won't persist */
      }
      return next;
    });
  }, []);

  return { preference, resolved, cycle };
};
