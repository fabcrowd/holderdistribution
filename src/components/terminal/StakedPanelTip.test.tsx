import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { __resetActiveSlug } from "@/lib/projectStore";
import { StakedPanelTip } from "./StakedPanelTip";

afterEach(() => __resetActiveSlug("tel"));

describe("StakedPanelTip", () => {
  it("shows the ZBCN Super App disclaimer and Solscan proof links", () => {
    __resetActiveSlug("zebec-network");
    const html = renderToStaticMarkup(<StakedPanelTip />);
    expect(html).toContain('data-testid="staked-panel-tip"');
    expect(html).toContain("overflow-y-auto");
    expect(html).toMatch(/Global Staked/);
    expect(html).toMatch(/not current TVL/);
    expect(html).toMatch(/UserStakeData/);
    expect(html).toMatch(/4\.75B/);
    expect(html).toContain("https://solscan.io/account/zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv");
    expect(html).toContain('target="_blank"');
    expect(html).not.toMatch(/v3 StakingModule/);
    expect(html).not.toMatch(/Polygon/);
  });

  it("shows the TEL v3/Polygon tip and Polygonscan contracts, not the ZBCN disclaimer", () => {
    __resetActiveSlug("tel");
    const html = renderToStaticMarkup(<StakedPanelTip />);
    expect(html).toMatch(/v3 StakingModule/);
    expect(html).toMatch(/Polygon/);
    expect(html).toContain("https://polygonscan.com/address/0x573105be2148b8621f202a6d510016a2aa825731");
    expect(html).toContain("https://polygonscan.com/address/0x92e43aec69207755cb1e6a8dc589aae630476330");
    expect(html).not.toMatch(/Global Staked|Super App|Solscan|18\.9B/);
  });
});
