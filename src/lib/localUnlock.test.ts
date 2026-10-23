import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_UNLOCK_STORAGE_KEY,
  SESSION_UNLOCK_STORAGE_KEY,
  clearLocalUnlock,
  persistSessionToken,
  purgeLegacyUnlock,
  readSessionToken,
} from "./localUnlock";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
  (globalThis as unknown as { sessionStorage: MemStorage }).sessionStorage = new MemStorage();
});

describe("localUnlock", () => {
  it("never stores a password, only gate tokens, in sessionStorage", () => {
    expect(persistSessionToken("hunter2", Date.now() + 1000)).toBe(false);
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
    expect(persistSessionToken("hdg1.abc.def", Date.now() + 1000)).toBe(true);
    expect(readSessionToken()).toBe("hdg1.abc.def");
    expect(localStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
  });

  it("drops an expired token", () => {
    persistSessionToken("hdg1.abc.def", 1000);
    expect(readSessionToken(2000)).toBeNull();
    expect(sessionStorage.getItem(SESSION_UNLOCK_STORAGE_KEY)).toBeNull();
  });

  it("purges the legacy plaintext password key", () => {
    localStorage.setItem(LEGACY_UNLOCK_STORAGE_KEY, "old-password");
    purgeLegacyUnlock();
    expect(localStorage.getItem(LEGACY_UNLOCK_STORAGE_KEY)).toBeNull();
    localStorage.setItem(LEGACY_UNLOCK_STORAGE_KEY, "old-password");
    persistSessionToken("hdg1.a.b", null);
    clearLocalUnlock();
    expect(localStorage.getItem(LEGACY_UNLOCK_STORAGE_KEY)).toBeNull();
    expect(readSessionToken()).toBeNull();
  });
});
