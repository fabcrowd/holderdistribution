import { describe, expect, it } from "vitest";
import { resolveFlowLoad } from "./useFlowField";

const base = {
  outflowsLoading: false,
  transitionsLoading: false,
  outflowsErrored: false,
  transitionsErrored: false,
  hasTransitions: false,
  hasOutflows: false,
};

describe("resolveFlowLoad", () => {
  it("stays loading until both feeds settle", () => {
    expect(resolveFlowLoad({ ...base, outflowsLoading: true, hasTransitions: true })).toBe("loading");
    expect(resolveFlowLoad({ ...base, transitionsLoading: true, hasOutflows: true })).toBe("loading");
  });

  it("TEL: both windows present is ready", () => {
    expect(resolveFlowLoad({ ...base, hasTransitions: true, hasOutflows: true })).toBe("ready");
  });

  it("ZBCN: wallet transitions still draw when tier-outflows has no window", () => {
    expect(resolveFlowLoad({ ...base, hasTransitions: true, hasOutflows: false })).toBe("ready");
  });

  it("a published empty tier map is a window, so the diagram is ready", () => {
    expect(resolveFlowLoad({ ...base, hasTransitions: true, hasOutflows: true })).toBe("ready");
  });

  it("nothing measured and no transitions is an empty state, not an error", () => {
    expect(resolveFlowLoad(base)).toBe("empty");
  });

  it("a real feed failure stays an error so Retry can recover", () => {
    expect(resolveFlowLoad({ ...base, outflowsErrored: true, hasTransitions: true })).toBe("error");
    expect(resolveFlowLoad({ ...base, transitionsErrored: true })).toBe("error");
  });
});
