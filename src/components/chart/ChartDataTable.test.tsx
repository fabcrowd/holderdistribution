import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartDataTable, ChartDataTableBody } from "./ChartDataTable";

const columns = [
  { key: "date", label: "Date" },
  { key: "wallets", label: "Wallets", align: "right" as const, format: (v: unknown) => `#${v}` },
];
const rows = Array.from({ length: 3 }, (_, i) => ({ date: `2026-10-0${i + 1}`, wallets: 100 + i }));
const bodyRows = (html: string) => html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr/g) ?? [];

describe("ChartDataTable trigger", () => {
  it("renders nothing without rows", () => {
    expect(renderToStaticMarkup(<ChartDataTable caption="Holders" columns={columns} rows={[]} />)).toBe("");
  });

  it("is a native button labelled View data as table, sized to 44px below xl", () => {
    const html = renderToStaticMarkup(<ChartDataTable caption="Holders" columns={columns} rows={rows} />);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>View data as table<\/button>/);
    expect(html).toContain("max-xl:min-h-11");
    expect(html).toContain("focus-visible:ring-2 focus-visible:ring-ring");
  });

  it("keeps the table out of the closed panel flow", () => {
    expect(renderToStaticMarkup(<ChartDataTable caption="Holders" columns={columns} rows={rows} />)).not.toContain("<table");
  });
});

describe("ChartDataTableBody", () => {
  it("names the scroll region and captions the table", () => {
    const html = renderToStaticMarkup(<ChartDataTableBody caption="Holders by day" columns={columns} rows={rows} />);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Holders by day"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('<caption class="sr-only">Holders by day</caption>');
  });

  it("marks column headers with scope and right-aligns numeric cells", () => {
    const html = renderToStaticMarkup(<ChartDataTableBody caption="Holders" columns={columns} rows={rows} />);
    expect(html.match(/<th scope="col"/g)).toHaveLength(2);
    expect(html).toContain("text-right");
  });

  it("lists one body row per data row, newest first", () => {
    const html = renderToStaticMarkup(<ChartDataTableBody caption="Holders" columns={columns} rows={rows} />);
    expect(bodyRows(html)).toHaveLength(3);
    expect(html.indexOf("#102")).toBeLessThan(html.indexOf("#101"));
    expect(html.indexOf("#101")).toBeLessThan(html.indexOf("#100"));
    expect(html).not.toContain("Showing the latest");
  });

  it("shows the newest maxRows rows and notes the cut", () => {
    const html = renderToStaticMarkup(<ChartDataTableBody caption="Holders" columns={columns} rows={rows} maxRows={2} />);
    expect(html).toContain("Showing the latest 2 of 3 rows.");
    expect(bodyRows(html)).toHaveLength(2);
    expect(html).not.toContain("#100");
    expect(html.indexOf("#102")).toBeLessThan(html.indexOf("#101"));
  });
});
