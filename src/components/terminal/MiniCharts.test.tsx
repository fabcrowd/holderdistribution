import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TimeChart } from "./MiniCharts";

const series = [{ key: "v", label: "Value", color: "red" }];
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ t: Date.UTC(2026, 9, 1 + i), v: 100 + i }));

describe("TimeChart minimum-data guard", () => {
  it("shows a limited-history note below 5 points", () => {
    const html = renderToStaticMarkup(<TimeChart data={rows(4)} series={series} label="Test" />);
    expect(html).toContain("Limited history (4 days)");
    expect(html).toContain('data-testid="limited-history"');
  });

  it("shows no note at 5 or more points", () => {
    const html = renderToStaticMarkup(<TimeChart data={rows(5)} series={series} label="Test" />);
    expect(html).not.toContain("limited-history");
  });

  it("announces a declared break to screen readers", () => {
    const breaks = [{ t: Date.UTC(2026, 9, 3), label: "Methodology change", description: "Methodology change — not a market move" }];
    const html = renderToStaticMarkup(<TimeChart data={rows(8)} series={series} label="Test" breaks={breaks} />);
    expect(html).toContain("not a market move");
    expect(html).toContain('data-breaks="1"');
  });
});

describe("TimeChart axes", () => {
  const two = [
    { key: "a", label: "A", color: "red" },
    { key: "b", label: "B", color: "blue", axis: "right" as const },
  ];
  const data = Array.from({ length: 8 }, (_, i) => ({ t: Date.UTC(2026, 9, 1 + i), a: 1000 + i, b: 5 + i }));

  it("labels which series sits on which axis when two scales are used", () => {
    const html = renderToStaticMarkup(<TimeChart data={data} series={two} label="Test" />);
    expect(html).toContain('data-testid="axis-legend"');
    expect(html).toContain("right axis");
    expect(html).toContain("left axis");
  });

  it("has no axis legend for a single scale", () => {
    expect(renderToStaticMarkup(<TimeChart data={data} series={[two[0]]} label="Test" />)).not.toContain("axis-legend");
  });
});
