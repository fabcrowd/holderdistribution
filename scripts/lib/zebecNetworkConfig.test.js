import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig, validateProjectConfig, projectRoleAddresses } from "./projects.js";
import { projectHolderTiers } from "./holderTiers.js";
import { PROJECT_SLUGS, LEGACY_ROOT_SLUGS } from "../../netlify/functions/live-data.mjs";

const root = path.resolve(".");
const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const PROGRAM = "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv";
const STAKE_VAULT_ATAS = [
  "3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo",
  "8bbygT4wHaR1vXQMCTK9uVnoDGBwWjNx9BUwjgLtkBvv",
  "7dvTVafoMm52sjyJCHkHZv119MecicqFCrgjq8RcLxJ6",
  "FnJhFWTiYTGSePJDKVNYQgf5XUFBJEk1rvPifj6hvb4Y",
  "BcfMnwQMpv988qVCDMpJhXRyYiqchrYh9pcJPvjEypj4",
];
const REWARD_VAULT_ATAS = ["ErF9raeVUf1H7EgSDuApS1NYhBkAcnnVas9zmEK23sTE", "DGMT79t6tVGPHW8gLH29a6G1W8AnWhc5NzddvHiU9kCy"];
// Owner-approved 2026-10-26 (docs/zbcn-wallet-candidates.md §1).
const TREASURY_VAULTS = [
  "H8Hr964ApEP3ie1rwRTT7wkSrgvUqJQb8oNAKspkDDfR",
  "3J7n5Usmei8BqgUHan5xuBiJkAx6M1AQQhGwbKiVdQ17",
  "71LxiE4PvxdZxLmtGcoKAJEWKofPqYw5Wdn6PSpXHodV",
];
const TEAM_SIGNERS = [
  "9Sq2nZ481aiEkoDB9gavcfD6v7pr4LEcPnUdky4TEine",
  "EsDV3m3xUZ7g8QKa1kFdbZT18nNz8ddGJRcTK84WDQ7k",
  "FNuqKqgJLzJExhZQo1r8ZjQDQRp7hJX2j4bvE2hjcgtM",
  "G82tVZ6eu2YRPfGFFnPYs3qLz8HtAQXnsnmNKpqfMnx7",
  "6enQZWHkQ5ayxyFbJXgrNdUwDZpcUon98SNCuVNSRbd2",
  "8vKiBgHFgR7BTUTwjNXj91P95GrRDCt3xNt6iLgHVMJw",
  "9jRRKgb69WSMRLrqrPsk1byunMhD5tXxixYAdoESHdM3",
];
// Owner excluded these §1 candidates; they must stay out of config.
const EXCLUDED = [
  "GXD2FnXi718y9tPUd6CW1CW6khZ14DGtQc5cBpYkjm5J",
  "43wqg9cUzGW42uLbMEKt3CE4Jzt9dxujrCMjgw7iVr8E",
  "56veXoivcbZNwkN4MCvhdyromDrp6cp9EuJZ9arknGSF",
];

describe("zebec-network config (owner choices 2026-10-25)", () => {
  const c = loadProjectConfig("zebec-network", root);

  it("validates with no errors", () => {
    expect(validateProjectConfig(c).errors).toEqual([]);
  });

  it("is Solana-only, native origin, exact-case mint", () => {
    expect(c.chains.map((x) => x.key)).toEqual(["solana"]);
    const sol = c.chains[0];
    expect(sol).toMatchObject({ vm: "solana", bridge: "native", origin: true });
    expect(sol.tokens).toEqual([expect.objectContaining({ address: MINT, program: "spl-token", decimals: 6, status: "canonical" })]);
  });

  it("supply target 100e9, coingecko zebec-network, not default", () => {
    expect(c.supply.target).toBe(100e9);
    expect(c.gated.walletFlows.coingeckoId).toBe("zebec-network");
    expect(c.default).toBeUndefined();
  });

  it("staking: one zebecStakeV1 entry on the program", () => {
    expect(c.staking).toEqual([expect.objectContaining({ chain: "solana", address: PROGRAM, kind: "zebecStakeV1" })]);
  });

  it("stake + reward vault token accounts are non-retail (role staking)", () => {
    // projectRoleAddresses groups by chain key ({ solana: [{ name, address, role }] }), not by role.
    const staking = (projectRoleAddresses(c).solana ?? []).filter((e) => e.role === "staking").map((e) => e.address);
    for (const a of [...STAKE_VAULT_ATAS, ...REWARD_VAULT_ATAS]) expect(staking).toContain(a);
  });

  it("buyback treasury kept with its annotation; legacy ZBC not mapped", () => {
    const t = c.chains[0].contracts.buybackTreasury;
    expect(t).toMatchObject({ address: "EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW", role: "treasury" });
    expect(t.$comment).toMatch(/G3shxzbgWZFLJZTFdysmsK42MTHrZduFuTxxYqwxtgox/);
    expect(JSON.stringify(c.chains)).not.toContain("zebeczgi5fSEtbpfQKVZKCJ3WgYXxjkMUkNNx7fLKAF");
  });

  it("per-project mega threshold 25B (top ~20.55B wallet stays in totalBalance) and treasury-only history", () => {
    expect(c.holders.megaHolderThreshold).toBe(25e9);
    expect(projectHolderTiers({ config: c }).megaHolderThreshold).toBe(25e9);
    expect(c.treasury.categories).toEqual(["treasury"]);
  });

  it("buyback treasury is non-retail via contracts{} role", () => {
    const sol = projectRoleAddresses(c).solana ?? [];
    expect(sol).toContainEqual(expect.objectContaining({ address: "EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW", role: "treasury" }));
  });

  it("owner-approved treasury vaults (treasury) and team signers (holdings) are non-retail; exclusions stay out", () => {
    const sol = projectRoleAddresses(c).solana ?? [];
    const byRole = (role) => sol.filter((e) => e.role === role).map((e) => e.address);
    for (const a of TREASURY_VAULTS) expect(byRole("treasury")).toContain(a);
    expect(byRole("holdings").sort()).toEqual([...TEAM_SIGNERS].sort());
    const text = JSON.stringify(c);
    for (const a of EXCLUDED) expect(text).not.toContain(a);
    expect(c.pipelineNotes.treasuryTeam).toMatch(/b6ZPysThkApNx2YDiGsPUiYPE7Ub1kTRdCWp7gBkzbr/);
    expect(c.pipelineNotes.treasuryTeam).toMatch(/low for 9jRR/);
  });

  it("live-data serves it from public/data/zebec-network", () => {
    expect(PROJECT_SLUGS.has("zebec-network")).toBe(true);
    expect(LEGACY_ROOT_SLUGS.has("zebec-network")).toBe(false);
  });
});
