/**
 * After a deploy, a tab still running the previous bundle asks for chunk
 * files that no longer exist (hashed names). /assets/* now 404s instead of
 * returning index.html, so the import rejects; reload once to pick up the new
 * index.html. A sessionStorage stamp stops a genuinely broken deploy from
 * looping: a second failure within the window shows the error page instead.
 */
export const CHUNK_RELOAD_KEY = "ha-chunk-reload-at";
const WINDOW_MS = 60_000;

const CHUNK_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /ChunkLoadError/i,
  /Loading chunk [\w-]+ failed/i,
  /Unable to preload CSS/i,
];

export const isChunkLoadError = (err: unknown): boolean => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : typeof err === "string" ? err : "";
  return CHUNK_PATTERNS.some((re) => re.test(msg));
};

type Store = Pick<Storage, "getItem" | "setItem">;

/** True when a reload was triggered (the caller should render nothing). */
export const reloadOnceForChunkError = (
  err: unknown,
  { store = safeSession(), reload = () => window.location.reload(), now = Date.now() }: { store?: Store | null; reload?: () => void; now?: number } = {},
): boolean => {
  if (!isChunkLoadError(err) || !store) return false;
  const last = Number(store.getItem(CHUNK_RELOAD_KEY) ?? 0);
  if (Number.isFinite(last) && now - last < WINDOW_MS) return false;
  try {
    store.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
};

const safeSession = (): Store | null => {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
};
