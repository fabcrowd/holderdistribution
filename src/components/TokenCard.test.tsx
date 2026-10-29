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
