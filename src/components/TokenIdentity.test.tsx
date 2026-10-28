import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { TokenIdentity } from "./TokenIdentity";

const render = (el: JSX.Element) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe("TokenIdentity", () => {
  it("shows the cached image and the token name, both inside one link home", () => {
    const html = render(<TokenIdentity />);
    expect(html).toContain('data-testid="token-identity"');
    expect(html).toContain('href="/"');
    expect(html).toContain('src="/tokens/tel.png"');
    expect(html).toContain(">Telcoin<");
    expect(html).not.toMatch(/coingecko/i);
    expect(html).not.toContain("<button");
  });
  it("large variant renders a bigger image", () => {
    expect(render(<TokenIdentity size="lg" />)).toContain('width="32"');
    expect(render(<TokenIdentity />)).toContain('width="24"');
  });
});
