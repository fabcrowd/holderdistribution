import { describe, it, expect } from "vitest";
import { holderTiersFor, defaultHolderTiers, bucketFloor, dustFloorText, normalizeHolderTiers } from "@/lib/holderTiers";
import { getProject, projectChainMeta } from "@/lib/projects";
import { TIERS, CANVAS_H, canvasHeight, sideTop } from "@/components/tierflow/geometry";
import { tierGeometryFor } from "@/components/tierflow/useTierGeometry";
import { logMidFor } from "@/components/WalletHoldingsWidget";
import { EXPLORER_BASE, v3TokenUrl } from "@/lib/telContracts";

const OLD_BALANCE_LABELS = ["1–100", "100–1K", "1K–10K", "10K–100K", "100K–1M", "1M–10M", "10M+"];

describe("UI holder tiers: TEL unchanged", () => {
  const tel = holderTiersFor(getProject("tel"));

  it("TEL's distribution tiers are exactly the tier-flow diagram's historical TIERS", () => {
    expect(tel.distributionTiers.map((t) => t.label)).toEqual([...TIERS]);
    expect(tel.distributionTiers[0]!.max).toBe(Number.POSITIVE_INFINITY);
  });

  it("TEL's balance ranges / floor match the old holderInsights constants", () => {
    expect(tel.balanceRanges.map((r) => r.label)).toEqual(OLD_BALANCE_LABELS);
    expect(bucketFloor(tel)).toBe(1);
    expect(tel).toEqual(defaultHolderTiers());
  });

  it("TEL's canvas geometry is the old 682px layout", () => {
    const g = tierGeometryFor(tel.distributionTiers.map((t) => t.label));
    expect(CANVAS_H).toBe(682);
    expect(g.canvasH).toBe(682);
    for (let j = 0; j < 4; j += 1) expect(g.sideTop(j)).toBe(sideTop(j));
    expect(g.tierIndex("1-250K")).toBe(9);
  });

  it("TEL's chain status meta equals the old hard-coded Ethereum/Polygon/Base entries", () => {
    expect(projectChainMeta(getProject("tel"))).toEqual(
      (["ethereum", "polygon", "base"] as const).map((key) => ({
        key,
        label: { ethereum: "Ethereum", polygon: "Polygon", base: "Base" }[key],
        explorerUrl: EXPLORER_BASE[key],
        tokenUrl: v3TokenUrl(key),
      })),
    );
  });
});

describe("UI holder tiers: another project", () => {
  it("uses the project's own tiers, filling omitted fields from the defaults", () => {
    const t = holderTiersFor({
      holders: {
        distributionTiers: [
          { label: "1M+", min: 1_000_000, max: null },
          { label: "0.1-1M", min: 0.1, max: 1_000_000 },
        ],
        balanceRanges: [{ label: "0.1–1K", min: 0.1, max: 1000 }, { label: "1K+", min: 1000, max: null }],
      },
    });
    expect(t.distributionTiers.map((r) => r.label)).toEqual(["1M+", "0.1-1M"]);
    expect(bucketFloor(t)).toBe(0.1);
    expect(t.retailThreshold).toBe(1000);
    const g = tierGeometryFor(t.distributionTiers.map((r) => r.label));
    expect(g.canvasH).toBe(canvasHeight(2));
    expect(g.canvasH).toBeLessThan(682);
  });

  it("derives chain meta (label, explorer, canonical token) for any declared chain", () => {
    expect(
      projectChainMeta({
        chains: [
          {
            key: "arbitrum", name: "Arbitrum One", chainId: 42161, explorer: "https://arbiscan.io/",
            tokens: [{ generation: "legacy", address: "0xABC", decimals: 18 }],
          },
        ],
      }),
    ).toEqual([{ key: "arbitrum", label: "Arbitrum One", explorerUrl: "https://arbiscan.io", tokenUrl: "https://arbiscan.io/token/0xabc" }]);
  });
});

describe("bucketFloor / dustFloorText across floors", () => {
  const dust = normalizeHolderTiers({
    distributionTiers: [
      { label: "1+", min: 1, max: null },
      { label: "0.001-1", min: 0.001, max: 1 },
      { label: "<0.000001", min: 0, max: 0.000001 },
    ],
    balanceRanges: [{ label: "<1", min: 0, max: 1 }, { label: "1+", min: 1, max: null }],
  });

  it("existing tokens keep a floor of 1 (min over ranges and tiers matches the script twin)", () => {
    for (const slug of ["tel", "ondo", "zebec-network"]) {
      const t = holderTiersFor(getProject(slug));
      expect(bucketFloor(t)).toBe(1);
      expect(dustFloorText(t)).toBe("1");
    }
    expect(bucketFloor(defaultHolderTiers())).toBe(1);
  });

  it("takes the minimum over both lists", () => {
    expect(bucketFloor(dust)).toBe(0);
    const tiersLower = normalizeHolderTiers({
      balanceRanges: [{ label: "1+", min: 1, max: null }],
      distributionTiers: [{ label: "0.01+", min: 0.01, max: null }],
    });
    expect(bucketFloor(tiersLower)).toBe(0.01);
  });

  it("dustFloorText is null at floor 0 and formats a fractional floor", () => {
    expect(dustFloorText(dust)).toBeNull();
    expect(dustFloorText(normalizeHolderTiers({ balanceRanges: [{ label: "x", min: 0.1, max: null }], distributionTiers: [{ label: "y", min: 0.1, max: null }] }))).toBe("0.1");
  });
});

describe("logMidFor with a min-0 range", () => {
  const ranges = [
    { label: "<1", min: 0, max: 1 },
    { label: "1–10", min: 1, max: 10 },
  ];
  it("is finite and orders the dust range below the next one", () => {
    const lo = logMidFor("<1", ranges);
    const next = logMidFor("1–10", ranges);
    expect(Number.isFinite(lo)).toBe(true);
    expect(lo).toBeLessThan(next);
  });
});

describe("dust labels in the URL", () => {
  it("round-trips ?tier=<0.000001 through URLSearchParams", () => {
    const url = new URL("https://x.test/hedera");
    url.searchParams.set("tier", "<0.000001");
    expect(new URLSearchParams(new URL(url.toString()).search).get("tier")).toBe("<0.000001");
    url.searchParams.set("tier", "0.000001-0.001");
    expect(new URL(url.toString()).searchParams.get("tier")).toBe("0.000001-0.001");
  });
});
