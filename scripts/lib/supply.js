// Sanity bound: the derived total must stay near the token's declared max supply.
// If the assertion fires, the scan is incomplete or a bridge/mirror assumption has
// changed — fail loudly rather than publish a wrong denominator.
export const EXPECTED_MAX_SUPPLY = 100_000_000_000;
export const SUPPLY_TOLERANCE = 0.02; // 2%

/**
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
 */
export const computeSupplyTotals = (output, chainConfig, bridgeLockSet = new Set(), logger = console) => {
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
  const totalSupply = perChain[originKey];

  // What the origin chain holds that is NOT backing a mirrored token.
  const originCirculating = totalSupply - mirrored;

  // Mirrored supply should be backed 1:1 by TEL locked in bridge contracts on the
  // origin chain. A shortfall means a bridge address we haven't labelled, or supply
  // minted natively on a mirror chain. Surface it, don't hide it.
  const bridgeLocked = output.wallets.reduce(
    (acc, wallet) =>
      bridgeLockSet.has(String(wallet.address).toLowerCase())
        ? acc + (Number(wallet[`${originKey}_balance`]) || 0)
        : acc,
    0
  );
  const mirrorResidual = mirrored - bridgeLocked;

  if (Math.abs(totalSupply - EXPECTED_MAX_SUPPLY) > EXPECTED_MAX_SUPPLY * SUPPLY_TOLERANCE) {
    throw new Error(
      `Derived total supply ${Math.round(totalSupply).toLocaleString()} is more than ` +
        `${SUPPLY_TOLERANCE * 100}% from the expected max supply ` +
        `${EXPECTED_MAX_SUPPLY.toLocaleString()}. Refusing to publish a wrong denominator.`
    );
  }
  if (Math.abs(mirrorResidual) > totalSupply * 0.01) {
    logger.warn?.(
      `WARNING: ${Math.round(mirrorResidual).toLocaleString()} TEL of mirrored supply on ` +
        `[${mirrorKeys.join(", ")}] is not backed by a labelled bridge-lock address on ${originKey}. ` +
        `Likely an unlabelled bridge contract in config/exclusions.json.`
    );
  }

  logger.log?.(
    `Supply: ${Math.round(totalSupply).toLocaleString()} TEL ` +
      `(origin=${originKey}; ${Math.round(mirrored).toLocaleString()} mirrored on ${mirrorKeys.join("+")})`
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
  };
};
