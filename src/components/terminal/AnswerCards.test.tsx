import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Users } from "lucide-react";
import { AnswerCards } from "./AnswerCards";
import { ANSWER_CARD_IDS, pickAnswerTiles } from "@/lib/answerCards";
import type { EcosystemHeadlineTile, EcosystemHeadlineTileId } from "@/hooks/useEcosystemHeadlineTiles";

const tile = (id: EcosystemHeadlineTileId, over: Partial<EcosystemHeadlineTile> = {}): EcosystemHeadlineTile => ({
  id,
  icon: Users,
  label: `Label ${id}`,
  value: `V-${id}`,
  sub: `Sub ${id}`,
  ath: false,
  current: 10,
  previous: 8,
  fmt: undefined,
  scope: "chain",
  ...over,
});

const ALL = [tile("holders"), tile("retailHeld"), tile("staked"), tile("cex", { scope: "all" })];

describe("pickAnswerTiles", () => {
  it("keeps holders, retail held and exchange balance, in that order, and drops staked", () => {
    expect(pickAnswerTiles([...ALL].reverse()).map((t) => t.id)).toEqual([...ANSWER_CARD_IDS]);
    expect(pickAnswerTiles(ALL).map((t) => t.id)).not.toContain("staked");
  });
  it("skips a tile a project does not produce", () => {
    expect(pickAnswerTiles([tile("holders"), tile("cex")]).map((t) => t.id)).toEqual(["holders", "cex"]);
  });
});

describe("AnswerCards", () => {
  it("renders exactly three cards using the tokens, with the label, value and sub line", () => {
    const html = renderToStaticMarkup(<AnswerCards tiles={ALL} selectedView="combined" isError={false} />);
    expect(html.match(/data-testid="answer-(holders|retailHeld|staked|cex)"/g)).toHaveLength(3);
    expect(html).toContain(">V-holders<");
    expect(html).toContain("Sub cex");
    expect(html).toContain("text-brand");
    expect(html).not.toContain("V-staked");
    expect(html).not.toContain("answer-staked");
  });
  it("tags non-splittable figures when a single chain is selected", () => {
    const html = renderToStaticMarkup(<AnswerCards tiles={ALL} selectedView={"ethereum" as never} isError={false} />);
    expect(html).toContain("All chains");
    const combined = renderToStaticMarkup(<AnswerCards tiles={ALL} selectedView="combined" isError={false} />);
    expect(combined).not.toContain("All chains");
  });
  it("shows a skeleton while loading and a message on error", () => {
    expect(renderToStaticMarkup(<AnswerCards tiles={[]} selectedView="combined" isError={false} />)).toContain("animate-pulse");
    expect(renderToStaticMarkup(<AnswerCards tiles={[]} selectedView="combined" isError />)).toContain("unavailable");
  });
});
