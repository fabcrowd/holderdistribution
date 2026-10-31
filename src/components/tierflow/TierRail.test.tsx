import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TierRail, type TierRailProps } from "./TierRail";
import type { Cause, Migration } from "./useFlowField";
import type { RailField } from "./railSummary";

const cause: Cause = {
  dex: 4, dexSwap: 4, dexLp: 0, cex: 2, moved: 3, splitTel: 0, splitDestinationSlots: 0, splitEvents: 0, soloMoved: 3,
  total: 9, sold: 6, soldPct: 66, hasData: true,
  boughtDex: 5, boughtDexSwap: 5, boughtDexLp: 0, boughtCex: 1, receivedWallet: 2, inTotal: 8, hasInData: true,
  inflowsBySourceTier: {}, movedByDestTier: {},
};
const migrations: Migration[] = [
  { counterpart: "B", count: 4, up: true, gained: true },
  { counterpart: "B", count: 1, up: false, gained: false },
];
const field = (label: string, index: number, count: number, previousCount: number | null): RailField => ({
  label, index, cause, migrations, verdict: "sold", addedCount: 4, removedCount: 1,
  row: { label, count, totalBalance: 100, previousCount, previousTotalBalance: 90 },
});

const base: TierRailProps = {
  layout: "terminal",
  metric: "wallets",
  ticker: "TEL",
  fields: [field("A", 0, 12, 10), field("B", 1, 5, 9), field("C", 2, 7, null)],
  selectedField: null,
  sideTileLabel: null,
  outflowsAsOf: null,
  expandedFlow: null,
  onSelectTier: () => undefined,
  onToggleFlow: () => undefined,
  onHoverFlow: () => undefined,
  onClose: () => undefined,
};

const render = (over: Partial<TierRailProps> = {}) => renderToStaticMarkup(<TierRail {...base} {...over} />);

describe("TierRail", () => {
  it("renders the labelled detail landmark with a ranked tier list when nothing is selected", () => {
    const html = render();
    expect(html).toContain('data-testid="panel-tier-detail"');
    expect(html).toContain('aria-label="Tier detail"');
    expect(html).not.toContain('aria-label="Selected tier detail"');
    expect(html).toContain('data-selected="false"');
    expect(html).toContain("All retail tiers");
    expect(html).not.toContain('data-testid="tier-detail-close"');
    // Net = joined - left = +3 for every tier here: ties keep tier order, and no tier is hidden or daggered.
    expect(html.indexOf('data-rank-tier="A"')).toBeLessThan(html.indexOf('data-rank-tier="B"'));
    expect(html.indexOf('data-rank-tier="B"')).toBeLessThan(html.indexOf('data-rank-tier="C"'));
    expect(html).not.toContain("†");
  });

  it("shows net wallets as joined minus left and explains it", () => {
    const html = render({ selectedField: base.fields[0], period: { wallets: "from Jan 1 to Oct 30", tel: "over the selected period" } });
    expect(html).toContain("+3");
    expect(html).toContain("Net wallets");
    expect(html).toContain('aria-label="Selected tier detail"');
    expect(html).toContain('data-selected="true"');
    expect(html).not.toContain("since");
    expect(html).not.toContain("†");
  });

  it("is not a live region: the layout's one announcer owns that", () => {
    expect(render({ hint: "Pick a tier", selectedField: base.fields[0], hintHidden: true })).not.toContain("aria-live");
  });

  it("reads a dash, not 0, for a net whose feed is missing", () => {
    const html = render({ selectedField: base.fields[0], avail: { hasTransitions: false, hasOutflows: true } });
    expect(html).not.toContain("+3");
    const ranked = render({ avail: { hasTransitions: false, hasOutflows: true } });
    expect(ranked).toContain("—");
    expect(ranked).not.toMatch(/>0</);
  });

  it("shows key figures, flow rows with words, a verdict tag and top gross flows for a tier", () => {
    const html = render({ selectedField: base.fields[0] });
    expect(html).toContain("A tier");
    expect(html).toContain('data-testid="tier-detail-close"');
    expect(html).toContain("Arrived");
    expect(html).toContain("Left");
    expect(html).toContain("mostly Sell");
    expect(html).toContain('data-top-flow="B"');
    expect(html).not.toContain('data-testid="tier-rank-list"');
  });

  it("uses Buy, Sell and Redistribution rows in TEL mode", () => {
    const html = render({ metric: "tel", selectedField: base.fields[0] });
    for (const word of ["Buy", "Sell", "Redistribution"]) expect(html).toContain(word);
  });
});
