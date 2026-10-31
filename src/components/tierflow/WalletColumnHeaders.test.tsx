import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WalletColumnHeaders } from "./WalletColumnHeaders";

const anchors = { joined: 10, wallets: 200, left: 400 };
const render = (netMode: boolean) =>
  renderToStaticMarkup(
    <WalletColumnHeaders period="from Oct 1 to Oct 30" ticker="TEL" anchors={anchors} scale={1} originX={0} netMode={netMode} netAnchor={180} />,
  );

describe("WalletColumnHeaders selection fade", () => {
  it("shows Joined / Left and hides Net when idle", () => {
    const html = render(false);
    expect(html).toMatch(/data-testid="wallet-column-joined"[^>]*class="[^"]*opacity-100/);
    expect(html).toMatch(/data-testid="wallet-column-net"[^>]*class="[^"]*opacity-0 invisible/);
  });
  it("fades Joined / Left out (aria-hidden, no pointer events) and Net in when selected", () => {
    const html = render(true);
    expect(html).toMatch(/aria-hidden="true" data-testid="wallet-column-left"[^>]*class="[^"]*opacity-0 invisible pointer-events-none/);
    expect(html).toMatch(/data-testid="wallet-column-net"[^>]*class="[^"]*opacity-100 visible/);
    expect(html).toContain("motion-reduce:transition-none");
  });
});
