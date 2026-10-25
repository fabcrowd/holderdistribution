import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TokenSwitcher } from "./TokenSwitcher";

describe("TokenSwitcher", () => {
  it("header pill is the interactive switch with an accessible name", () => {
    const html = renderToStaticMarkup(<TokenSwitcher variant="pill" />);
    expect(html).toContain('data-testid="token-switcher"');
    expect(html).toContain(">TEL<");
    expect(html).toContain('aria-label="Token: Telcoin (TEL). Switch token"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toMatch(/rounded-full/);
  });
  it("heading variant is a plain ticker label at every breakpoint (no dropdown)", () => {
    const html = renderToStaticMarkup(<TokenSwitcher variant="heading" />);
    expect(html).toContain('data-testid="token-ticker-label"');
    expect(html).toContain(">TEL<");
    expect(html).not.toContain('data-testid="token-switcher"');
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/md:hidden|hidden md:/);
  });
  it("Navigation always shows the header pill (not hidden at any breakpoint)", () => {
    const src = readFileSync(resolve(__dirname, "Navigation.tsx"), "utf8");
    const m = src.match(/<TokenSwitcher variant="pill"[^>]*\/>/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/\b(sm|md|lg):hidden\b|\bhidden\b/);
  });
});
