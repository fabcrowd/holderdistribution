import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubPanelTabs } from "./SubPanelTabs";

const many = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id.toUpperCase() }));
const html = (panels: typeof many, variant?: "underline" | "filter") =>
  renderToStaticMarkup(
    <SubPanelTabs panels={panels} value="a" onValueChange={() => {}} variant={variant}>
      <div />
    </SubPanelTabs>,
  );

describe("SubPanelTabs", () => {
  it("adds a labelled Section picker (phones) when there are many panels", () => {
    const out = html(many);
    expect(out).toContain("<select");
    expect(out).toMatch(/<label[^>]*>Section<\/label>/);
    expect((out.match(/<option/g) ?? []).length).toBe(5);
  });
  it("keeps plain tabs for short lists and for the filter variant", () => {
    expect(html(many.slice(0, 3))).not.toContain("<select");
    expect(html(many, "filter")).not.toContain("<select");
    expect((html(many.slice(0, 3), "filter").match(/role="tab"/g) ?? []).length).toBe(3);
  });
});
