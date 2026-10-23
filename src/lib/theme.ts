export type ThemePreference = "light" | "dark" | "system";
export const THEME_STORAGE_KEY = "ha-theme";

export const readThemePreference = (raw: string | null | undefined): ThemePreference =>
  raw === "light" || raw === "dark" ? raw : "system";

export const resolveTheme = (pref: ThemePreference, systemPrefersDark: boolean): "light" | "dark" =>
  pref === "system" ? (systemPrefersDark ? "dark" : "light") : pref;

/** light -> dark -> system -> light. "System" stays reachable from the toggle. */
export const nextThemePreference = (pref: ThemePreference): ThemePreference =>
  pref === "light" ? "dark" : pref === "dark" ? "system" : "light";
