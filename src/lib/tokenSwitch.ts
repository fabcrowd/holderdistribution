/**
 * Pure logic for the token switcher (src/components/TokenSwitcher.tsx):
 * filtering the token list, carrying the reader's view across a token change,
 * and wrapping the keyboard-active row.
 */
import { tokenPath } from "@/lib/tokenRoutes";
import { parseViewHash } from "@/lib/viewRoute";

export type SwitchOption = { slug: string; name: string; ticker: string; image?: string };

type ShortcutEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

const lower = (s: string): string => s.toLowerCase();

const matchesQuery = (option: SwitchOption, q: string): boolean =>
  lower(option.name).includes(q) || lower(option.ticker).includes(q) || lower(option.slug).includes(q);

/**
 * Case-insensitive substring match on name, ticker or slug. Ticker-prefix
 * matches come first; everything else keeps the original order.
 */
export const filterTokens = (options: readonly SwitchOption[], query: string): SwitchOption[] => {
  const q = lower(query.trim());
  if (q === "") return [...options];
  const matches = options.filter((o) => matchesQuery(o, q));
  const tickerPrefix = matches.filter((o) => lower(o.ticker).startsWith(q));
  const rest = matches.filter((o) => !lower(o.ticker).startsWith(q));
  return [...tickerPrefix, ...rest];
};

/**
 * Where a token switch lands: the token's page, keeping only a top-level view
 * hash. Sub-panel hashes collapse to their view; the query string is never
 * carried, since chain or range may not exist on the other token.
 */
export const switchTarget = (slug: string, hash: string): string => {
  const path = tokenPath(slug);
  if (hash.replace(/^#/, "").trim() === "") return path;
  const route = parseViewHash(hash);
  return route ? `${path}#${route.view}` : path;
};

/**
 * Ctrl+K or Cmd+K with no Shift or Alt. `key` is checked for presence because
 * key-less keydown events (autofill, IME) reach window listeners in practice.
 */
export const isSwitchShortcut = (e: ShortcutEvent): boolean =>
  (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && typeof e.key === "string" && e.key.toLowerCase() === "k";

/** Next active row index, wrapping at both ends. -1 when the list is empty. */
export const moveActive = (index: number, count: number, dir: 1 | -1): number => {
  if (count <= 0) return -1;
  return (((index + dir) % count) + count) % count;
};
