import { describe, expect, it } from "vitest";
import { COMING_SOON, comingSoonTokens } from "@/lib/comingSoon";
import { LISTED_PROJECTS } from "@/lib/projects";

const tokens = [
  { name: "Alpha", ticker: "ALP", image: "/tokens/alp.png" },
  { name: "Beta", ticker: "BET", image: "/tokens/bet.png" },
];

describe("comingSoonTokens", () => {
  it("drops a token once a listed project has its ticker, case-insensitively", () => {
    expect(comingSoonTokens([{ ticker: "alp" }], tokens).map((t) => t.ticker)).toEqual(["BET"]);
  });

  it("keeps every token when none is listed", () => {
    expect(comingSoonTokens([], tokens)).toHaveLength(2);
  });

  it("never shows a listed project as coming soon on the real landing page", () => {
    const listed = new Set(LISTED_PROJECTS.map((p) => p.ticker.toUpperCase()));
    expect(comingSoonTokens(LISTED_PROJECTS, COMING_SOON).some((t) => listed.has(t.ticker))).toBe(false);
  });
});
