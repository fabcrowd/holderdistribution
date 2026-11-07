import { describe, it, expect } from "vitest";
import { chainCaughtUp } from "./tierOutflowsComplete.js";

describe("chainCaughtUp", () => {
  it("is caught up once lastBlock reaches the settled target, even far behind the tip", () => {
    expect(chainCaughtUp({ latest: 54_346_250, lastBlock: 54_167_429, settledTarget: 54_167_429 }, 43_000)).toBe(true);
    expect(chainCaughtUp({ latest: 54_346_250, lastBlock: 54_100_000, settledTarget: 54_167_429 }, 43_000)).toBe(false);
  });
  it("falls back to the tip rule when no settled target is recorded", () => {
    expect(chainCaughtUp({ latest: 1000, lastBlock: 900 }, 200)).toBe(true);
    expect(chainCaughtUp({ latest: 1000, lastBlock: 500 }, 200)).toBe(false);
  });
  it("is not caught up without a checkpoint", () => {
    expect(chainCaughtUp(null, 200)).toBe(false);
    expect(chainCaughtUp({ latest: 1000 }, 200)).toBe(false);
  });
});
