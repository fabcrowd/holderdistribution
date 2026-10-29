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
