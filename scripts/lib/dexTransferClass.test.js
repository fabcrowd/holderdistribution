import { describe, expect, it } from "vitest";
import { classifyReceiptLogs, dexSubClass } from "./dexTransferClass.js";

const topic = (t0) => ({ topics: [t0] });

describe("classifyReceiptLogs", () => {
  it("detects Balancer LP via PoolBalanceChanged", () => {
    expect(
      classifyReceiptLogs([
        topic("0xe5ce249087ce04f05a957192435400fd97868dba0e6a4b4c049abf8af80dae78"),
      ]),
    ).toBe("lp");
  });

  it("detects Balancer swap", () => {
    expect(
      classifyReceiptLogs([
        topic("0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b"),
      ]),
    ).toBe("swap");
  });

  it("prefers LP when both LP and Swap fire in one receipt", () => {
    expect(
      classifyReceiptLogs([
        topic("0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b"),
        topic("0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f"),
      ]),
    ).toBe("lp");
  });

  it("detects Uniswap V3 mint/burn as LP and Swap as swap", () => {
    expect(
      classifyReceiptLogs([
        topic("0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde"),
      ]),
    ).toBe("lp");
    expect(
      classifyReceiptLogs([
        topic("0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"),
      ]),
    ).toBe("swap");
  });

  it("returns unknown with no matching topics", () => {
    expect(classifyReceiptLogs([topic("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")])).toBe("unknown");
    expect(classifyReceiptLogs([])).toBe("unknown");
  });
});

describe("dexSubClass", () => {
  it("maps lp → dexLp and everything else → dexSwap", () => {
    expect(dexSubClass("lp")).toBe("dexLp");
    expect(dexSubClass("swap")).toBe("dexSwap");
    expect(dexSubClass("unknown")).toBe("dexSwap");
  });
});
