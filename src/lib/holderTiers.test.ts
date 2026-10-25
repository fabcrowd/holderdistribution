import { describe, it, expect } from "vitest";
import { holderTiersFor, defaultHolderTiers, bucketFloor } from "@/lib/holderTiers";
import { getProject, projectChainMeta } from "@/lib/projects";
import { TIERS, CANVAS_H, canvasHeight, sideTop } from "@/components/tierflow/geometry";
import { tierGeometryFor } from "@/components/tierflow/useTierGeometry";
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
