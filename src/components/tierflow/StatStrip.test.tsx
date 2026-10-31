import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatStrip } from "./StatStrip";

const stats = [
  { key: "a", label: "Net TEL", tip: "tip a", value: "+1M", tone: "positive" as const },
  { key: "b", label: "Buy - sell", tip: "tip b", value: "-2M", tone: "negative" as const },
  { key: "c", label: "DEX", tip: "tip c", value: "3M / 4M" },
];

describe("StatStrip", () => {
  it("renders every label and value with an info trigger per stat", () => {
    const html = renderToStaticMarkup(<StatStrip stats={stats} />);
    for (const s of ["Net TEL", "Buy - sell", "DEX", "+1M", "-2M", "3M / 4M"]) expect(html).toContain(s);
    expect(html.match(/what this means/g)).toHaveLength(3);
  });
  it("shows the tier chip only when a prefix is given", () => {
    expect(renderToStaticMarkup(<StatStrip stats={stats} />)).not.toContain("tier-strip-prefix");
    expect(renderToStaticMarkup(<StatStrip stats={stats} prefix="25M-50M" />)).toContain("25M-50M");
    expect(renderToStaticMarkup(<StatStrip stats={stats} prefix="25M-50M" stacked />)).not.toContain("25M-50M");
  });
  it("uses the tier text tokens for tone and keeps three columns from sm up", () => {
    const html = renderToStaticMarkup(<StatStrip stats={stats} />);
    expect(html).toContain("--tier-positive-text");
    expect(html).toContain("--tier-negative-text");
    expect(html).toContain("sm:grid-cols-3");
    expect(renderToStaticMarkup(<StatStrip stats={stats} stacked />)).not.toContain("sm:grid-cols-3");
  });
});
