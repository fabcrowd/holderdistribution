import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenSwitcher } from "./TokenSwitcher";

describe("TokenSwitcher", () => {
  it("shows the active project's ticker with an accessible name", () => {
    const html = renderToStaticMarkup(<TokenSwitcher variant="heading" />);
    expect(html).toContain('data-testid="token-switcher"');
    expect(html).toContain(">TEL<");
    expect(html).toContain('aria-label="Token: Telcoin (TEL). Switch token"');
    expect(html).toContain('aria-haspopup="dialog"');
  });
  it("heading variant hides its control on mobile, leaving a plain ticker label", () => {
    const html = renderToStaticMarkup(<TokenSwitcher variant="heading" />);
    expect(html).toMatch(/data-testid="token-ticker-label"[^>]*|class="text-primary md:hidden"/);
    expect(html).toContain("hidden md:inline-flex");
  });
  it("renders the compact pill for the mobile nav", () => {
    const html = renderToStaticMarkup(<TokenSwitcher variant="pill" />);
    expect(html).toMatch(/rounded-full/);
    expect(html).not.toContain("hidden md:inline-flex");
    expect(html).not.toContain("token-ticker-label");
  });
});
