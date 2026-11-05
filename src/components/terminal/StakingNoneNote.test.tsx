import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { __resetActiveSlug } from "@/lib/projectStore";
import { StakingNoneNote } from "./StakingNoneNote";

afterEach(() => __resetActiveSlug("tel"));

describe("StakingNoneNote", () => {
  it("names the project and says it has no staking mechanism", () => {
    __resetActiveSlug("ondo");
    const html = renderToStaticMarkup(<StakingNoneNote />);
    expect(html).toContain('data-testid="staking-none"');
    expect(html).toMatch(/Ondo has no staking contract or staking mechanism/);
    expect(html).not.toMatch(/No data for this period/);
  });
});
