import { describe, expect, it } from "vitest";
import { tableDescription } from "./columnCopy";

describe("tableDescription", () => {
  it("names the flows window, not a snapshot baseline", () => {
    const d = tableDescription("Oct 30", "from Jan 1 to Oct 30");
    expect(d).toBe("Flows as of Oct 30. Net = in minus out from Jan 1 to Oct 30.");
    expect(d).not.toContain("since");
  });
  it("omits the as-of clause when the feed has no date", () => {
    expect(tableDescription(null, "over the selected period")).toBe("Net = in minus out over the selected period.");
  });
});
