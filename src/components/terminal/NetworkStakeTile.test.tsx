import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { __resetActiveSlug } from "@/lib/projectStore";
import { getProject } from "@/lib/projects";
import { NETWORK_STAKE_NOTE, type NetworkStake } from "@/lib/staking";
import { StakingNoneCard, StakingNoneNote } from "./StakingNoneNote";

afterEach(() => __resetActiveSlug("tel"));

const stake: NetworkStake = { available: true, stakedTotal: 0.25 * (getProject("ondo").supply?.target ?? 1), stakingPeriod: { start: "2026-11-13T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" } };

describe("network stake tile (in the Staking section of a token without a staking contract)", () => {
  it("shows amount, share of supply, the period day and the plain note, and not the no-staking note", () => {
    __resetActiveSlug("ondo");
    const html = renderToStaticMarkup(<StakingNoneNote networkStake={stake} />);
    expect(html).toContain('data-testid="network-stake"');
    expect(html).toContain("25.00% of total supply");
    expect(html).toContain("Staking period of 2026-11-13 (UTC)");
    expect(html).toContain("Staked coins stay in the holder&#x27;s own account and are already counted in holder balances");
    expect(NETWORK_STAKE_NOTE).toMatch(/not subtracted from anything/);
    expect(html).not.toContain("staking-none");
    expect(html).not.toMatch(/Stakers|Staked Total|NaN|undefined/);
  });

  it("an unavailable block shows the unavailable message, never a zero amount", () => {
    __resetActiveSlug("ondo");
    const html = renderToStaticMarkup(<StakingNoneCard networkStake={{ available: false, reason: "mirror down" }} />);
    expect(html).toContain('data-testid="network-stake-unavailable"');
    expect(html).toContain("unavailable right now");
    expect(html).not.toContain('data-testid="network-stake"');
    expect(html).not.toContain("mirror down");
    expect(html).not.toContain("network-stake-amount");
  });

  it("without a block the section renders exactly the no-staking note", () => {
    __resetActiveSlug("ondo");
    expect(renderToStaticMarkup(<StakingNoneNote networkStake={null} />)).toBe(renderToStaticMarkup(<StakingNoneNote />));
    expect(renderToStaticMarkup(<StakingNoneNote />)).toContain("Ondo has no staking contract or staking mechanism");
  });
});
