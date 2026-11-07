import { describe, it, expect } from "vitest";
import { buildCutoffs } from "./build-cutoffs.js";
import { midnightSeconds } from "./lib/dayBlocks.js";

describe("build-cutoffs", () => {
  it("fills missing EVM and Solana cutoffs for the date range and keeps existing ones", async () => {
    const files = { };
    const io = { read: (p) => files[p] ?? {}, write: (p, o) => { files[p] = o; } };
    const project = { slug: "tel", dataDir: "public/data" };
    const t0 = midnightSeconds("2026-08-29") - 1800;
    const evmTime = async (b) => t0 + b * 60; // 1-minute blocks
    const solTimes = async (s) => (s % 2 ? null : t0 + s * 30); // odd slots skipped
    let evmCalls = 0;
    const chains = [
      { key: "ethereum", vm: "evm", head: 5000, getTime: async (b) => { evmCalls += 1; return evmTime(b); } },
      { key: "solana", vm: "solana", head: 9000, getTime: solTimes },
    ];
    const map = await buildCutoffs(project, { from: "2026-08-29", to: "2026-08-30", chains, root: "/r", io });
    expect(map.ethereum).toEqual({ "2026-08-29": 30, "2026-08-30": 30 + 1440 });
    expect(map.solana).toEqual({ "2026-08-29": 60, "2026-08-30": 60 + 2880 });
    evmCalls = 0;
    await buildCutoffs(project, { from: "2026-08-29", to: "2026-08-30", chains, root: "/r", io });
    expect(evmCalls).toBe(0);
  });
  it("Solana search starts at the chain's bounded low, never probes below it, and refuses a low past the target", async () => {
    const io = { read: () => ({}), write: () => {} };
    const project = { slug: "x", dataDir: "public/data/x" };
    const t0 = midnightSeconds("2026-08-29") - 1800;
    const probed = [];
    const getTime = async (s) => (probed.push(s), t0 + s * 30);
    const map = await buildCutoffs(project, { from: "2026-08-29", to: "2026-08-29", chains: [{ key: "solana", vm: "solana", head: 9000, low: 40, getTime }], root: "/r", io });
    expect(map.solana).toEqual({ "2026-08-29": 60 });
    expect(Math.min(...probed)).toBeGreaterThanOrEqual(40);
    await expect(buildCutoffs(project, { from: "2026-08-29", to: "2026-08-29", chains: [{ key: "solana", vm: "solana", head: 9000, low: 80, getTime }], root: "/r", io }))
      .rejects.toThrow(/search floor/);
  });
});
