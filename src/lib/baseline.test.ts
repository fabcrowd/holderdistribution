import { describe, expect, it } from "vitest";
import { pickBaseline } from "./baseline";

const D = 86400000;
const at = (iso: string) => ({ ts: Date.parse(iso) });
const ts = (p: { ts: number }) => p.ts;

describe("pickBaseline", () => {
  it("never picks the latest point as its own baseline (archive gap → null)", () => {
    const pts = [at("2026-10-01T05:00:00Z"), at("2026-10-02T05:00:00Z"), at("2026-10-23T15:00:00Z")];
    expect(pickBaseline(pts, 1, ts)).toBeNull();
  });

  it("picks the nearest earlier point within tolerance", () => {
    const latest = Date.parse("2026-10-23T15:00:00Z");
    const pts = [{ ts: latest - 30 * D }, { ts: latest - 1.1 * D }, { ts: latest }];
    expect(pickBaseline(pts, 1, ts)).toEqual({ ts: latest - 1.1 * D });
    expect(pickBaseline(pts, 30, ts)).toEqual({ ts: latest - 30 * D });
  });

  it("a single point has no baseline", () => {
    expect(pickBaseline([at("2026-10-23T15:00:00Z")], 7, ts)).toBeNull();
  });
});
