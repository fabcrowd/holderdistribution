/** Stablecoin contracts used by Association forensics (Etherscan tokentx). */
export const STABLECOINS_BY_CHAIN = {
  ethereum: [
    { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
  ],
  polygon: [
    { address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", symbol: "USDC.e", decimals: 6 },
    { address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", symbol: "USDC", decimals: 6 },
    { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", symbol: "USDT", decimals: 6 },
  ],
};

export const stablecoinMap = (chainKey) => {
  const map = new Map();
  for (const t of STABLECOINS_BY_CHAIN[chainKey] ?? []) {
    map.set(t.address.toLowerCase(), t);
  }
  return map;
};

export const isStablecoinAddress = (chainKey, address) =>
  stablecoinMap(chainKey).has(address?.toLowerCase?.() ?? "");
