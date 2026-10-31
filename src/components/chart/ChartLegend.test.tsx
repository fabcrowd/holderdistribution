import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartLegend } from "./ChartLegend";
import { ToggleableSeries } from "./ToggleableSeries";
import { TimeChart } from "@/components/terminal/MiniCharts";

const items = [
  { key: "a", label: "Alpha", color: "red" },
  { key: "b", label: "Beta", color: "blue" },
];

describe("ChartLegend", () => {
  it("renders one toggle button per series with its pressed state", () => {
    const html = renderToStaticMarkup(<ChartLegend items={items} hidden={new Set(["a"])} onToggle={() => {}} />);
    expect(html).toMatch(/aria-pressed="false"[^>]*>[^]*Alpha/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>[^]*Beta/);
  });

  it("marks the last visible series as not hideable", () => {
    const html = renderToStaticMarkup(<ChartLegend items={items} hidden={new Set(["a"])} onToggle={() => {}} />);
    expect(html).toContain('aria-disabled="true"');
    const both = renderToStaticMarkup(<ChartLegend items={items} hidden={new Set()} onToggle={() => {}} />);
    expect(both).not.toContain("aria-disabled");
  });
});

describe("ToggleableSeries", () => {
  it("renders every series initially", () => {
    const html = renderToStaticMarkup(
      <ToggleableSeries items={items}>{(v) => <p>{items.filter((i) => v(i.key)).map((i) => i.key).join(",")}</p>}</ToggleableSeries>,
    );
    expect(html).toContain("<p>a,b</p>");
  });
});

describe("TimeChart legend", () => {
  const data = Array.from({ length: 12 }, (_, i) => ({ t: Date.UTC(2026, 9, 1 + i), a: 100 + i, b: 5 + i }));
  const two = [
    { key: "a", label: "Alpha", color: "red" },
    { key: "b", label: "Beta", color: "blue" },
  ];
  it("offers a toggle legend for multi-series charts only", () => {
    expect(renderToStaticMarkup(<TimeChart data={data} series={two} label="T" />)).toContain('data-testid="series-legend"');
    expect(renderToStaticMarkup(<TimeChart data={data} series={[two[0]]} label="T" />)).not.toContain("series-legend");
  });
  it("makes the chart zoomable (focusable group) once there are enough rows", () => {
    expect(renderToStaticMarkup(<TimeChart data={data} series={two} label="T" />)).toContain('role="group"');
    expect(renderToStaticMarkup(<TimeChart data={data.slice(0, 5)} series={two} label="T" />)).not.toContain("Chart. Scroll");
  });
  it("keeps the screen-reader summary on the chart group", () => {
    expect(renderToStaticMarkup(<TimeChart data={data} series={two} label="Summary text" />)).toMatch(/role="group"[^>]*aria-label="Summary text"/);
  });
});
