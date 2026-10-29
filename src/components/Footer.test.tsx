import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Footer, SITE_DISCLAIMER, TIP_ADDRESS } from "./Footer";

describe("Footer", () => {
  const html = renderToStaticMarkup(<Footer />);

  it("shows the tip wallet on the copy control", () => {
    expect(TIP_ADDRESS).toBe("0x82C2Bca9d6a3ad4611eA5b8FAEAd789ad59a0542");
    expect(html).toContain(TIP_ADDRESS);
    expect(html).toContain("Copy donation address:");
    expect(html).not.toContain("0xce98fE636e83D36EA64cafEfF4020317B8B718EA");
  });

  it("states independence, no advice, no offer, and no warranty", () => {
    expect(html).toContain('data-testid="site-disclaimer"');
    expect(html).toContain(SITE_DISCLAIMER);
    expect(SITE_DISCLAIMER).toMatch(/independent on-chain analytics platform/i);
    expect(SITE_DISCLAIMER).toMatch(/not endorsed by, paid by, or affiliated with any cryptocurrency token or project/i);
    expect(SITE_DISCLAIMER).toMatch(/not financial, investment, legal, or tax advice/i);
    expect(SITE_DISCLAIMER).toMatch(/informational and educational only/i);
    expect(SITE_DISCLAIMER).toMatch(/not an offer or solicitation to buy or sell any security or token/i);
    expect(SITE_DISCLAIMER).toMatch(/without warranty of accuracy or completeness/i);
    expect(SITE_DISCLAIMER).toMatch(/incomplete or delayed/i);
    expect(SITE_DISCLAIMER).toMatch(/verify it on-chain/i);
  });
});
