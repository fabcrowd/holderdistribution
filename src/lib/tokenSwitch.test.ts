import { describe, expect, it } from "vitest";
import { filterTokens, isSwitchShortcut, moveActive, switchTarget, type SwitchOption } from "@/lib/tokenSwitch";

const shortcut = (over: Partial<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">>) => ({
  key: "k",
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

const OPTIONS: SwitchOption[] = [
  { slug: "tel", name: "Telcoin", ticker: "TEL" },
  { slug: "zebec-network", name: "Zebec Network", ticker: "ZBCN" },
  { slug: "ondo", name: "Ondo", ticker: "ONDO" },
];

describe("filterTokens", () => {
  it("returns every option for an empty or whitespace query, in original order", () => {
    expect(filterTokens(OPTIONS, "").map((o) => o.slug)).toEqual(["tel", "zebec-network", "ondo"]);
    expect(filterTokens(OPTIONS, "   ").map((o) => o.slug)).toEqual(["tel", "zebec-network", "ondo"]);
  });

  it("matches case-insensitively on name, ticker and slug, and trims the query", () => {
    expect(filterTokens(OPTIONS, "  ZEBEC ").map((o) => o.slug)).toEqual(["zebec-network"]);
    expect(filterTokens(OPTIONS, "telcoin").map((o) => o.slug)).toEqual(["tel"]);
    expect(filterTokens(OPTIONS, "zebec-n").map((o) => o.slug)).toEqual(["zebec-network"]);
  });

  it("sorts ticker-prefix matches first and keeps the original order otherwise", () => {
    const opts: SwitchOption[] = [
      { slug: "alpha-on", name: "Alpha", ticker: "ALP" },
      { slug: "ondo", name: "Ondo", ticker: "ONDO" },
      { slug: "on-chain", name: "Chain", ticker: "CHN" },
      { slug: "onyx", name: "Onyx", ticker: "ONX" },
    ];
    expect(filterTokens(opts, "on").map((o) => o.slug)).toEqual(["ondo", "onyx", "alpha-on", "on-chain"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterTokens(OPTIONS, "doge")).toEqual([]);
  });

  it("returns an empty list for an empty option list", () => {
    expect(filterTokens([], "tel")).toEqual([]);
  });
});

describe("switchTarget", () => {
  it("keeps a top-level view hash", () => {
    expect(switchTarget("ondo", "#holders")).toBe("/ondo#holders");
    expect(switchTarget("ondo", "#distribution")).toBe("/ondo#distribution");
    expect(switchTarget("ondo", "#supply")).toBe("/ondo#supply");
  });

  it("drops a sub-panel path down to its view", () => {
    expect(switchTarget("ondo", "#supply/wallet-flows")).toBe("/ondo#supply");
  });

  it("drops an unknown hash, an empty hash and the skip-link target", () => {
    expect(switchTarget("ondo", "#main-content")).toBe("/ondo");
    expect(switchTarget("ondo", "")).toBe("/ondo");
    expect(switchTarget("tel", "#")).toBe("/tel");
  });

  it("maps the legacy #overview tab to #holders, as viewRoute does", () => {
    expect(switchTarget("ondo", "#overview")).toBe("/ondo#holders");
    expect(switchTarget("ondo", "#overview/flows")).toBe("/ondo#holders");
  });
});

describe("isSwitchShortcut", () => {
  it("accepts Ctrl+K and Cmd+K, in either case", () => {
    expect(isSwitchShortcut(shortcut({ key: "k" }))).toBe(true);
    expect(isSwitchShortcut(shortcut({ key: "K" }))).toBe(true);
    expect(isSwitchShortcut(shortcut({ key: "k", ctrlKey: false, metaKey: true }))).toBe(true);
  });

  it("ignores a key-less event (autofill or IME dispatch) without throwing", () => {
    expect(isSwitchShortcut(shortcut({ key: undefined as unknown as string }))).toBe(false);
  });

  it("ignores Ctrl+Shift+K and Ctrl+Alt+K", () => {
    expect(isSwitchShortcut(shortcut({ shiftKey: true }))).toBe(false);
    expect(isSwitchShortcut(shortcut({ altKey: true }))).toBe(false);
  });

  it("ignores a plain k and other keys", () => {
    expect(isSwitchShortcut(shortcut({ ctrlKey: false }))).toBe(false);
    expect(isSwitchShortcut(shortcut({ key: "j" }))).toBe(false);
  });
});

describe("moveActive", () => {
  it("steps forward and backward within the list", () => {
    expect(moveActive(0, 3, 1)).toBe(1);
    expect(moveActive(1, 3, -1)).toBe(0);
  });

  it("wraps at both ends", () => {
    expect(moveActive(2, 3, 1)).toBe(0);
    expect(moveActive(0, 3, -1)).toBe(2);
  });

  it("returns -1 for an empty list", () => {
    expect(moveActive(0, 0, 1)).toBe(-1);
    expect(moveActive(0, 0, -1)).toBe(-1);
  });
});
