import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two projects so switching is observable; the real registry has only TEL.
vi.mock("@/lib/projects", async (orig) => {
  const real = await orig<typeof import("@/lib/projects")>();
  const known = ["tel", "abc"];
  return {
    ...real,
    isProjectSlug: (v: unknown) => typeof v === "string" && known.includes(v),
    resolveInitialSlug: (search: string, stored: string | null) => real.resolveInitialSlug(search, stored, known, "tel"),
  };
});

const fakeWindow = (search: string) => {
  const listeners: Record<string, () => void> = {};
  const win = {
    location: { pathname: "/", search, hash: "#holders" },
    history: {
      state: null,
      replaceState: vi.fn((_s: unknown, _u: string, url: string) => {
        const u = new URL(url, "https://x.test");
        win.location.search = u.search;
      }),
    },
    addEventListener: (type: string, fn: () => void) => {
      listeners[type] = fn;
    },
    listeners,
  };
  return win;
};

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

beforeEach(() => {
  vi.resetModules();
  store.clear();
  vi.stubGlobal("localStorage", fakeStorage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("active project store", () => {
  it("starts from ?token=, then localStorage, then the default", async () => {
    vi.stubGlobal("window", fakeWindow("?token=abc"));
    expect((await import("./projectStore")).getActiveSlug()).toBe("abc");

    vi.resetModules();
    store.set("ha:project", "abc");
    vi.stubGlobal("window", fakeWindow(""));
    expect((await import("./projectStore")).getActiveSlug()).toBe("abc");

    vi.resetModules();
    store.clear();
    vi.stubGlobal("window", fakeWindow("?token=../../etc"));
    expect((await import("./projectStore")).getActiveSlug()).toBe("tel");
  });

  it("switching writes the URL (replace, keeps hash) and localStorage, and notifies", async () => {
    const win = fakeWindow("?range=30");
    vi.stubGlobal("window", win);
    const s = await import("./projectStore");
    const seen: string[] = [];
    const off = s.subscribeActiveSlug(() => seen.push(s.getActiveSlug()));

    expect(s.setActiveSlug("abc")).toBe(true);
    expect(win.history.replaceState).toHaveBeenLastCalledWith(null, "", "/?range=30&token=abc#holders");
    expect(store.get("ha:project")).toBe("abc");

    expect(s.setActiveSlug("tel")).toBe(true);
    expect(win.history.replaceState).toHaveBeenLastCalledWith(null, "", "/?range=30#holders");
    expect(seen).toEqual(["abc", "tel"]);
    off();
  });

  it("ignores unknown slugs and no-op switches", async () => {
    vi.stubGlobal("window", fakeWindow(""));
    const s = await import("./projectStore");
    expect(s.setActiveSlug("nope")).toBe(false);
    expect(s.setActiveSlug("tel")).toBe(false);
    expect(s.getActiveSlug()).toBe("tel");
  });

  it("follows Back/Forward to a URL with a different ?token=", async () => {
    const win = fakeWindow("");
    vi.stubGlobal("window", win);
    const s = await import("./projectStore");
    win.location.search = "?token=abc";
    win.listeners.popstate();
    expect(s.getActiveSlug()).toBe("abc");
  });
});
