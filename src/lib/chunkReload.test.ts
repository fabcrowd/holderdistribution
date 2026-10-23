import { describe, expect, it, vi } from "vitest";
import { CHUNK_RELOAD_KEY, isChunkLoadError, reloadOnceForChunkError } from "./chunkReload";

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("chunk-load recovery", () => {
  it("recognises the browsers' dynamic-import failures", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
  });
  it("reloads once, then gives up inside the window", () => {
    const store = memStore();
    const reload = vi.fn();
    const err = new TypeError("Failed to fetch dynamically imported module");
    expect(reloadOnceForChunkError(err, { store, reload, now: 1_000_000 })).toBe(true);
    expect(store.m.get(CHUNK_RELOAD_KEY)).toBe("1000000");
    expect(reloadOnceForChunkError(err, { store, reload, now: 1_030_000 })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnceForChunkError(err, { store, reload, now: 1_100_000 })).toBe(true);
  });
  it("ignores ordinary render errors", () => {
    const reload = vi.fn();
    expect(reloadOnceForChunkError(new Error("boom"), { store: memStore(), reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
