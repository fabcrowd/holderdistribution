import { normalizeAnyAddress } from "./address.js";
// Sanity bound: the derived total must stay near the token's declared max supply.
// If the assertion fires, the scan is incomplete or a bridge/mirror assumption has
// changed — fail loudly rather than publish a wrong denominator.
export const EXPECTED_MAX_SUPPLY = 100_000_000_000;
export const SUPPLY_TOLERANCE = 0.02; // 2%
// v3 minted vs legacy retired should match to the token (v3 only enters through a
// swap or a bridge mint paired with a burn). In-flight bridging is tiny; 0.01% of
// supply (10M TEL) flags a real accounting break without crying wolf.
export const V3_RESIDUAL_TOLERANCE = 0.0001;

/**
 * TEL v3 (see scripts/lib/telTokens.js): total TEL is still 100B, but it now
 * exists in two representations. Wallet balances are `legacy + v3` (each in its
 * own decimals) with the legacy TEL held by the upgrade contracts in exchange for
 * minted v3 NETTED OUT, so nothing swapped is counted twice. The identities:
 *
 *   totalSupply      = legacy token supply on the origin chain (Ethereum, 100B —
 *                      the whole of TEL was minted there; every other balance is
 *                      a mirror of it or a 1:1 re-issue of it as v3)
 *   perChain[c]      = Σ wallets (legacy_c − retired_c + v3_c)
 *   mirrored         = Σ perChain over non-origin chains
 *   byChain          = { origin: totalSupply − mirrored, others: perChain }  (sums to totalSupply)
 *   mirrorResidual   = Σ mirror-chain LEGACY supply − bridgeLocked          (bridge backing)
 *   v3Residual       = Σ v3 supply − Σ retired legacy                       (≈ 0; v3 in flight)
 *   crossCheckTotal  = Σ perChain − bridgeLocked
 *                    = totalSupply + mirrorResidual + v3Residual
 *
 * `crossCheckTotal` is the INDEPENDENT proof that the three chains' combined
 * balances (legacy + v3) land on 100B: it does not use the origin-chain shortcut.
 *
 * Without `tokenTotals` (legacy-only data, or a pre-v3 snapshot) every v3/retired
 * term is zero and this reduces to the original origin-chain derivation.
 *
 * Derive total supply from the ORIGIN chain, never by summing chains.
 *
 * TEL is minted on Ethereum. Polygon and Base balances are bridged MIRRORS of
 * TEL locked in Ethereum bridge contracts, so adding all three double-counts
 * every bridged token — that inflated apparent supply from ~100B to ~142B, and
 * put a 37B bridge contract at the top of the holder list.
 *
 * Expressed as a decomposition — origin minus the mirrors, then the mirrors
 * re-added — this is algebraically just the origin-chain total, but it also
 * yields a per-chain breakdown whose parts sum to the true total. Same identity
 * supabase/functions/fetch-tel-data/index.ts already uses for the Token page.
 *
 * Deliberately NOT "sum the chains, then subtract known bridge contracts":
 * identified bridge locks currently fall ~3.6B short of the mirrored supply, so
 * subtraction depends on a bridge registry we cannot prove complete. The
 * shortfall is reported as `mirrorResidual` so it stays visible instead of
 * being silently absorbed.
 *
 * The previous implementation hardcoded totalSupply as 92_577_234_366 — uncited,
 * never re-verified, and ~7.4B below both CoinGecko's reported total supply and
 * our own origin-chain sum, making every "% of supply" figure too large.
 *
 * @param {{wallets: Array<Record<string, number|string>>}} output snapshot under construction
 * @param {Record<string, {origin?: boolean}>} chainConfig config/chains.json
 * @param {Set<string>} bridgeLockSet addresses labelled `bridge-lock` in config/exclusions.json
 * @param {{warn?: Function, log?: Function}} logger injectable for tests
 * @param {Record<string, {legacy:number, v3:number, retiredLegacy:number, strandedInUpgrade?:number}>|null} tokenTotals
 *   per-chain token totals from the scan (see telTokens.combineChainBalances)
 * @param {{expectedMaxSupply?: number}} [options] the project's `supply.target`
 *   (default EXPECTED_MAX_SUPPLY = TEL's 100B)
 */
export const computeSupplyTotals = (
  output,
  chainConfig,
  bridgeLockSet = new Set(),
  logger = console,
  tokenTotals = null,
  { expectedMaxSupply = EXPECTED_MAX_SUPPLY } = {}
) => {
  const originKey = Object.keys(chainConfig).find((key) => chainConfig[key]?.origin);
  if (!originKey) {
    throw new Error(
      'No origin chain configured. Mark the chain TEL is minted on with "origin": true in config/chains.json.'
    );
  }
  const mirrorKeys = Object.keys(chainConfig).filter((key) => key !== originKey);

  const sumChain = (key) =>
    output.wallets.reduce((acc, wallet) => acc + (Number(wallet[`${key}_balance`]) || 0), 0);

  const perChain = Object.fromEntries(Object.keys(chainConfig).map((key) => [key, sumChain(key)]));
  const mirrored = mirrorKeys.reduce((acc, key) => acc + perChain[key], 0);

  const tokenOf = (key) => tokenTotals?.[key] ?? null;
  // Legacy supply per chain as scanned (INCLUDES legacy later retired into v3).
  // Falls back to the wallet sum when the scan supplied no per-token totals —
  // the pre-v3 case, where the two are the same number.
  const legacySupply = Object.fromEntries(
    Object.keys(chainConfig).map((key) => [key, Number(tokenOf(key)?.legacy ?? perChain[key]) || 0])
  );
  const v3Supply = Object.fromEntries(
    Object.keys(chainConfig).map((key) => [key, Number(tokenOf(key)?.v3) || 0])
  );
  const retiredLegacy = Object.fromEntries(
    Object.keys(chainConfig).map((key) => [key, Number(tokenOf(key)?.retiredLegacy) || 0])
  );
  const strandedInUpgrade = Object.fromEntries(
    Object.keys(chainConfig).map((key) => [key, Number(tokenOf(key)?.strandedInUpgrade) || 0])
  );
  const sumOver = (map, keys = Object.keys(chainConfig)) => keys.reduce((acc, key) => acc + map[key], 0);

  const totalSupply = legacySupply[originKey];

  // What the origin chain holds that is NOT backing a mirrored token.
  const originCirculating = totalSupply - mirrored;

  // Mirrored supply should be backed 1:1 by TEL locked in bridge contracts on the
  // origin chain. A shortfall means a bridge address we haven't labelled, or supply
  // minted natively on a mirror chain. Surface it, don't hide it.
  // Bridge locks hold LEGACY TEL only (v3 crosses chains by burn-and-mint, so
  // there is nothing to lock); subtract any stray v3 so the lock stays pure legacy.
  const bridgeLocked = output.wallets.reduce(
    (acc, wallet) =>
      bridgeLockSet.has(String(wallet.address).toLowerCase())
        ? acc + (Number(wallet[`${originKey}_balance`]) || 0) - (Number(wallet[`${originKey}_v3`]) || 0)
        : acc,
    0
  );
  // Backing test: the LEGACY supply on the mirror chains (gross — including what
  // was retired into v3, whose legacy backing is still locked on the origin).
  const mirroredLegacy = sumOver(legacySupply, mirrorKeys);
  const mirrorResidual = mirroredLegacy - bridgeLocked;
  const v3Residual = sumOver(v3Supply) - sumOver(retiredLegacy);
  const crossCheckTotal = sumOver(perChain) - bridgeLocked;

  if (Math.abs(totalSupply - expectedMaxSupply) > expectedMaxSupply * SUPPLY_TOLERANCE) {
    throw new Error(
      `Derived total supply ${Math.round(totalSupply).toLocaleString()} is more than ` +
        `${SUPPLY_TOLERANCE * 100}% from the expected max supply ` +
        `${expectedMaxSupply.toLocaleString()}. Refusing to publish a wrong denominator.`
    );
  }
  if (Math.abs(mirrorResidual) > totalSupply * 0.01) {
    logger.warn?.(
      `WARNING: ${Math.round(mirrorResidual).toLocaleString()} TEL of mirrored supply on ` +
        `[${mirrorKeys.join(", ")}] is not backed by a labelled bridge-lock address on ${originKey}. ` +
        `Likely an unlabelled bridge contract in config/exclusions.json.`
    );
  }

  if (Math.abs(v3Residual) > totalSupply * V3_RESIDUAL_TOLERANCE) {
    logger.warn?.(
      `WARNING: v3 supply ${Math.round(sumOver(v3Supply)).toLocaleString()} and legacy TEL retired into v3 ` +
        `${Math.round(sumOver(retiredLegacy)).toLocaleString()} differ by ${Math.round(v3Residual).toLocaleString()} TEL ` +
        `(> ${V3_RESIDUAL_TOLERANCE * 100}% of supply). v3 minted without a matching legacy swap, or a swap the scan missed — ` +
        `the upgrade-contract netting no longer reconciles.`
    );
  }

  logger.log?.(
    `Supply: ${Math.round(totalSupply).toLocaleString()} TEL ` +
      `(origin=${originKey}; ${Math.round(mirrored).toLocaleString()} mirrored on ${mirrorKeys.join("+")})` +
      (sumOver(v3Supply) > 0
        ? `; cross-check Σchains−bridge = ${Math.round(crossCheckTotal).toLocaleString()} ` +
          `(v3 ${Math.round(sumOver(v3Supply)).toLocaleString()}, retired legacy ${Math.round(sumOver(retiredLegacy)).toLocaleString()})`
        : "")
  );

  return {
    totalSupply,
    originChain: originKey,
    // Parts sum to totalSupply — safe to display as a per-chain breakdown.
    byChain: {
      [originKey]: originCirculating,
      ...Object.fromEntries(mirrorKeys.map((key) => [key, perChain[key]])),
    },
    bridgeLocked,
    mirrorResidual,
    v3Residual,
    crossCheckTotal,
    // Per-token ledger behind the numbers above. All zero for v3 before the
    // upgrade; `retiredLegacy` is legacy TEL held by the upgrade contracts in
    // exchange for minted v3 (excluded from balances), `strandedInUpgrade` is
    // legacy sent there WITHOUT a swap (still counted, once, on the contract).
    tokens: {
      legacy: legacySupply,
      v3: v3Supply,
      retiredLegacy,
      strandedInUpgrade,
    },
  };
};

// ---------------------------------------------------------------------------
// Generic bridge netting (docs/superpowers/specs/2026-10-25-wrapped-bridged-tokens-design.md).
// One project total, CoinGecko style, driven by chains[].bridge:
//   native | burn-mint  -> the chain's supply is real and unique: SUMMED
//   lock-mint           -> a mirror backed by locks on the origin: adds 0
// TEL never takes this path (supply.generationsSumOneToOne keeps
// computeSupplyTotals above, byte-identical).
// ---------------------------------------------------------------------------

export const BACKING_RESIDUAL_TOLERANCE = 0.01; // 1% of total, same as TEL's mirrorResidual warning

/** "tel-generations" when supply.generationsSumOneToOne is set, else "bridge-netting". */
export const selectSupplyMethod = (projectConfig) =>
  projectConfig?.supply?.generationsSumOneToOne === true ? "tel-generations" : "bridge-netting";

const bridgeModeOf = (key, c) => {
  const mode = c?.bridge ?? "native";
  if (!["native", "lock-mint", "burn-mint"].includes(mode)) throw new Error(`chain ${key}: unknown bridge mode ${JSON.stringify(mode)}`);
  return mode;
};

/**
 * @param {{wallets: Array<Record<string, number|string>>}} output snapshot under construction
 * @param {Record<string, {origin?: boolean, bridge?: string}>} chainConfig chain map (every vm)
 * @param {Set<string>} lockSet origin-chain bridge/escrow addresses (normalized: hex lowercased, base58 as-is)
 * @param {{warn?: Function, log?: Function}} logger
 * @param {Record<string, {legacy?: number, v3?: number}>|null} tokenTotals per-chain token supply from the scan
 * @param {{target?: number|null, tolerance?: number, symbol?: string}} [options]
 */
export const computeBridgeNettedSupply = (
  output,
  chainConfig,
  lockSet = new Set(),
  logger = console,
  tokenTotals = null,
  { target = null, tolerance = SUPPLY_TOLERANCE, symbol = "tokens" } = {}
) => {
  const keys = Object.keys(chainConfig);
  if (keys.length === 0) throw new Error("No chains configured.");
  const originKey = keys.find((key) => chainConfig[key]?.origin) ?? null;
  const modes = Object.fromEntries(keys.map((key) => [key, key === originKey ? "origin" : bridgeModeOf(key, chainConfig[key])]));
  const lockMintKeys = keys.filter((key) => modes[key] === "lock-mint");
  if (lockMintKeys.length && !originKey) {
    throw new Error(`Chains [${lockMintKeys.join(", ")}] use bridge "lock-mint" but no chain is marked origin: true.`);
  }
  const summedKeys = keys.filter((key) => modes[key] === "native" || modes[key] === "burn-mint");

  const perChain = Object.fromEntries(
    keys.map((key) => [key, output.wallets.reduce((acc, w) => acc + (Number(w[`${key}_balance`]) || 0), 0)])
  );
  const supplyOf = (key) => {
    const t = tokenTotals?.[key];
    if (t && (t.legacy !== undefined || t.v3 !== undefined)) return (Number(t.legacy) || 0) + (Number(t.v3) || 0);
    return perChain[key];
  };
  const supply = Object.fromEntries(keys.map((key) => [key, supplyOf(key)]));
  const sum = (list, map) => list.reduce((acc, key) => acc + map[key], 0);

  const originSupply = originKey ? supply[originKey] : 0;
  const totalSupply = originSupply + sum(summedKeys, supply);

  const lockedOnOrigin = originKey
    ? output.wallets.reduce(
        (acc, w) => (lockSet.has(normalizeAnyAddress(w.address))
          ? acc + (Number(w[`${originKey}_balance`]) || 0)
          : acc),
        0
      )
    : 0;
  const mirroredLockMint = sum(lockMintKeys, supply);
  const mirroredHeld = sum(lockMintKeys, perChain);
  // Only lock-mint mirrors are backed by origin locks; with none, the lock
  // balance is still non-circulating but there is nothing to back.
  const backingResidual = lockMintKeys.length ? mirroredLockMint - lockedOnOrigin : 0;
  const nonCirculating = lockedOnOrigin;
  const circulatingSupply = totalSupply - nonCirculating;

  // Parts sum to totalSupply: origin minus what its mirrors hold, mirrors as
  // held, summed chains at their supply.
  const byChain = {};
  for (const key of keys) {
    if (key === originKey) byChain[key] = originSupply - mirroredHeld;
    else if (modes[key] === "lock-mint") byChain[key] = perChain[key];
    else byChain[key] = supply[key];
  }

  if (target && Math.abs(totalSupply - target) > target * tolerance) {
    throw new Error(
      `Derived total supply ${Math.round(totalSupply).toLocaleString()} is more than ${tolerance * 100}% from ` +
        `supply.target ${Number(target).toLocaleString()}. Refusing to publish a wrong denominator.`
    );
  }
  if (lockMintKeys.length && Math.abs(backingResidual) > totalSupply * BACKING_RESIDUAL_TOLERANCE) {
    logger.warn?.(
      `WARNING: ${Math.round(backingResidual).toLocaleString()} ${symbol} of lock-mint supply on [${lockMintKeys.join(", ")}] ` +
        `is not backed by a labelled bridge/escrow address on ${originKey}. Likely an unlabelled bridge contract, ` +
        `or a mint that is really native (set bridge: "native" or "burn-mint").`
    );
  }
  logger.log?.(
    `Supply (bridge netting): ${Math.round(totalSupply).toLocaleString()} ${symbol} = ` +
      [originKey ? `${originKey} ${Math.round(originSupply).toLocaleString()} (origin)` : null,
        ...summedKeys.map((k) => `${k} ${Math.round(supply[k]).toLocaleString()} (${modes[k]})`)]
        .filter(Boolean).join(" + ") +
      (lockMintKeys.length ? `; lock-mint [${lockMintKeys.join(", ")}] add 0, ${Math.round(lockedOnOrigin).toLocaleString()} locked` : "")
  );

  return {
    method: "bridge-netting",
    totalSupply,
    circulatingSupply,
    nonCirculating,
    originChain: originKey,
    byChain,
    bridgeModes: modes,
    bridgeLocked: lockedOnOrigin,
    lockAddresses: [...lockSet].sort(),
    // Generalized mirrorResidual: Σ lock-mint supply − Σ origin lock balances.
    mirrorResidual: backingResidual,
    backingResidual,
    v3Residual: 0,
    // Independent of the supply calls: every holder balance, minus the origin
    // locks that back the lock-mint mirrors (≈ totalSupply when complete).
    crossCheckTotal: sum(keys, perChain) - lockedOnOrigin,
    tokens: {
      legacy: Object.fromEntries(keys.map((key) => [key, Number(tokenTotals?.[key]?.legacy ?? perChain[key]) || 0])),
      v3: Object.fromEntries(keys.map((key) => [key, Number(tokenTotals?.[key]?.v3) || 0])),
      retiredLegacy: Object.fromEntries(keys.map((key) => [key, 0])),
      strandedInUpgrade: Object.fromEntries(keys.map((key) => [key, 0])),
    },
  };
};
