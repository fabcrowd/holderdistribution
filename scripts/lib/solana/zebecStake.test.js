import { describe, expect, it, vi } from "vitest";
import { base58Decode, base58Encode } from "../address.js";
import {
  LOCKUP_DISCRIMINATOR,
  STAKE_VAULT_GAP_EXEMPTIONS,
  USER_STAKE_DATA_DISCRIMINATOR,
  ZEBEC_STAKE_V1_PROGRAM,
  associatedTokenAddress,
  decodeLockup,
  decodeUserStakeData,
  fetchZebecStakePositions,
  stakeVaultPda,
} from "./zebecStake.js";

const MINT = "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU";
const LOCKUP_003 = "6ucsPuczmg9uoq5i4SYDEEJ4ciKnuxW3za2sdBcKHwmw";
const ZBCN_LOCKUP = "AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp";
const ALICE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BOB = "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar";
const silent = { log: vi.fn(), warn: vi.fn() };

const u64 = (v) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(v); return x; };
const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v); return x; };

const userStake = ({ staker, lockup, staked, claimed = false }) => {
  const b = Buffer.alloc(113);
  Buffer.from(USER_STAKE_DATA_DISCRIMINATOR).copy(b, 0);
  b.writeBigUInt64LE(1n, 8);
  b.writeBigInt64LE(1767225600n, 16);
  b.writeBigUInt64LE(staked, 24);
  b.writeBigUInt64LE(0n, 32);
  b[40] = claimed ? 1 : 0;
  b.writeBigInt64LE(7776000n, 41);
  Buffer.from(base58Decode(staker)).copy(b, 49);
  Buffer.from(base58Decode(lockup)).copy(b, 81);
  return b;
};

const lockupAcc = ({ name, stakedToken, totalStaked }) => {
  const nameBuf = Buffer.from(name, "utf8");
  return Buffer.concat([
    Buffer.from(LOCKUP_DISCRIMINATOR),
    u32(nameBuf.length), nameBuf,
    Buffer.from(base58Decode(ALICE)),      // creator
    u64(1000000n),                          // minimum_stake
    u32(1), u64(7776000n), u64(5n),         // duration_map: [{7776000, 5}]
    Buffer.from(base58Decode(stakedToken)), // reward_token
    Buffer.from(base58Decode(stakedToken)), // staked_token.token_address
    u64(totalStaked),                       // staked_token.total_staked
    u64(0n),                                // fee
    Buffer.from(base58Decode(BOB)),         // fee_vault
  ]);
};

const row = (pubkey, buf) => ({ pubkey, account: { data: [buf.toString("base64"), "base64"] } });

describe("zebecStakeV1 decoding", () => {
  it("decodes UserStakeData at the IDL offsets", () => {
    const d = decodeUserStakeData(userStake({ staker: ALICE, lockup: LOCKUP_003, staked: 2_500_000_000_000n }));
    expect(d).toMatchObject({ staker: ALICE, lockup: LOCKUP_003, stakedRaw: 2_500_000_000_000n, claimed: false, lockPeriod: 7776000 });
  });

  it("rejects a wrong discriminator", () => {
    const b = userStake({ staker: ALICE, lockup: LOCKUP_003, staked: 1n });
    b[0] = 0;
    expect(() => decodeUserStakeData(b)).toThrow(/not a UserStakeData/);
  });

  it("decodes a Lockup (variable-length name + duration map)", () => {
    const l = decodeLockup(lockupAcc({ name: "ZBCN_Lockup_003", stakedToken: MINT, totalStaked: 42n }));
    expect(l).toMatchObject({ name: "ZBCN_Lockup_003", stakedToken: MINT, totalStakedRaw: 42n, feeVault: BOB });
    expect(l.durations).toEqual([{ duration: 7776000, reward: 5 }]);
  });
});

describe("zebecStakeV1 PDAs (verified against the mainnet research brief)", () => {
  it("stake vault PDA and its ZBCN ATA for ZBCN_Lockup_003", () => {
    const vault = stakeVaultPda(LOCKUP_003);
    expect(vault).toBe("HJqK7re4GDSm4roQQS2iSLt5p7Gyb9MHBy9dHJw9obUp");
    expect(associatedTokenAddress(vault, MINT)).toBe("3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo");
  });
});

describe("fetchZebecStakePositions", () => {
  const vaultAta = "3DC8cdCNKEZPapuPHTtkuw8XgbDtYarJojjpGgtF65Vo";
  const makeCall = (vaultAmount, lockup = LOCKUP_003) =>
    vi.fn(async (method, params) => {
      if (method === "getProgramAccounts") {
        const filters = params[1].filters;
        const disc = filters.find((f) => f.memcmp?.offset === 0).memcmp.bytes;
        if (disc === base58Encode(LOCKUP_DISCRIMINATOR)) {
          return [
            row(lockup, lockupAcc({ name: "ZBCN_Lockup_003", stakedToken: MINT, totalStaked: 3_000_000n })),
            row(BOB, lockupAcc({ name: "other-mint", stakedToken: ALICE, totalStaked: 9n })), // different staked token: ignored
          ];
        }
        expect(filters.find((f) => f.memcmp?.offset === 81).memcmp.bytes).toBe(lockup);
        return [
          row("p1", userStake({ staker: ALICE, lockup, staked: 2_000_000n })),
          row("p2", userStake({ staker: ALICE, lockup, staked: 500_000n })),
          row("p3", userStake({ staker: BOB, lockup, staked: 500_000n })),
          row("p4", userStake({ staker: BOB, lockup, staked: 9_999_999n, claimed: true })), // unstaked: excluded
        ];
      }
      if (method === "getTokenAccountBalance") {
        expect(params[0]).toBe(associatedTokenAddress(stakeVaultPda(lockup), MINT));
        return { value: { amount: String(vaultAmount) } };
      }
      throw new Error(`unexpected ${method}`);
    });

  it("sums active (unclaimed) positions per staker, case-exact, reconciled with the vault", async () => {
    const r = await fetchZebecStakePositions(makeCall(3_000_000n), { programId: ZEBEC_STAKE_V1_PROGRAM, mint: MINT, decimals: 6, logger: silent });
    expect(r.positions).toEqual([
      { staker: ALICE, raw: "2500000", amount: 2.5 },
      { staker: BOB, raw: "500000", amount: 0.5 },
    ]);
    expect(r).toMatchObject({ stakerCount: 2, positionCount: 3, stakedRaw: "3000000", stakedTotal: 3 });
    expect(r.lockups).toEqual([expect.objectContaining({ address: LOCKUP_003, stakeVaultAta: vaultAta, activeRaw: "3000000", vaultRaw: "3000000" })]);
  });

  it("throws when positions and the vault disagree by more than 0.5%", async () => {
    await expect(
      fetchZebecStakePositions(makeCall(4_000_000n), { programId: ZEBEC_STAKE_V1_PROGRAM, mint: MINT, decimals: 6, logger: silent }),
    ).rejects.toThrow(/disagree/);
  });

  it("exempts only the ZBCN Lockup by exact address", () => {
    expect(Object.keys(STAKE_VAULT_GAP_EXEMPTIONS)).toEqual([ZBCN_LOCKUP]);
  });

  it("exempt lockup: same gap does not throw, records gap + explainer, publishes positions unscaled", async () => {
    // Without the exemption this exact setup throws (see the non-exempt case below).
    await expect(
      fetchZebecStakePositions(makeCall(2_900_000n, ZBCN_LOCKUP), { programId: ZEBEC_STAKE_V1_PROGRAM, mint: MINT, decimals: 6, logger: silent, vaultGapExemptions: {} }),
    ).rejects.toThrow(/disagree/);
    const r = await fetchZebecStakePositions(makeCall(2_900_000n, ZBCN_LOCKUP), { programId: ZEBEC_STAKE_V1_PROGRAM, mint: MINT, decimals: 6, logger: silent });
    expect(r).toMatchObject({ stakedRaw: "3000000", stakedTotal: 3, stakerCount: 2 });
    const lk = r.lockups[0];
    expect(lk).toMatchObject({ address: ZBCN_LOCKUP, activeRaw: "3000000", vaultRaw: "2900000", vaultReconcile: "exempt", vaultGapRaw: "100000" });
    expect(lk.vaultGapRatio).toBeCloseTo(100000 / 2900000, 10);
    expect(lk.explainer).toMatch(/unclaimed positions/);
    expect(lk.explainer).toMatch(/not scaled/);
  });

  it("non-exempt lockup with the same gap still throws", async () => {
    await expect(
      fetchZebecStakePositions(makeCall(2_900_000n), { programId: ZEBEC_STAKE_V1_PROGRAM, mint: MINT, decimals: 6, logger: silent }),
    ).rejects.toThrow(/disagree/);
  });

  it("reconciled lockup is marked ok without gap fields", async () => {
    const r = await fetchZebecStakePositions(makeCall(3_000_000n), { programId: ZEBEC_STAKE_V1_PROGRAM, mint: MINT, decimals: 6, logger: silent });
    expect(r.lockups[0].vaultReconcile).toBe("ok");
    expect(r.lockups[0]).not.toHaveProperty("explainer");
  });
});
