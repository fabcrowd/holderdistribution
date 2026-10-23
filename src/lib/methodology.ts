/**
 * Per-section methodology copy for the "how this works / verify on-chain"
 * hover cards. Everything shown on the site is reconstructed from public
 * on-chain data, so each section links to where a skeptic can check it
 * themselves on a block explorer.
 */
import { legacyTokenUrl, v3TokenUrl } from "@/lib/telContracts";

export type MethodologyLink = { label: string; href: string };
export type Methodology = { how: string; verify: string; links: MethodologyLink[] };

// Legacy TEL token contracts (2 decimals) on each chain, on their explorers.
// The holder pipeline tracks BOTH these and upgraded TEL v3 (18 decimals, one
// address on every chain) and sums them per wallet — see src/lib/telContracts.ts.
const TEL_ETH = legacyTokenUrl("ethereum");
const TEL_POLYGON = legacyTokenUrl("polygon");
const TEL_BASE = legacyTokenUrl("base");
const STAKING = "https://polygonscan.com/address/0x92e43Aec69207755CB1E6A8Dc589aAE630476330";
const DEX_TEL_USDC = "https://polygonscan.com/address/0xa5cabfc725dfa129f618d527e93702d10412f039";
const DEX_TEL_WPOL = "https://polygonscan.com/address/0x9b5c71936670e9f1f36e63f03384de7e06e60d2a";

const TEL_TOKENS: MethodologyLink[] = [
  { label: "TEL on Etherscan", href: TEL_ETH },
  { label: "TEL on Polygonscan", href: TEL_POLYGON },
  { label: "TEL on Basescan", href: TEL_BASE },
  { label: "TEL v3 (upgraded) on Etherscan", href: v3TokenUrl("ethereum") },
];

const TREASURY_ETHERSCAN = `${TEL_ETH}?a=0x2580ccb2be946ad98effa7f4b76148bed319011c`;

export const METHODOLOGY: Record<string, Methodology> = {
  circulatingSupply: {
    how: "This box shows CoinGecko's reported circulating supply (~95.08B), not a figure we compute. It is not a different accounting method — it's a frozen snapshot. The main treasury wallet held exactly 4,922,764,633 TEL immediately after sending 2.5B to Anchorage Digital Vault on 2025-10-01; CoinGecko's implied non-circulating amount (100B minus their reported figure) is 4,922,763,633 — within 1,000 TEL, the size of a routine test transfer that precedes it. CoinGecko read that balance once around that date and has not updated it since. Every treasury transaction after 2025-10-01 — including the escrow funding into BitGo a month later, and payouts down to treasury's actual balance today — is invisible to their number. The Tokenomics page's Supply Breakdown reconstructs circulating supply directly from on-chain balances instead.",
    verify: "Open the treasury wallet on Etherscan and read its Transfer history: the balance right after its 2025-10-01 transfer to Anchorage Digital Vault matches CoinGecko's implied carve-out to within 1,000 TEL.",
    links: [{ label: "Treasury wallet (Etherscan)", href: TREASURY_ETHERSCAN }],
  },
  holderSnapshot: {
    how: "Every wallet's TEL balance is reconstructed from the token's on-chain Transfer event logs on Ethereum, Polygon and Base — read directly from full nodes, the same ledger the block explorers use — then staking is added from the Polygon staking contract. A holder is any wallet with a non-zero balance, with no minimum applied: that includes roughly 9,500 wallets holding less than 1 TEL each (a few thousand TEL between all of them). They are counted in the headline and in the smallest distribution tier alike, so every holder count on this page reconciles to the same total. A wallet's balance is its legacy TEL (2 decimals) plus its upgraded TEL v3 (18 decimals, 0x7E13…0731 on every chain), each read with its own decimals. Telcoin's official upgrade swaps legacy for v3 1:1: the upgrade contract locks the legacy TEL and mints the same amount of v3 to the holder, so the locked legacy TEL is left out and the v3 is counted instead — nothing is counted twice, and the total stays 100B.",
    verify: "Open the TEL token contract on any explorer and check the Holders tab, or look up any single wallet's TEL balance directly.",
    links: [...TEL_TOKENS, { label: "Staking contract", href: STAKING }],
  },
  balanceInsights: {
    how: "Average, median, percentiles and the Gini coefficient are computed over the reconstructed on-chain balances of retail wallets (exchange & hot wallets excluded).",
    verify: "Balances come straight from the TEL token contract — spot-check any wallet's holdings on the explorer.",
    links: TEL_TOKENS,
  },
  concentration: {
    how: "Retail wallets are ranked by balance and the top-N cohorts' combined holdings summed. Exchange & hot wallets are excluded so a custody pool is never counted as a whale.",
    verify: "The token's Holders tab on the explorer lists every wallet by balance, largest first.",
    links: TEL_TOKENS,
  },
  holderMomentum: {
    how: "Holder counts and first-time wallets are derived from weekly on-chain snapshots of every wallet holding >0 TEL.",
    verify: "The Holders count on the token contract page reflects the same on-chain set.",
    links: TEL_TOKENS,
  },
  staking: {
    how: "Staked balances are read directly from the Telcoin staking contract on Polygon and mapped back to each staker's wallet.",
    verify: "Open the staking contract on Polygonscan to inspect staked positions and transactions.",
    links: [{ label: "Staking contract", href: STAKING }, { label: "TEL on Polygonscan", href: TEL_POLYGON }],
  },
  overlap: {
    how: "Wallets that hold TEL on more than one chain are matched by address across the per-chain snapshots.",
    verify: "Look up the same wallet address on each chain's explorer to see its balance on each.",
    links: TEL_TOKENS,
  },
  cexFlows: {
    how: "Deposits to and withdrawals from known exchange hot wallets are counted directly from TEL Transfer logs. Trading happens off-chain in the exchange's private ledger, so this shows supply moving toward/away from the market — not realized sales. CEX Balance history is also aligned when wallets are re-labelled (e.g. KuCoin vaults moved into the exchange set): that step is a classification change, not an inflow, and prior days are backfilled so YTD deltas do not treat the re-label as new deposits.",
    verify: "Every exchange wallet is a real on-chain address (expand a row to see them); all transfers to and from it are public on the explorer. Measured netflow below is the on-chain deposit/withdrawal truth when a balance chart step looks like a labelling cliff.",
    links: TEL_TOKENS,
  },
  distribution: {
    how: "Retail wallets are bucketed by balance range (exchange & hot wallets excluded). Tier movement tracks the SAME wallet across weekly snapshots, and each outgoing transfer is classified from the Transfer logs: into a DEX pool as a swap = sold, into a pool as liquidity provision = added to LP (not a sale), to an exchange wallet = deposit, to another wallet = moved/split. Incoming transfers reverse those labels (bought / unstaked from LP / from exchange / from wallet).",
    verify: "Balances and every transfer are public on the TEL token contract; the DEX pool and exchange addresses used are themselves on-chain and linkable.",
    links: [{ label: "TEL on Polygonscan", href: TEL_POLYGON }, { label: "TEL/USDC pool", href: DEX_TEL_USDC }],
  },
  dexSwaps: {
    how: "Swaps are counted from TEL Transfer logs into and out of on-chain DEX liquidity pools (QuickSwap, Uniswap). TEL sent into a pool is swapped for another coin (a sale); TEL sent out is a buy. Liquidity provision (adding/removing LP) is tracked separately from swaps — depositing TEL into a pool is not a sale, and withdrawing LP is not a buy.",
    verify: "Open a pool contract on the explorer to see its TEL transfers in and out — each swap is a public transaction.",
    links: [{ label: "TEL/USDC pool", href: DEX_TEL_USDC }, { label: "TEL/WPOL pool", href: DEX_TEL_WPOL }, { label: "TEL on Polygonscan", href: TEL_POLYGON }],
  },
  supplyBreakdown: {
    how: "Total supply is always 100B (the legacy TEL contract on Ethereum, where all of it was minted). Since the TEL v3 upgrade every balance is legacy TEL plus v3 TEL, and the legacy TEL locked in Telcoin's upgrade contract in exchange for minted v3 is left out so it is never counted twice (legacy supply − locked-for-v3 + v3 supply − bridge-locked mirrors = 100B; scripts/verify-tel-supply.js re-derives this from the chains). We split it into simple base-layer buckets anyone can read — retail wallets, DEX liquidity, exchange custody, escrow, Telcoin Association-Controlled Safes (treasury + council/ops), Telcoin Holdings (confirmed Holdings wallets), Other, and In transit (bridges) — so the pieces add to 100B. In transit is mostly TEL locked on Ethereum while it shows up on Polygon or Base — not missing wallets. Circulating excludes treasury + council, plus the escrow that's contractually committed back to treasury under a SAFE (traced on-chain to Telcoin Association funding — see data/escrow-safe-provenance.md; the Escrow detail shows the current split); the rest of escrow stays circulating. CoinGecko’s ~95B is the main treasury wallet's on-chain balance right after its 2025-10-01 transfer to Anchorage, never refreshed since — not a different methodology, just a frozen snapshot (see the Circulating Supply info icon on the home page for the full trace). Click Association, Holdings, Other, or In transit for address-level drill-down. Wallets with an Analysis badge expose a gated deep dive (funding chain, counterparties, controllers) unlocked for admin accounts. After wallet labels change (especially retail vs excluded), run a full holders scrape so Retail, history, transitions, and supply reconciliation stay consistent — incremental scans alone are not enough. Temporary Other detail tags like “large personal wallet” are not the permanent Retail home until that full scrape.",
    verify: "Base layer: the chart and bucket list. Power users can click Association, Holdings, Other, or In transit for address lists, bridge math, and explorer links. Identity notes: data/other-address-identity.md and data/holdings-wallet-analysis.md.",
    links: [
      ...TEL_TOKENS,
      { label: "Staking contract", href: STAKING },
      { label: "Balancer Vault (Polygon)", href: "https://polygonscan.com/address/0xba12222222228d8ba445958a75a0704d566bf2c8" },
      { label: "TEL/USDC pool", href: DEX_TEL_USDC },
    ],
  },
};
