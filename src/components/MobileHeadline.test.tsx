import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Users } from "lucide-react";
import type { EcosystemHeadlineTile, EcosystemHeadlineTileId } from "@/hooks/useEcosystemHeadlineTiles";

const tile = (id: EcosystemHeadlineTileId): EcosystemHeadlineTile => ({
  id,
  icon: Users,
  label: id === "staked" ? "Staked" : `Label ${id}`,
  value: `V-${id}`,
  sub: `Sub ${id}`,
  ath: false,
  current: 10,
  previous: 8,
  fmt: undefined,
  scope: "chain",
});

const state = vi.hoisted(() => ({ tiles: [] as EcosystemHeadlineTile[] }));
vi.mock("@/hooks/useHeadlineSummary", () => ({
  useHeadlineSummary: () => ({ tiles: state.tiles, isError: false, summary: null, snapshot: undefined }),
}));

import { MobileHeadline } from "./MobileHeadline";

describe("MobileHeadline", () => {
  it("shows the three answer cards and puts staked in the Details accordion", () => {
    state.tiles = [tile("holders"), tile("retailHeld"), tile("staked"), tile("cex")];
    const html = renderToStaticMarkup(<MobileHeadline rangeDays={30} selectedView="combined" />);
    expect(html.match(/data-testid="answer-(holders|retailHeld|staked|cex)"/g)).toHaveLength(3);
    expect(html).toContain('data-testid="mobile-details"');
    expect(html).toContain("Details: Staked");
    expect(html).not.toContain("answer-staked");
  });
  it("omits the accordion when the project has no extra tiles", () => {
    state.tiles = [tile("holders"), tile("retailHeld"), tile("cex")];
    const html = renderToStaticMarkup(<MobileHeadline rangeDays={30} selectedView="combined" />);
    expect(html).not.toContain("mobile-details");
  });
  it("stacks the cards on a phone and goes three-across from sm", () => {
    state.tiles = [tile("holders")];
    expect(renderToStaticMarkup(<MobileHeadline rangeDays={30} selectedView="combined" />)).toContain("grid-cols-1");
  });
});
