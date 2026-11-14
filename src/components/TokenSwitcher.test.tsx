// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { TokenSwitcher } from "./TokenSwitcher";
import { __resetActiveSlug } from "@/lib/projectStore";
import { LISTED_PROJECTS, getProject } from "@/lib/projects";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LocationProbe = () => <p data-testid="location">{useLocation().pathname}</p>;

const mount = (initialPath: string) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <TokenSwitcher />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
};

const trigger = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-testid="token-switcher"]')!;
const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const options = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const locationText = (container: HTMLElement): string | null => container.querySelector('[data-testid="location"]')?.textContent ?? null;

const typeQuery = (value: string) => {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const pressKey = (el: EventTarget, key: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

beforeAll(() => {
  // Radix popper measures its content; jsdom has no ResizeObserver.
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let mounted: { container: HTMLElement; root: Root } | null = null;

beforeEach(() => {
  __resetActiveSlug("tel");
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe("TokenSwitcher", () => {
  it("renders the trigger with the current token name", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TokenSwitcher />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="token-switcher"');
    expect(html).toContain(`aria-label="Switch token, current: ${getProject("tel").name}"`);
    expect(html).toContain(">Telcoin<");
  });

  it("opening lists every listed project", () => {
    mounted = mount("/tel");
    act(() => trigger().click());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(options()).toHaveLength(LISTED_PROJECTS.length);
    for (const p of LISTED_PROJECTS) {
      expect(options().some((o) => o.textContent?.includes(getProject(p.slug).name))).toBe(true);
    }
  });

  it("typing a ticker filters the list", () => {
    mounted = mount("/tel");
    act(() => trigger().click());
    typeQuery("ondo");
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("Ondo");
  });

  it("Enter navigates to the other token's path", () => {
    mounted = mount("/tel");
    act(() => trigger().click());
    typeQuery("zebec");
    pressKey(input(), "Enter");
    expect(locationText(mounted.container)).toBe("/zebec-network");
  });

  it("Ctrl+K opens the switcher", () => {
    mounted = mount("/tel");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(options().length).toBeGreaterThan(0);
  });

  it("a key-less Ctrl keydown on window does not throw", () => {
    mounted = mount("/tel");
    expect(() => {
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, bubbles: true, cancelable: true }));
      });
    }).not.toThrow();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("Ctrl+Shift+K does not open the switcher", () => {
    mounted = mount("/tel");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "K", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("ArrowDown moves the active option via aria-activedescendant", () => {
    mounted = mount("/tel");
    act(() => trigger().click());
    const before = input().getAttribute("aria-activedescendant");
    expect(before).not.toBeNull();
    pressKey(input(), "ArrowDown");
    const after = input().getAttribute("aria-activedescendant");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("starts the active row on the current token when opened", () => {
    __resetActiveSlug("ondo");
    mounted = mount("/ondo");
    act(() => trigger().click());
    const ondoRow = options().find((o) => o.textContent?.includes("Ondo"));
    expect(ondoRow).toBeDefined();
    expect(input().getAttribute("aria-activedescendant")).toBe(ondoRow!.id);
  });
});
