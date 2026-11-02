import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExchangeNetflow } from "./ExchangeNetflow";

vi.mock("@/hooks/useExchangeFlow", () => ({
  useExchangeFlow: () => ({ data: [], isPending: false, isError: false }),
}));
vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({
    project: {
      ticker: "ZBCN",
      name: "Zebec",
      chains: [{ key: "solana", name: "Solana", tokens: [] }],
      health: { feeds: { "exchange-flow-history.json": { placeholder: true } } },
    },
  }),
}));
vi.mock("@/hooks/useProjectCopy", () => ({
  useProjectCopy: () => ({ ticker: "ZBCN", t: (s: string) => s }),
}));

describe("ExchangeNetflow empty state", () => {
  it("shows the Solana not-tracked message for a Solana project with a placeholder flow feed", () => {
    const html = renderToStaticMarkup(<ExchangeNetflow rangeDays={30} />);
    expect(html).toContain('data-testid="exchange-flow-empty"');
    expect(html).toContain("Solana flows not tracked yet");
    expect(html).not.toContain("No flow data for this period.");
  });
});
