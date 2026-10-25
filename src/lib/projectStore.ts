/**
 * The active project (master token switch). A tiny external store rather than a
 * React context so every feed hook can read it without a provider and tests can
 * drive it directly. Writes go to the URL (?token=, replaceState) and
 * localStorage so a reload, a shared link and the next visit all agree.
 */
import {
  DEFAULT_PROJECT_SLUG,
  PROJECT_STORAGE_KEY,
  isProjectSlug,
  resolveInitialSlug,
  withToken,
} from "@/lib/projects";

type Listener = () => void;

const readStored = (): string | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(PROJECT_STORAGE_KEY) : null;
  } catch {
    return null;
  }
};

const initial = (): string =>
  typeof window !== "undefined" ? resolveInitialSlug(window.location.search, readStored()) : DEFAULT_PROJECT_SLUG;

let current = initial();
const listeners = new Set<Listener>();

export const getActiveSlug = (): string => current;

export const subscribeActiveSlug = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Switches the active project. Ignores unknown slugs. Returns whether it changed. */
export const setActiveSlug = (slug: string): boolean => {
  if (!isProjectSlug(slug) || slug === current) return false;
  current = slug;
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, slug);
  } catch {
    /* private mode: the URL still carries it */
  }
  if (typeof window !== "undefined") {
    const url = withToken(window.location, slug);
    if (url) window.history.replaceState(window.history.state, "", url);
  }
  listeners.forEach((fn) => fn());
  return true;
};

/** Test hook: reset to a given slug without touching URL/storage. */
export const __resetActiveSlug = (slug: string = DEFAULT_PROJECT_SLUG) => {
  current = slug;
  listeners.forEach((fn) => fn());
};

// Back/forward or a pasted ?token= link on the same page.
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    const next = resolveInitialSlug(window.location.search, current);
    if (next !== current) {
      current = next;
      listeners.forEach((fn) => fn());
    }
  });
}
