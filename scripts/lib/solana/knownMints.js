/**
 * Mints whose USD value the Solana journals can state directly. Addresses are
 * base58 and case-sensitive: always compared exactly as given, never folded.
 */
export const STABLE_MINTS = Object.freeze({
  USDC: Object.freeze({ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 }),
  USDT: Object.freeze({ mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 }),
});

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const WSOL_DECIMALS = 9;

/** @returns {"USDC" | "USDT" | "SOL" | null} */
export function symbolOf(mint) {
  if (mint === WSOL_MINT) return "SOL";
  for (const [symbol, { mint: stableMint }] of Object.entries(STABLE_MINTS)) {
    if (stableMint === mint) return symbol;
  }
  return null;
}

/** Decimals for mints this module knows, else null. */
export function knownDecimalsOf(mint) {
  if (mint === WSOL_MINT) return WSOL_DECIMALS;
  const symbol = symbolOf(mint);
  return symbol === null ? null : STABLE_MINTS[symbol].decimals;
}
