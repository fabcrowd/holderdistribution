import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Callout } from "./callout";

describe("Callout", () => {
  const html = renderToStaticMarkup(<Callout>Hi</Callout>);

  it("renders its text inside the shared warning tint", () => {
    expect(html).toContain("Hi");
    expect(html).toContain("bg-warning-tint");
  });

  it("hides the default icon from assistive tech", () => {
    expect(html).toContain('aria-hidden="true"');
  });
});
