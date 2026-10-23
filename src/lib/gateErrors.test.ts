import { describe, expect, it } from "vitest";
import { describeGateFailure, gateErrorMessage } from "./gateErrors";
import { ForensicsGateError } from "./forensicsGateApi";

describe("gate failure messages", () => {
  it("distinguishes 401 / expired / 429 / 503 / 403", () => {
    expect(describeGateFailure(new ForensicsGateError("Invalid password", 401))).toEqual({ kind: "invalid" });
    expect(describeGateFailure(new ForensicsGateError("Session expired", 401))).toEqual({ kind: "expired" });
    expect(describeGateFailure(new ForensicsGateError("x", 429, 42), 1000)).toEqual({ kind: "rate-limited", retryAt: 43_000 });
    expect(describeGateFailure(new ForensicsGateError("x", 503))).toEqual({ kind: "unavailable" });
    expect(describeGateFailure(new TypeError("fetch failed"))).toEqual({ kind: "unavailable" });
    expect(describeGateFailure(new ForensicsGateError("x", 403))).toEqual({ kind: "forbidden" });
    const msgs = new Set(
      (["invalid", "expired", "unavailable", "forbidden"] as const).map((kind) => gateErrorMessage({ kind }, 0)),
    );
    msgs.add(gateErrorMessage({ kind: "rate-limited", retryAt: 0 }, 30));
    expect(msgs.size).toBe(5);
  });
});
