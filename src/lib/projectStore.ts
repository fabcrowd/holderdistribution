/**
 * The active project. A tiny external store rather than a React context so
 * every feed hook (and non-React helpers like lib/historyNav) can read it
 * without a provider. The URL path is the only source: `/<slug>` sets it at
 * load and TokenRoute (src/components/routing/TokenRoute.tsx) keeps it in sync
 * on navigation. Nothing is written to the URL or localStorage; legacy
 * `?token=` links are handled by lib/tokenRoutes legacyRedirect().
 */
import { DEFAULT_PROJECT_SLUG, isProjectSlug } from "@/lib/projects";
import { slugFromPath } from "@/lib/tokenRoutes";

type Listener = () => void;

const initial = (): string =>
  (typeof window !== "undefined" ? slugFromPath(window.location.pathname) : null) ?? DEFAULT_PROJECT_SLUG;

let current = initial();
const listeners = new Set<Listener>();

export const getActiveSlug = (): string => current;

export const subscribeActiveSlug = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Route sync. Ignores unknown slugs. Returns whether it changed. */
export const setActiveSlug = (slug: string): boolean => {
  if (!isProjectSlug(slug) || slug === current) return false;
  current = slug;
  listeners.forEach((fn) => fn());
  return true;
};

/** Test hook: reset to a given slug. */
export const __resetActiveSlug = (slug: string = DEFAULT_PROJECT_SLUG) => {
  current = slug;
  listeners.forEach((fn) => fn());
};
