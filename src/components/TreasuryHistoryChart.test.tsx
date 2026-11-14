import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectConfig } from "@/lib/projects";

const state = vi.hoisted(() => ({ project: {} as unknown, entries: [] as unknown[] }));

vi.mock("@/hooks/useProject", () => ({
  useProject: () => ({ slug: "stub", project: state.project }),
}));
vi.mock("@/hooks/useProjectCopy", async () => {
  const pc = await import("@/lib/projectCopy");
  return {
    useProjectCopy: () => {
      const p = state.project as ProjectConfig;
      const ctx = pc.copyContext(p);
      return {
        ...ctx,
        t: (tpl: string) => pc.fillCopy(tpl, ctx),
        text: (id: string, tpl: string) => pc.copyText(p, id, tpl),
        hasText: (id: string) => pc.hasCopyText(p, id),
        entities: pc.projectEntities(p),
      };
    },
  };
});
vi.mock("@/hooks/useTreasuryHistory", () => ({
  useTreasuryHistory: () => ({ data: { entries: state.entries }, isError: false }),
}));

const { TreasuryHistoryChart, buildSeries } = await import("./TreasuryHistoryChart");

const chain = { key: "ethereum", name: "Ethereum", origin: true, explorer: "https://etherscan.io", tokens: [] };
const stub = (over: Partial<ProjectConfig>): ProjectConfig =>
  ({ slug: "stub", name: "Stub", ticker: "STB", chains: [chain], ...over }) as unknown as ProjectConfig;

const row = (date: string, categories: Record<string, number>) => ({ date, categories });
const feed = (categories: (i: number) => Record<string, number>) =>
  [0, 1, 2].map((i) => row(`2026-11-0${i + 1}`, categories(i)));

const chips = (project: ProjectConfig, entries: unknown[]) => {
  state.project = project;
  state.entries = entries;
  const html = renderToStaticMarkup(<TreasuryHistoryChart rangeDays={90} />);
  const doc = new JSDOM(html).window.document;
  return [...doc.querySelectorAll("button[aria-pressed]")].map((b) => ({
    label: b.textContent?.trim() ?? "",
    on: b.getAttribute("aria-pressed") === "true",
  }));
};

describe("TreasuryHistoryChart series", () => {
  it("TEL-shaped data keeps four lines, in order, with escrow off by default", () => {
    const tel = stub({
      name: "Telcoin",
      ticker: "TEL",
      supply: {
        developerHoldings: {
          subcategories: [
            { category: "treasury", label: "Treasury" },
            { category: "council", label: "Council / ops Safes" },
            { category: "staking-contract", label: "Staking contract" },
            { category: "holdings", label: "Telcoin Holdings" },
            { category: "escrow", label: "Escrow" },
          ],
        },
      },
      copy: { text: { "entity.associationShort": "Association", "entity.holdings": "Telcoin Holdings" } },
    });
    const entries = feed((i) => ({ treasury: 100 + i, council: 50 + i, holdings: 20 + i, escrow: 900 + i, "staking-contract": 0 }));
    expect(chips(tel, entries)).toEqual([
      { label: "Association — Treasury", on: true },
      { label: "Association — Council & Safes", on: true },
      { label: "Telcoin Holdings", on: true },
      { label: "Escrow", on: false },
    ]);
    expect(buildSeries(entries, tel).map((s) => s.color)).toEqual([
      "hsl(262 83% 58%)",
      "hsl(158 64% 42%)",
      "hsl(217 91% 60%)",
      "hsl(28 90% 55%)",
    ]);
  });

  it("a Solana token plots team and staking and shows no council or escrow chips", () => {
    const sol = stub({
      chains: [{ key: "solana", name: "Solana", vm: "solana", tokens: [] }] as unknown as ProjectConfig["chains"],
      supply: {
        developerHoldings: {
          subcategories: [
            { category: "treasury", label: "Treasury & vaults" },
            { category: "team", label: "Team wallets" },
            { category: "staking", label: "Reward vaults" },
          ],
        },
      },
    });
    const entries = feed((i) => ({ treasury: 100 + i, team: 10 + i, staking: 5 + i, council: 0, escrow: 0 }));
    const labels = chips(sol, entries).map((c) => c.label);
    expect(labels).toEqual(["Treasury — Treasury", "Team wallets", "Reward vaults"]);
    expect(labels.join(" ")).not.toMatch(/council|escrow/i);
  });

  it("orders unlisted categories after configured ones, alphabetically", () => {
    const series = buildSeries(feed(() => ({ zeta: 1, alpha: 1, treasury: 1 })), stub({ supply: { developerHoldings: { subcategories: [{ category: "treasury", label: "T" }] } } as ProjectConfig["supply"] }));
    expect(series.map((s) => s.key)).toEqual(["treasury", "alpha", "zeta"]);
  });

  it("hiddenByDefault copy decides which lines start off, and never hides every line", () => {
    const base = { supply: { developerHoldings: { subcategories: [{ category: "treasury", label: "T" }, { category: "team", label: "Team wallets" }] } } };
    const entries = feed(() => ({ treasury: 10, team: 5 }));
    const hideTeam = stub({ ...base, copy: { text: { "treasury.history.hiddenByDefault": "team" } } } as unknown as Partial<ProjectConfig>);
    expect(chips(hideTeam, entries).map((c) => c.on)).toEqual([true, false]);
    const hideAll = stub({ ...base, copy: { text: { "treasury.history.hiddenByDefault": "team, treasury" } } } as unknown as Partial<ProjectConfig>);
    expect(chips(hideAll, entries).map((c) => c.on)).toEqual([true, true]);
  });
});
