import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const cell = (dex: number, cex: number, moved: number) => ({
  dex, dexSwap: dex, dexLp: 0, cex, moved,
  inflows: { dex: 0, dexSwap: 0, dexLp: 0, cex: 0, wallet: 0 },
});

vi.mock("@/hooks/useHolderTransitions", () => ({
  useHolderTransitions: () => ({ data: undefined, isPending: false, isError: false }),
  transitionsKeyFor: () => "7",
}));
vi.mock("@/hooks/useTierOutflows", () => ({
  outflowsKeyFor: () => "7",
  useTierOutflows: () => ({
    isPending: false,
    isError: false,
    data: {
      complete: true,
      sourceTierSince: null,
      ranges: {
        "7": {
          attributedDays: 0,
          totalDays: 7,
          tiers: { "A": cell(10, 5, 0), "B": cell(1, 1, 0), unattributed: cell(1000, 1000, 1000) },
        },
      },
    },
  }),
}));
vi.mock("./useTierGeometry", () => ({
  useTierGeometry: () => ({ tiers: ["A", "B"], tierIndex: (l: string) => ["A", "B"].indexOf(l) }),
}));

import { useFlowField } from "./useFlowField";
// vitest hoists vi.mock above imports, so the mocks apply to this import.

describe("useFlowField with an unattributed tier key", () => {
  it("ignores the key: only configured tiers appear and totals exclude it", () => {
    let out: ReturnType<typeof useFlowField> | undefined;
    const Probe = () => {
      out = useFlowField([], "all", "tel", 7);
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    expect(out?.fields.map((f) => f.label)).toEqual(["A", "B"]);
    expect(out?.grossExplainer).toMatchObject({ dex: 11, cex: 6, moved: 0, total: 17 });
    expect(out?.attributedDays).toBe(0);
  });
});
