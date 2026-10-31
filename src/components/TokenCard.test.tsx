import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TokenCard } from "./TokenCard";

const render = (stats: { holders: string; retailShare: string } | null) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <TokenCard slug="zebec-network" name="Zebec Network" ticker="ZBCN" image="/tokens/zebec-network.jpg" stats={stats} />
    </MemoryRouter>,
  );

describe("TokenCard", () => {
  it("is one link to /<slug> with image, name, ticker and both stats", () => {
    const html = render({ holders: "111,469", retailShare: "38.6%" });
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="/zebec-network"');
    expect(html).toContain('src="/tokens/zebec-network.jpg"');
    expect(html).toContain(">Zebec Network<");
    expect(html).toContain(">ZBCN<");
    expect(html).toContain(">111,469<");
    expect(html).toContain(">38.6%<");
    expect(html).toContain("Unique wallets");
    expect(html).toContain("Retail share of supply");
  });
  it("still renders and links when stats are dashes", () => {
    const html = render({ holders: "—", retailShare: "—" });
    expect(html).toContain('href="/zebec-network"');
    expect(html.match(/>—</g)).toHaveLength(2);
  });
  it("shows a loading placeholder while stats are pending", () => {
    expect(render(null)).toContain('data-loading="true"');
  });
});

describe("TokenCard summary", () => {
  const stats = { holders: "1", retailShare: "2%" };
  const trend = {
    points: [{ t: 0, v: 1 }, { t: 86_400_000, v: 3 }],
    first: { t: 0, v: 1 },
    last: { t: 86_400_000, v: 3 },
    spanDays: 1,
  };
  const html = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <TokenCard slug="a" name="A" ticker="A" stats={stats} {...props} />
      </MemoryRouter>,
    );
  it("shows concentration and a labelled sparkline", () => {
    const out = html({ concentration: { top10: "12.0%", top100: "34.5%" }, trend });
    expect(out).toContain(">12.0%<");
    expect(out).toContain(">34.5%<");
    expect(out).toContain('role="img"');
    expect(out).toContain("aria-label=\"A retail wallets,");
  });
  it("shows a same-size placeholder when the trend is missing", () => {
    const out = html({ concentration: { top10: "—", top100: "—" }, trend: null });
    expect(out).toContain("card-sparkline-empty");
    expect(out).not.toContain('role="img"');
    expect(out).toContain("Holder trend appears once 2+ days of history exist.");
  });
  it("shows the trend note instead of the 2+ days message when history was cut by a break", () => {
    const out = html({ trend: null, trendNote: "Not enough data since the Oct 3 methodology change." });
    expect(out).toContain("Not enough data since the Oct 3 methodology change.");
    expect(out).not.toContain("2+ days");
    expect(out).toContain("card-sparkline-empty");
  });
  it("ignores the trend note when a trend is shown", () => {
    const out = html({ trend, trendNote: "Not enough data since the Oct 3 methodology change." });
    expect(out).not.toContain("Not enough data");
    expect(out).toContain('role="img"');
  });
  it("labels the footer with the days span when there is no break", () => {
    const out = html({ trend });
    expect(out).toContain("1 day · retail wallets");
    expect(out).not.toContain("since ");
  });
  it("labels the footer 'since <date>' and shows the post-break delta when a break is set", () => {
    const out = html({ trend: { ...trend, sinceBreak: Date.parse("2026-10-03T00:00:00Z") } });
    expect(out).toContain("since Oct 3 · retail wallets");
    expect(out).not.toContain("1 day · retail wallets");
    expect(out).toContain("+2");
  });
});
