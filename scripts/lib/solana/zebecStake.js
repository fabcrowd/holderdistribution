/**
 * Zebec SuperApp staking (Anchor program zebec_stake; IDL from
 * @zebec-network/zebec-stake-sdk@1.3.5). staking[].kind = "zebecStakeV1".
 * Imported only by scripts/pull-solana-staking.js for a project whose
 * staking[] lists this kind, so EVM-only projects never load it.
 *
 * Positions = every UserStakeData with stake_claimed == false, summed per
 * staker. Each lockup's sum is reconciled against its stake-vault token
 * account (ATA of PDA ["stake_vault", lockup]); a gap above
 * STAKE_VAULT_TOLERANCE throws rather than publishing a partial staked total,
 * except for lockups in STAKE_VAULT_GAP_EXEMPTIONS: those publish position sums
 * as-is (never scaled to the vault) and record the gap + an explainer instead.
 */
import { base58Decode, base58Encode } from "../address.js";
import { findProgramAddress } from "./pda.js";
import { PROGRAM_BY_NAME, rawToNumber } from "./metadata.js";

export const ZEBEC_STAKE_V1_PROGRAM = "zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const LOCKUP_DISCRIMINATOR = Uint8Array.of(1, 45, 32, 32, 57, 81, 88, 67);
export const USER_STAKE_DATA_DISCRIMINATOR = Uint8Array.of(105, 207, 3, 141, 114, 114, 232, 147);
export const USER_STAKE_DATA_MIN_SIZE = 113;
export const USER_STAKE_LOCKUP_OFFSET = 81;
export const STAKE_VAULT_TOLERANCE = 0.005;

/**
 * Lockups whose positions-vs-vault gap is a known on-chain property, not a
 * decode error (owner decision 2026-10-25: exception + explainer). Keyed by
 * exact base58 lockup address. Every other lockup keeps the per-lockup guard.
 */
export const STAKE_VAULT_GAP_EXEMPTIONS = Object.freeze({
  AYbW5cbZEUgLEj6Eiy3yg74PU3YbEHkbFxgW6fjbSJjp: { label: "ZBCN Lockup" },
});

export function vaultGapExplainer({ activeRaw, vaultRaw, ratio }) {
  const pct = (ratio * 100).toFixed(2);
  const side =
    activeRaw > vaultRaw
      ? "unclaimed positions sum to more than the stake-vault token account (ATA) currently holds"
      : "the stake-vault token account (ATA) holds more than the unclaimed positions sum to";
  return (
    `On-chain, this lockup's ${side} (gap ${pct}%). Staked figures are the raw sum of every ` +
    `unclaimed UserStakeData position, published as-is and not scaled to the vault balance; ` +
    `the vault ATA balance is shown alongside for transparency.`
  );
}

const hasDisc = (buf, disc) => buf.length >= 8 && disc.every((b, i) => buf[i] === b);
const pubkeyAt = (buf, off) => base58Encode(new Uint8Array(buf.subarray(off, off + 32)));
const fromBase64Account = (account) => Buffer.from(account?.data?.[0] ?? "", "base64");

export function decodeUserStakeData(buf) {
  if (!hasDisc(buf, USER_STAKE_DATA_DISCRIMINATOR)) throw new Error("not a UserStakeData account");
  if (buf.length < USER_STAKE_DATA_MIN_SIZE) throw new Error(`UserStakeData too short: ${buf.length} bytes`);
  return {
    nonce: buf.readBigUInt64LE(8),
    createdTime: Number(buf.readBigInt64LE(16)),
    stakedRaw: buf.readBigUInt64LE(24),
    rewardRaw: buf.readBigUInt64LE(32),
    claimed: buf[40] === 1,
    lockPeriod: Number(buf.readBigInt64LE(41)),
    staker: pubkeyAt(buf, 49),
    lockup: pubkeyAt(buf, USER_STAKE_LOCKUP_OFFSET),
  };
}

export function decodeLockup(buf) {
  if (!hasDisc(buf, LOCKUP_DISCRIMINATOR)) throw new Error("not a Lockup account");
  let o = 8;
  const nameLen = buf.readUInt32LE(o);
  o += 4;
  const name = buf.subarray(o, o + nameLen).toString("utf8");
  o += nameLen;
  const creator = pubkeyAt(buf, o);
  o += 32;
  const minimumStake = buf.readBigUInt64LE(o);
  o += 8;
  const mapLen = buf.readUInt32LE(o);
  o += 4;
  const durations = [];
  for (let i = 0; i < mapLen; i++) {
    durations.push({ duration: Number(buf.readBigUInt64LE(o)), reward: Number(buf.readBigUInt64LE(o + 8)) });
    o += 16;
  }
  const rewardToken = pubkeyAt(buf, o);
  o += 32;
  const stakedToken = pubkeyAt(buf, o);
  o += 32;
  const totalStakedRaw = buf.readBigUInt64LE(o);
  o += 8;
  const fee = buf.readBigUInt64LE(o);
  o += 8;
  const feeVault = pubkeyAt(buf, o);
  return { name, creator, minimumStake, durations, rewardToken, stakedToken, totalStakedRaw, fee, feeVault };
}

export function stakeVaultPda(lockup, programId = ZEBEC_STAKE_V1_PROGRAM) {
  return findProgramAddress([Buffer.from("stake_vault"), base58Decode(lockup)], programId)[0];
}

export function associatedTokenAddress(owner, mint, tokenProgramId = PROGRAM_BY_NAME["spl-token"]) {
  return findProgramAddress([base58Decode(owner), base58Decode(tokenProgramId), base58Decode(mint)], ASSOCIATED_TOKEN_PROGRAM)[0];
}

const gpa = (call, programId, filters) =>
  call("getProgramAccounts", [programId, { encoding: "base64", commitment: "finalized", filters }]);

export async function fetchZebecStakePositions(
  call,
  { programId = ZEBEC_STAKE_V1_PROGRAM, mint, decimals, logger = console, vaultGapExemptions = STAKE_VAULT_GAP_EXEMPTIONS },
) {
  const lockupRows = await gpa(call, programId, [{ memcmp: { offset: 0, bytes: base58Encode(LOCKUP_DISCRIMINATOR) } }]);
  const lockups = [];
  for (const r of lockupRows ?? []) {
    let l;
    try {
      l = decodeLockup(fromBase64Account(r.account));
    } catch (err) {
      logger.warn?.(`  zebecStakeV1: skipping lockup ${r.pubkey}: ${err.message}`);
      continue;
    }
    if (l.stakedToken !== mint) continue;
    const stakeVault = stakeVaultPda(r.pubkey, programId);
    lockups.push({ address: r.pubkey, name: l.name, totalStakedRaw: l.totalStakedRaw, stakeVault, stakeVaultAta: associatedTokenAddress(stakeVault, mint) });
  }

  const perStaker = new Map();
  let positionCount = 0;
  let stakedRaw = 0n;
  for (const lk of lockups) {
    const rows = await gpa(call, programId, [
      { memcmp: { offset: 0, bytes: base58Encode(USER_STAKE_DATA_DISCRIMINATOR) } },
      { memcmp: { offset: USER_STAKE_LOCKUP_OFFSET, bytes: lk.address } },
    ]);
    let active = 0n;
    for (const r of rows ?? []) {
      const p = decodeUserStakeData(fromBase64Account(r.account));
      if (p.claimed || p.stakedRaw === 0n) continue;
      perStaker.set(p.staker, (perStaker.get(p.staker) ?? 0n) + p.stakedRaw);
      active += p.stakedRaw;
      positionCount += 1;
    }
    lk.activeRaw = active;
    lk.vaultRaw = null;
    lk.vaultGap = null;
    if (active > 0n) {
      const bal = await call("getTokenAccountBalance", [lk.stakeVaultAta, { commitment: "finalized" }]);
      lk.vaultRaw = BigInt(bal?.value?.amount ?? "0");
      const gap = lk.vaultRaw > active ? lk.vaultRaw - active : active - lk.vaultRaw;
      const ratio = lk.vaultRaw > 0n ? Number(gap) / Number(lk.vaultRaw) : 1;
      if (ratio > STAKE_VAULT_TOLERANCE && Object.hasOwn(vaultGapExemptions, lk.address)) {
        lk.vaultGap = {
          vaultGapRaw: (active - lk.vaultRaw).toString(),
          vaultGapRatio: ratio,
          vaultReconcile: "exempt",
          explainer: vaultGapExplainer({ activeRaw: active, vaultRaw: lk.vaultRaw, ratio }),
        };
        logger.warn?.(
          `  zebecStakeV1: lockup ${lk.address} (${lk.name}) vault gap ${(ratio * 100).toFixed(2)}% exempt; publishing positions as-is.`,
        );
      } else if (ratio > STAKE_VAULT_TOLERANCE) {
        throw new Error(
          `zebecStakeV1 lockup ${lk.address} (${lk.name}): vault ${lk.stakeVaultAta} holds ${lk.vaultRaw} raw but active ` +
            `positions sum ${active} raw; they disagree by ${(ratio * 100).toFixed(2)}%, refusing to publish.`,
        );
      }
    }
    stakedRaw += active;
  }

  const positions = [...perStaker.entries()]
    .map(([staker, raw]) => ({ staker, raw: raw.toString(), amount: rawToNumber(raw, decimals) }))
    .sort((a, b) => (BigInt(b.raw) > BigInt(a.raw) ? 1 : BigInt(b.raw) < BigInt(a.raw) ? -1 : 0));

  return {
    programId,
    mint,
    lockups: lockups.map((l) => ({
      address: l.address,
      name: l.name,
      stakeVault: l.stakeVault,
      stakeVaultAta: l.stakeVaultAta,
      activeRaw: l.activeRaw.toString(),
      vaultRaw: l.vaultRaw === null ? null : l.vaultRaw.toString(),
      totalStakedRaw: l.totalStakedRaw.toString(),
      vaultReconcile: l.vaultGap ? "exempt" : l.vaultRaw === null ? "skipped-empty" : "ok",
      ...(l.vaultGap
        ? { vaultGapRaw: l.vaultGap.vaultGapRaw, vaultGapRatio: l.vaultGap.vaultGapRatio, explainer: l.vaultGap.explainer }
        : {}),
    })),
    positions,
    stakerCount: positions.length,
    positionCount,
    stakedRaw: stakedRaw.toString(),
    stakedTotal: rawToNumber(stakedRaw, decimals),
  };
}
