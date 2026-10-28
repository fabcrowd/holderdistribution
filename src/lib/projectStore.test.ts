import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeWindow = (pathname: string, search = "") => ({
  location: { pathname, search, hash: "" },
  history: { state: null, replaceState: vi.fn(), pushState: vi.fn() },
  addEventListener: vi.fn(),
});

const setItem = vi.fn();
beforeEach(() => {
  vi.resetModules();
  setItem.mockClear();
  vi.stubGlobal("localStorage", { getItem: () => "zebec-network", setItem });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("active project store (route-driven)", () => {
  it("starts from the /<slug> path, ignoring ?token= and localStorage", async () => {
    vi.stubGlobal("window", fakeWindow("/zebec-network"));
    expect((await import("./projectStore")).getActiveSlug()).toBe("zebec-network");

    vi.resetModules();
    vi.stubGlobal("window", fakeWindow("/", "?token=zebec-network"));
    expect((await import("./projectStore")).getActiveSlug()).toBe("tel");

    vi.resetModules();
    vi.stubGlobal("window", fakeWindow("/not-a-token"));
    expect((await import("./projectStore")).getActiveSlug()).toBe("tel");
  });

  it("setActiveSlug notifies without touching the URL or localStorage", async () => {
    const win = fakeWindow("/tel");
    vi.stubGlobal("window", win);
    const s = await import("./projectStore");
    const seen: string[] = [];
    const off = s.subscribeActiveSlug(() => seen.push(s.getActiveSlug()));
    expect(s.setActiveSlug("zebec-network")).toBe(true);
    expect(s.setActiveSlug("tel")).toBe(true);
    expect(seen).toEqual(["zebec-network", "tel"]);
    expect(win.history.replaceState).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    off();
  });

  it("ignores unknown slugs and no-op switches", async () => {
    vi.stubGlobal("window", fakeWindow("/tel"));
    const s = await import("./projectStore");
    expect(s.setActiveSlug("nope")).toBe(false);
    expect(s.setActiveSlug("tel")).toBe(false);
    expect(s.getActiveSlug()).toBe("tel");
  });
});
