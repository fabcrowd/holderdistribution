/**
 * Local unlock for gated Supply forensics content.
 *
 * The password is checked server-side (Netlify Function + FORENSICS_PASSWORD).
 * We only persist the typed password in localStorage so repeat visits can skip
 * re-entry — never a hash, and never validated offline.
 */
import { verifyForensicsPassword } from "@/lib/forensicsGateApi";

export const LOCAL_UNLOCK_STORAGE_KEY = "supply-forensics-password";

const UNLOCK_EMAIL = "fabcrowd@gmail.com";

export const emailMatches = (email: string): boolean =>
  email.trim().toLowerCase() === UNLOCK_EMAIL;

export const credentialsMatch = async (email: string, password: string): Promise<boolean> => {
  if (!emailMatches(email) || !password) return false;
  return verifyForensicsPassword(password);
};

export const persistLocalUnlock = (password: string): boolean => {
  if (!password) return false;
  try {
    localStorage.setItem(LOCAL_UNLOCK_STORAGE_KEY, password);
    return true;
  } catch {
    return false;
  }
};

export const readLocalUnlock = (): string | null => {
  try {
    return localStorage.getItem(LOCAL_UNLOCK_STORAGE_KEY);
  } catch {
    return null;
  }
};

/** Returns stored password; server validates on the next forensics fetch. */
export const readValidLocalUnlock = (): string | null => readLocalUnlock();

export const clearLocalUnlock = (): void => {
  try {
    localStorage.removeItem(LOCAL_UNLOCK_STORAGE_KEY);
  } catch {
    // ignore
  }
};
