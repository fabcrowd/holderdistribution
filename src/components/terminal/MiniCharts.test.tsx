import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatCompact } from "@/lib/format";
import { StackedTimeCharts, TimeChart } from "./MiniCharts";

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

describe("TimeChart data table", () => {
  it("is labelled by the chart summary and absent when table is false", () => {
    expect(renderToStaticMarkup(<TimeChart data={rows(8)} series={series} label="Wallet trend." />)).toContain("View data as table");
    expect(renderToStaticMarkup(<TimeChart data={rows(8)} series={series} label="Test" table={false} />)).not.toContain("View data as table");
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

describe("StackedTimeCharts", () => {
  const stackSeries = [
    { key: "retail", label: "Retail", color: "red" },
    { key: "cex", label: "Exchanges", color: "blue" },
  ] as const;
  const stackData = Array.from({ length: 8 }, (_, i) => ({ t: Date.UTC(2026, 9, 1 + i), retail: 66000 + i * 100, cex: 21000 + i }));

  it("labels both series in one summary on the image wrapper", () => {
    const html = renderToStaticMarkup(<StackedTimeCharts data={stackData} series={stackSeries} label="Retail and exchange balances." />);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Retail and exchange balances."');
  });

  it("offers the data table from a button beside the plots", () => {
    const html = renderToStaticMarkup(<StackedTimeCharts data={stackData} series={stackSeries} label="Test" />);
    expect(html).toContain("View data as table");
    expect(html).not.toContain("<table");
  });

  it("omits the table when asked", () => {
    const html = renderToStaticMarkup(<StackedTimeCharts data={stackData} series={stackSeries} label="Test" table={false} />);
    expect(html).not.toContain("View data as table");
  });

  it("titles each plot with its series name and latest value", () => {
    const html = renderToStaticMarkup(<StackedTimeCharts data={stackData} series={stackSeries} label="Test" />);
    expect(html).toContain("Retail");
    expect(html).toContain("Exchanges");
    expect(html).toContain(formatCompact(66700));
    expect(html).toContain(formatCompact(21007));
  });

  it("uses the last non-null value as a series' latest figure", () => {
    const gappy = [...stackData.slice(0, 6), { ...stackData[6], cex: null }, { ...stackData[7], cex: null }];
    const html = renderToStaticMarkup(<StackedTimeCharts data={gappy} series={stackSeries} label="Test" />);
    expect(html).toContain(formatCompact(21005));
  });

  it("uses no combined axis legend and no right-hand axis", () => {
    const html = renderToStaticMarkup(<StackedTimeCharts data={stackData} series={stackSeries} label="Test" />);
    expect(html).not.toContain("axis-legend");
    expect(html).not.toContain("right axis");
  });

  it("shows the limited-history note for short data", () => {
    const short = stackData.slice(0, 4);
    const html = renderToStaticMarkup(<StackedTimeCharts data={short} series={stackSeries} label="Test" />);
    expect(html).toContain("Limited history (4 days)");
  });
});
