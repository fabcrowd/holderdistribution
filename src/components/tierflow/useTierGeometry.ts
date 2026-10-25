import { useMemo } from "react";
import { useProject } from "@/hooks/useProject";
import { holderTiersFor } from "@/lib/holderTiers";
import { canvasHeight, sideTop, sideCenterY } from "./geometry";

export type TierGeometry = {
  /** Active project's distribution tier labels, largest -> smallest (TEL: geometry.TIERS). */
  tiers: readonly string[];
  tierIndex: (label: string) => number;
  canvasH: number;
  sideTop: (j: number) => number;
  sideCenterY: (j: number) => number;
};

/** Pure: tier-flow geometry for a list of tier labels. */
export const tierGeometryFor = (tiers: readonly string[]): TierGeometry => {
  const h = canvasHeight(tiers.length);
  return {
    tiers,
    tierIndex: (label: string) => tiers.indexOf(label),
    canvasH: h,
    sideTop: (j: number) => sideTop(j, h),
    sideCenterY: (j: number) => sideCenterY(j, h),
  };
};

/** Tier-flow geometry for the active project's `holders.distributionTiers`. */
export const useTierGeometry = (): TierGeometry => {
  const { project } = useProject();
  const tiers = holderTiersFor(project).distributionTiers;
  return useMemo(() => tierGeometryFor(tiers.map((t) => t.label)), [tiers]);
};
