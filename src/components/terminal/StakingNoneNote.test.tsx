import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { __resetActiveSlug } from "@/lib/projectStore";
import { StakingNoneCard, StakingNoneNote } from "./StakingNoneNote";

afterEach(() => __resetActiveSlug("tel"));

describe("StakingNoneNote", () => {
  it("names the project and says it has no staking mechanism", () => {
    __resetActiveSlug("ondo");
    const html = renderToStaticMarkup(<StakingNoneNote />);
    expect(html).toContain('data-testid="staking-none"');
    expect(html).toMatch(/Ondo has no staking contract or staking mechanism/);
    expect(html).not.toMatch(/No data for this period/);
  });

  it("mobile Staking section shows the note, not zeroed stat tiles", () => {
    __resetActiveSlug("ondo");
    const html = renderToStaticMarkup(<StakingNoneCard />);
    expect(html).toContain('data-testid="staking-none-card"');
    expect(html).toContain("Ondo has no staking contract or staking mechanism");
    expect(html).not.toMatch(/Stakers|Staked Total|0\.00%/);
  });
});
