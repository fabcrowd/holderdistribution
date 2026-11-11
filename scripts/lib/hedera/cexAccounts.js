/**
 * Hedera exchange accounts an HBAR project starts with (written once to
 * config/projects/<slug>/cex-wallets.json by onboard.js; that file is the source
 * of truth afterwards). Research and sources: docs/hedera-cex-candidates.md.
 *
 * Owner decisions 2026-11-11: Bybit's proof-of-reserves account, plus the
 * HashPack wallet-support list as a lower-confidence third-party tier, plus
 * 0.0.652978 as a Binance cold wallet (fits Binance's May 2026 PoR HBAR total;
 * no published address). 0.0.640701 (3.14B, unidentified) stays retail.
 */
const POR = "Exchange proof-of-reserves: Bybit PoR report 2026-10-27 (Hacken), verified-wallets row 'Hedera 0.0.615421'.";
const HASHPACK =
  "Third-party, lower confidence: HashPack 'Exchange deposit addresses' (hashpackapp.zendesk.com/hc/en-us/articles/27512469973777), which says it is not proof of current control. Accepted by the owner 2026-11-11.";
const OWNER = "Owner decision 2026-11-11: treated as a Binance cold wallet (Binance May 2026 PoR reported about 2.57B HBAR; no published address). Unverified.";

const rows = [
  ["0.0.615421", "Bybit", "Bybit (PoR)", POR],
  ["0.0.615422", "Bybit", "Bybit", HASHPACK],
  ["0.0.1872300", "Upbit", "Upbit", HASHPACK],
  ["0.0.37073", "Upbit", "Upbit", HASHPACK],
  ["0.0.1268012", "Crypto.com", "Crypto.com", HASHPACK],
  ["0.0.6942669", "Crypto.com", "Crypto.com", HASHPACK],
  ["0.0.611791", "Crypto.com", "Crypto.com", HASHPACK],
  ["0.0.10358775", "Kraken", "Kraken", HASHPACK],
  ["0.0.652978", "Binance", "Binance cold wallet (owner decision)", OWNER],
  ["0.0.1873771", "Binance", "Binance", HASHPACK],
  ["0.0.16852", "Binance", "Binance", HASHPACK],
  ["0.0.16853", "Binance", "Binance", HASHPACK],
  ["0.0.1030878", "Binance", "Binance", HASHPACK],
  ["0.0.858938", "MEXC", "MEXC", HASHPACK],
  ["0.0.29000", "Gate", "Gate", HASHPACK],
  ["0.0.1155594", "Coinbase", "Coinbase", HASHPACK],
  ["0.0.1133968", "Coinbase", "Coinbase", HASHPACK],
  ["0.0.1134089", "Coinbase", "Coinbase", HASHPACK],
  ["0.0.1686714", "KuCoin", "KuCoin", HASHPACK],
  ["0.0.1686716", "KuCoin", "KuCoin", HASHPACK],
  ["0.0.407219", "KuCoin", "KuCoin", HASHPACK],
  ["0.0.15852", "OKX", "OKX", HASHPACK],
  ["0.0.50570", "HTX", "HTX or Binance (sources conflict)", `${HASHPACK} A HashScan staging example labels it Binance Exchange.`],
  ["0.0.50571", "HTX", "HTX", HASHPACK],
];

/** cex-wallets.json content for an HBAR project. */
export const hederaCexWallets = () => ({
  $comment: "HBAR exchange accounts, seeded by scripts/lib/hedera/cexAccounts.js at onboarding. Sources and confidence per row; research in docs/hedera-cex-candidates.md.",
  wallets: rows.map(([address, label, walletName, source]) => ({ address, label, walletName, $comment: source })),
});
