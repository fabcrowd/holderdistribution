import { describe, expect, it } from "vitest";
import { flowEmptyMessage, SOLANA_FLOWS_UNTRACKED } from "./flowEmptyState";
import { FLOW_UNAVAILABLE_TEMPLATE } from "./flowFeeds";
import type { ProjectConfig } from "./projects";

const base = { ticker: "ZBCN", name: "Zebec", supply: undefined, copy: undefined } as const;

const solanaProject = {
  ...base,
  chains: [{ key: "solana", name: "Solana", tokens: [] }],
} as unknown as ProjectConfig;

const solanaPlaceholderProject = {
  ...solanaProject,
  health: { feeds: { "exchange-flow-history.json": { placeholder: true }, "tier-outflows.json": { placeholder: true } } },
} as unknown as ProjectConfig;

const evmProject = {
  ...base,
  chains: [{ key: "ethereum", name: "Ethereum", vm: "evm", tokens: [] }],
} as unknown as ProjectConfig;

const evmPlaceholderProject = {
  ...evmProject,
  health: { feeds: { "exchange-flow-history.json": { placeholder: true }, "tier-outflows.json": { placeholder: true } } },
} as unknown as ProjectConfig;

const unknownProject = { ...base, chains: [] } as unknown as ProjectConfig;

describe("flowEmptyMessage", () => {
  it("says Solana flows are not tracked for a Solana project whose feed is a placeholder", () => {
    expect(flowEmptyMessage(solanaPlaceholderProject, "exchange")).toBe("Solana flows not tracked yet");
    expect(flowEmptyMessage(solanaPlaceholderProject, "tier")).toBe("Solana flows not tracked yet");
    expect(SOLANA_FLOWS_UNTRACKED).toBe("Solana flows not tracked yet");
  });

  it("keeps plain empty text for a tracked Solana project (real feed, empty window)", () => {
    expect(flowEmptyMessage(solanaProject, "exchange")).toBe("No flow data for this period.");
    expect(flowEmptyMessage(solanaProject, "tier")).toBe("No tier flows for this period yet.");
  });

  it("keeps the existing exchange empty text for EVM and unknown projects", () => {
    expect(flowEmptyMessage(evmProject, "exchange")).toBe("No flow data for this period.");
    expect(flowEmptyMessage(unknownProject, "exchange")).toBe("No flow data for this period.");
  });

  it("keeps the existing tier empty text for EVM and unknown projects", () => {
    expect(flowEmptyMessage(evmProject, "tier")).toBe("No tier flows for this period yet.");
    expect(flowEmptyMessage(unknownProject, "tier")).toBe("No tier flows for this period yet.");
  });

  it("uses the unavailable copy when the project declares the feed a placeholder", () => {
    expect(flowEmptyMessage(evmPlaceholderProject, "exchange")).toBe(
      FLOW_UNAVAILABLE_TEMPLATE.replace("{ticker}", "ZBCN"),
    );
    expect(flowEmptyMessage(evmPlaceholderProject, "tier")).toBe(
      FLOW_UNAVAILABLE_TEMPLATE.replace("{ticker}", "ZBCN"),
    );
  });
});
