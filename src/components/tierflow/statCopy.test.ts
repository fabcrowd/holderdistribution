import { describe, expect, it } from "vitest";
import { buySellTip, dexTip, netTelTip, tierPrompt } from "./statCopy";

const fmt = (n: number) => `${n}`;

describe("netTelTip", () => {
  const tip = netTelTip({ ticker: "TEL", period: "over the selected period", gross: { dex: 6, cex: 5, moved: 4 }, scope: null, fmt });
  it("states in minus out and the window", () => {
    expect(tip).toContain("TEL in minus TEL out over the selected period");
    expect(tip).not.toContain("since");
  });
  it("carries the gross-out breakdown with the numbers", () => {
    expect(tip).toContain("Of the TEL that left retail tiers: 6 sold on DEX, 5 to exchanges, 4 moved to other wallets");
    expect(tip).toContain("gross figures, not the net above");
  });
  it("scopes the breakdown to a tier", () => {
    const t = netTelTip({ ticker: "TEL", period: "x", gross: { dex: 1, cex: 2, moved: 3 }, scope: "25M-50M", fmt });
    expect(t).toContain("Of the TEL that left the 25M-50M tier: 1 sold on DEX");
  });
});

describe("buySellTip", () => {
  it("words the sign", () => {
    expect(buySellTip({ bought: 5, sold: 2, net: 3 }, fmt)).toContain("More buy than sell pressure, excluding wallet-to-wallet moves.");
    expect(buySellTip({ bought: 2, sold: 5, net: -3 }, fmt)).toContain("More sell than buy pressure, excluding wallet-to-wallet moves.");
  });
  it("includes the bought and sold figures", () => {
    const t = buySellTip({ bought: 5, sold: 2, net: 3 }, fmt);
    expect(t).toContain("5");
    expect(t).toContain("2");
  });
  it("handles missing data", () => {
    expect(buySellTip(null, fmt)).toBe("No DEX/exchange activity recorded yet.");
  });
});

describe("dexTip", () => {
  it("differs for a tier and the whole market", () => {
    expect(dexTip(true)).toBe("This tier's DEX swaps - same figures as Bought on DEX / Sold on DEX beside the chart.");
    expect(dexTip(false)).toContain("All wallets");
  });
});

describe("tierPrompt", () => {
  it("names the subject", () => {
    expect(tierPrompt("wallets", "TEL")).toBe("Click a tier to see where its wallets came from and went.");
    expect(tierPrompt("tel", "TEL")).toBe("Click a tier to see where its TEL came from and went.");
    expect(tierPrompt("wallets", "TEL", "Tap")).toBe("Tap a tier to see where its wallets came from and went.");
  });
});
