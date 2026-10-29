import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TapTile } from "./TapTile";

describe("TapTile", () => {
  const html = renderToStaticMarkup(
    <TapTile
      testId="tile"
      label="Net change"
      value="+230.8M ZBCN"
      explanation="The real snapshot-to-snapshot change, vs 2026-01-01."
    />,
  );

  it("shows only the short label and the headline value on screen", () => {
    expect(html).toContain("Net change");
    expect(html).toContain("+230.8M ZBCN");
    expect(html).toContain('data-testid="tile"');
  });

  it("keeps the explanation out of the markup until the tile is tapped", () => {
    expect(html).not.toContain("snapshot-to-snapshot");
  });
});
