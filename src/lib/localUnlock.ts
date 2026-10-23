/**
 * Remembered unlock for gated Supply forensics content.
 *
 * The password is checked server-side; on success the gate returns a signed,
 * short-lived (~12h) session token. Only that token is remembered, in
 * sessionStorage (this tab only, gone when it closes). The password itself is
 * never stored. Older builds kept the plaintext password in localStorage under
 * LEGACY_UNLOCK_STORAGE_KEY; purgeLegacyUnlock() deletes it on load.
 */
import { isGateToken, verifyForensicsPassword } from "@/lib/forensicsGateApi";

export const LEGACY_UNLOCK_STORAGE_KEY = "supply-forensics-password";
export const SESSION_UNLOCK_STORAGE_KEY = "supply-forensics-session";

const UNLOCK_EMAIL = "fabcrowd@gmail.com";

export const emailMatches = (email: string): boolean =>
  email.trim().toLowerCase() === UNLOCK_EMAIL;

export const credentialsMatch = async (email: string, password: string): Promise<boolean> => {
  if (!emailMatches(email) || !password) return false;
  return verifyForensicsPassword(password);
};

const storage = (): Storage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

export const purgeLegacyUnlock = (): void => {
  try {
    localStorage.removeItem(LEGACY_UNLOCK_STORAGE_KEY);
  } catch {
    // ignore
  }
};

/** Remember a gate token until it expires. Refuses anything that isn't a token. */
export const persistSessionToken = (token: string, expiresAt: number | null): boolean => {
  if (!isGateToken(token)) return false;
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(SESSION_UNLOCK_STORAGE_KEY, JSON.stringify({ token, expiresAt }));
    return true;
  } catch {
    return false;
  }
};

/** The remembered token, or null when absent, malformed or expired. */
export const readSessionToken = (now: number = Date.now()): string | null => {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(SESSION_UNLOCK_STORAGE_KEY);
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
    if (!isGateToken(token as string)) return null;
    if (typeof expiresAt === "number" && expiresAt <= now) {
      s.removeItem(SESSION_UNLOCK_STORAGE_KEY);
      return null;
    }
    return token as string;
  } catch {
    return null;
  }
};

export const clearSessionToken = (): void => {
  try {
    storage()?.removeItem(SESSION_UNLOCK_STORAGE_KEY);
  } catch {
    // ignore
  }
};

/** Forget every remembered unlock (token and any legacy stored password). */
export const clearLocalUnlock = (): void => {
  clearSessionToken();
  purgeLegacyUnlock();
};
