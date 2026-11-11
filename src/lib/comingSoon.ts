import type { ProjectEntry } from "@/lib/projects";

export type ComingSoonToken = { name: string; ticker: string; image: string };

/** Tokens announced but not mapped yet; shown as placeholders after the live cards. */
export const COMING_SOON: readonly ComingSoonToken[] = [
  { name: "Cronos", ticker: "CRO", image: "/tokens/cro.png" },
  { name: "Monad", ticker: "MON", image: "/tokens/mon.png" },
  { name: "Plasma", ticker: "XPL", image: "/tokens/xpl.png" },
];

/** Placeholders for tokens that are not listed yet: a token drops off this list the day its own card goes live. */
export const comingSoonTokens = (
  listed: readonly Pick<ProjectEntry, "ticker">[],
  tokens: readonly ComingSoonToken[] = COMING_SOON,
): ComingSoonToken[] => {
  const live = new Set(listed.map((p) => p.ticker.toUpperCase()));
  return tokens.filter((t) => !live.has(t.ticker.toUpperCase()));
};
