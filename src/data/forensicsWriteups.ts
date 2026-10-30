export type WalletAnalysis = {
  address: string;
  title: string;
  classification: string;
  summary: string;
  fundingChain: Array<{
    from: string;
    amountTel: number | null;
    date: string;
    note: string;
  }>;
  counterparties: Array<{
    address: string;
    role: string;
    amountTel: number | null;
  }>;
  controllers: string[];
  evidence: string;
};

export type FlowReportSection = {
  heading: string;
  body: string;
  rows: Array<{ label: string; value: string }>;
};

export type FlowReport = {
  key: string;
  title: string;
  tracedAt: string;
  coverage: string;
  headline: string;
  sections: FlowReportSection[];
};

// Hand-authored forensic write-ups. The Supply page loads this module after
// the local password hash matches. Without a server we can administer, this
// is a UI gate — the chunk is still in the built site.
export const WALLET_ANALYSES: Record<string, WalletAnalysis> = {
  "0x067173cf1a20e1f7a952d3abd15537d86a239924": {
    address: "0x067173cf1a20e1f7a952d3abd15537d86a239924",
    title: "Telcoin Holdings bridge-hub Safe",
    classification: "holdings",
    summary:
      "Ethereum bridge-hub Safe funded from the tagged Telcoin Liquidity Wallet; routes TEL across L2 bridges.",
    fundingChain: [
      {
        from: "0x0ae09ef609567904b483ae74a2117d88a1b1d7d0",
        amountTel: 576000000,
        date: "historical",
        note: "Etherscan-tagged Telcoin: Liquidity Wallet",
      },
    ],
    counterparties: [
      { address: "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf", role: "Polygon bridge path", amountTel: null },
      { address: "0x3154", role: "Base L1 bridge path", amountTel: null },
      { address: "0xa3a7b6f88361f48403514059f1f16c8e78d60eec", role: "Arbitrum gateway path", amountTel: null },
    ],
    controllers: ["3-of-6 including 0x735f779f"],
    evidence: "Explorer label + bridge counterparties. Confirmed Holdings.",
  },
  "0x5dad2cd9195c4954ec13af1f39f9725643d85a05": {
    address: "0x5dad2cd9195c4954ec13af1f39f9725643d85a05",
    title: "Independent large wallet (active trader)",
    classification: "independent",
    summary: "Active DEX trader (~100M across Polygon+Base). No Association or Holdings funding links.",
    fundingChain: [
      {
        from: "mixed DEX / bridge mints",
        amountTel: null,
        date: "2025-03 onward",
        note: "Heavy two-way trading; not project custody",
      },
    ],
    counterparties: [
      { address: "0x39c5c73c", role: "Polygon trading counterparty", amountTel: null },
      { address: "0x498581ff", role: "Base Uniswap V4 Pool Manager", amountTel: null },
    ],
    controllers: [],
    evidence: "On-chain pattern scan 2026-08-08. Confirmed Independent.",
  },
  "0x84b94024463f01d5cbb3086f14f574d7ed83b794": {
    address: "0x84b94024463f01d5cbb3086f14f574d7ed83b794",
    title: "Telcoin Holdings shared Safe (Polygon)",
    classification: "holdings",
    summary: "Gnosis SafeProxy on Polygon holding 275M TEL. 2-of-3 threshold with Holdings controllers as owners.",
    fundingChain: [
      {
        from: "cluster controllers",
        amountTel: 275000000,
        date: "ongoing",
        note: "Safe custody for the 1.13B controller cluster",
      },
    ],
    counterparties: [
      { address: "0xc44784b1ace0830a82ceac529cc98d1b38640413", role: "owner", amountTel: null },
      { address: "0x9f45bccdb42871a955e34d9d5ca33be9ccaef1fd", role: "owner", amountTel: null },
    ],
    controllers: [
      "0xc44784b1ace0830a82ceac529cc98d1b38640413",
      "0xed1e9f76",
      "0x9f45bccdb42871a955e34d9d5ca33be9ccaef1fd",
    ],
    evidence: "RPC getOwners on Polygon + explorer SafeProxy tag. Confirmed Holdings.",
  },
  "0x9756686f71e9a90558c7cfbad89e9fd8007f97e7": {
    address: "0x9756686f71e9a90558c7cfbad89e9fd8007f97e7",
    title: "Telcoin Holdings cold Safe (Base)",
    classification: "holdings",
    summary: "Sibling Base cold Safe — one ~95.9M deposit, zero outflows since Apr 2025.",
    fundingChain: [
      {
        from: "0xab26e45f",
        amountTel: 95874029,
        date: "2025-04-05",
        note: "Single deposit from Safe owner",
      },
    ],
    counterparties: [{ address: "0xab26e45f", role: "owner / funder", amountTel: 95874029 }],
    controllers: ["3-of-6"],
    evidence: "SafeProxy + Blockscout. Confirmed Holdings.",
  },
  "0x9f45bccdb42871a955e34d9d5ca33be9ccaef1fd": {
    address: "0x9f45bccdb42871a955e34d9d5ca33be9ccaef1fd",
    title: "Telcoin Holdings reserve (Ethereum)",
    classification: "holdings",
    summary:
      "Cold reserve holding 599M TEL with a single inflow and zero outflows since Feb 2025. Co-controls the Polygon Holdings Safe.",
    fundingChain: [
      {
        from: "0xc44784b1ace0830a82ceac529cc98d1b38640413",
        amountTel: 599000000,
        date: "2025-02-27",
        note: "Entire balance from sibling Holdings controller",
      },
    ],
    counterparties: [
      { address: "0xc44784b1ace0830a82ceac529cc98d1b38640413", role: "funding source / co-controller", amountTel: 599000000 },
      { address: "0x84b94024463f01d5cbb3086f14f574d7ed83b794", role: "shared Safe controlled (2-of-3)", amountTel: 275000000 },
    ],
    controllers: [
      "0xc44784b1ace0830a82ceac529cc98d1b38640413",
      "0xed1e9f76",
      "0x9f45bccdb42871a955e34d9d5ca33be9ccaef1fd",
    ],
    evidence: "Signer-graph + Blockscout tokentx 2026-08-08. Confirmed Holdings.",
  },
  "0xa9781d19e5611f65908dd6818fc1c276e2c6ac44": {
    address: "0xa9781d19e5611f65908dd6818fc1c276e2c6ac44",
    title: "Telcoin Holdings cold Safe (Base)",
    classification: "holdings",
    summary: "Dormant Base cold Safe — one ~98.1M deposit, zero outflows since Apr 2025.",
    fundingChain: [
      {
        from: "0x4562b9d6",
        amountTel: 98142782,
        date: "2025-04-05",
        note: "Single deposit from Safe owner",
      },
    ],
    counterparties: [{ address: "0x4562b9d6", role: "owner / funder", amountTel: 98142782 }],
    controllers: ["3-of-6"],
    evidence: "SafeProxy + Blockscout. Confirmed Holdings.",
  },
  "0xbc0e35ee613940bf54dc24934376cc04dda1bc6b": {
    address: "0xbc0e35ee613940bf54dc24934376cc04dda1bc6b",
    title: "Large personal wallet (temporary Other)",
    classification: "retail-temp",
    summary: "KuCoin withdraw + MetaMask swap pattern. Temporary Other until full holders scrape moves it to Retail.",
    fundingChain: [
      {
        from: "0x58edf782",
        amountTel: null,
        date: "recent",
        note: "KuCoin 20 tagged withdraw",
      },
    ],
    counterparties: [
      { address: "0x58edf782", role: "KuCoin 20", amountTel: null },
      { address: "0x74de5d4f", role: "MetaMask Swaps Spender", amountTel: null },
    ],
    controllers: [],
    evidence: "Explorer labels. Confirmed retail pattern.",
  },
  "0xc44784b1ace0830a82ceac529cc98d1b38640413": {
    address: "0xc44784b1ace0830a82ceac529cc98d1b38640413",
    title: "Telcoin Holdings controller (Polygon)",
    classification: "holdings",
    summary: "Controller wallet for the Holdings shared Safe. Bridged ~282M to Polygon; sent 599M to the Ethereum reserve.",
    fundingChain: [
      {
        from: "0x0000000000000000000000000000000000000000",
        amountTel: 282427397,
        date: "2026-07-06",
        note: "Polygon bridge mint (from Ethereum)",
      },
    ],
    counterparties: [
      { address: "0x9f45bccdb42871a955e34d9d5ca33be9ccaef1fd", role: "599M outbound to reserve", amountTel: 599000000 },
      { address: "0x84b94024463f01d5cbb3086f14f574d7ed83b794", role: "Safe owner", amountTel: null },
    ],
    controllers: ["self — owner of 0x84b94024"],
    evidence: "Bridge mint + signer-graph. Confirmed Holdings.",
  },
  "0xcf6994abe437e67b331cd2513f47773cd91244d2": {
    address: "0xcf6994abe437e67b331cd2513f47773cd91244d2",
    title: "Telcoin Holdings ops Safe (Base)",
    classification: "holdings",
    summary: "Active Base ops Safe (~200M after 100M bridge-out). Funds Base cold Safes network.",
    fundingChain: [
      {
        from: "0xac2016cc",
        amountTel: 299888223,
        date: "2025-04-05 / 2025-08-16",
        note: "Controller deposits totaling ~300M",
      },
    ],
    counterparties: [
      { address: "0x0000000000000000000000000000000000000000", role: "100M bridge-out burn", amountTel: 100000000 },
      { address: "0xa9781d19e5611f65908dd6818fc1c276e2c6ac44", role: "related Base cold Safe", amountTel: 98142782 },
      { address: "0x9756686f71e9a90558c7cfbad89e9fd8007f97e7", role: "related Base cold Safe", amountTel: 95874029 },
    ],
    controllers: ["3-of-6 including 0xac2016cc"],
    evidence: "Safe owners + Blockscout funding. Confirmed Holdings.",
  },
  "0xe482aed4c5faec57084762b22a09ac0156c582b6": {
    address: "0xe482aed4c5faec57084762b22a09ac0156c582b6",
    title: "Independent large wallet (cold storage)",
    classification: "independent",
    summary: "Classic retail cold storage: test send then 12M deposit; dormant since Sept 2025.",
    fundingChain: [
      {
        from: "0x9832b551",
        amountTel: 12021454,
        date: "2025-09-28",
        note: "Test 1k then full deposit; unlabeled personal source",
      },
    ],
    counterparties: [{ address: "0x9832b551", role: "sole funder", amountTel: 12021454 }],
    controllers: [],
    evidence: "On-chain pattern. Confirmed Independent.",
  },
};

/**
 * A multi-wallet flow narrative, as opposed to the single-address write-ups
 * above. Loaded by the Supply page after the local password hash matches.
 *
 * Traced 2026-08-30 against live chain data (Blockscout Ethereum + Polygon,
 * decoded event logs, Safe getOwners()). Base is NOT covered — Blockscout's
 * Base instance was returning 500s, matching the same gap already noted in
 * data/association-payment-mapping.md.
 */
export const ASSOCIATION_FLOW_REPORT_KEY = "association-stablecoin-flows";

export const ASSOCIATION_STABLECOIN_FLOWS: FlowReport = {
  key: ASSOCIATION_FLOW_REPORT_KEY,
  title: "Association stablecoin outflows — forensic reconciliation",
  tracedAt: "2026-08-30",
  coverage:
    "Ethereum + Polygon, full USDC/USDT/DAI history through 2026-08-28. Base not covered (explorer outage).",
  headline:
    "Association Safes fund a TA-managed EOA (the 'TA Sale Wallet') that sells TEL for USDC and makes the payments on their behalf — so these are Association payments, executed one hop out. The money ends up at regulated venues: Coinbase Prime, Coinbase, Bybit and Uphold. No link to any Telcoin Holdings Safe was found.",
  sections: [
    {
      heading: "1. How the payments are initiated",
      body: "The Association Safes do not send stablecoins themselves — but they are the origin of these payments. They send TEL to [0x11cb903d…](0x11cb903d2f797d4410fd5e65ba9aa641a0741fc3), an EOA on both Ethereum and Polygon (confirmed on-chain: not a contract, not a Safe) that community sources identify as the TA Sale Wallet, managed by the Association to handle bridging, swapping and payments on its behalf. That wallet sells the TEL for USDC and makes the payouts. So every payment below is an Association payment; the Safe-to-EOA step is mechanics, not a change of ownership. Worth flagging on its own: an EOA is controlled by a single private key, with none of the multisig approval the Association Safes themselves require. All 15 labelled Association addresses (TEL Treasury, TAO Safe, TAO Distribution, the Councils, Validator/Staker/Developer Safes) were checked for USDC, bridged USDC.e, USDT and DAI on both chains. Every one returns zero transfers. The single exception is the TAO Implementation Wallet, which passed $18,810.68 straight through in March 2025 (in and out the same day, same amount) and has been idle in stablecoins since. The Association's own multisigs operate purely in TEL.",
      rows: [],
    },
    {
      heading: "1b. What the Safes actually send, and where it lands",
      body: "Tracing TEL directly out of all 15 Association addresses: about 11.3B TEL leaves the Safes gross, but most is not spending. 5,000,001,000 TEL sits in custody the Association still owns (2.50B Anchorage, 2.50B BitGo via a relay). Roughly 3.48B is internal circulation — bridged Ethereum to Polygon through relay wallets and returned to TAO Safe, TELx Council, TAO Distribution and Platform Council. The largest genuine outflow is 1,260,714,642 TEL from TAO Safe and TAO Distribution into the Settlement hub, which routes to KuCoin. About 246.8M goes to users as rewards via TANIssuanceHistory (87,559,688) and TELx PositionRegistry plus StakingRewards contracts (~159.0M). The remainder, roughly 300M, is sold on the open market through CoW Swap, 1inch and KyberSwap. Note the TA Sale Wallet is predominantly a bridge, not a sales desk: 100% of its Ethereum-side TEL is bridged onward, and on Polygon 79% of what leaves it (1,619,900,646 TEL) goes straight back to Association Safes, with only about 11% sold.",
      rows: [
        { label: "Custody, still Association-owned (Anchorage + BitGo)", value: "5,000,001,000 TEL" },
        { label: "Internal circulation, returns to Association Safes", value: "~3,480,000,000 TEL" },
        { label: "Sold via Settlement hub → KuCoin", value: "1,260,714,642 TEL" },
        { label: "Sold on open market (CoW / 1inch / KyberSwap)", value: "~300,000,000 TEL" },
        { label: "Rewards to TAN users and TELx LPs", value: "~246,800,000 TEL" },
        { label: "TA Sale Wallet TEL returned to Association Safes", value: "1,619,900,646 TEL (79% of its outflow)" },
      ],
    },
    {
      heading: "2. Where the stablecoins actually come from",
      body: "Two wallets, already named in data/association-payment-mapping.md as TEL destinations, are the entire stablecoin engine. 'Recipient' ([0xE71e5BB3…](0xe71e5bb31d76be3a4a840e1781a4b49645079105|polygon), a 1-of-1 Safe on Polygon) sells TEL for USDC on CoW Swap continuously — 206 trades since 2026-03-30 totalling $432,326.02, the most recent two days before this trace. It forwards the proceeds to 'Conduit' ([0x11cb903d…](0x11cb903d2f797d4410fd5e65ba9aa641a0741fc3)) in 8 lump transfers of $321,169.55. Conduit also sells TEL directly through 1inch, KyberSwap and CoW. Conduit then bridges its USDC from Polygon to itself on Ethereum using Circle's official CCTP — 27 burns totalling $1,085,006.36, confirmed by decoding the DepositForBurn events (same address on both sides). Payouts happen on the Ethereum side.",
      rows: [
        { label: "Recipient: TEL sold for USDC on CoW Swap", value: "$432,326.02 over 206 trades" },
        { label: "Recipient → Conduit", value: "$321,169.55 over 8 transfers" },
        { label: "Conduit: bridged Polygon → Ethereum (Circle CCTP)", value: "$1,085,006.36 over 27 burns" },
      ],
    },
    {
      heading: "3. Ties to Telcoin Holdings Safes — none found",
      body: "This was tested two independent ways and failed both. First, flow: all 262 distinct counterparties across the traced wallets were cross-referenced against the known-address sets — config/exclusions.json (all 7 Holdings Safes and both escrow custodians) and the full 27,240-wallet Dune-synced CEX list. No Holdings Safe, and no escrow custodian, appears anywhere in the flow. (The CEX list does match — see section 5 — but no Holdings entity does.) Second, ownership: Safe signers were read on-chain with getOwners(). The six Association Safes share a tight cluster of 7 signers (four of them sit on all six). The Holdings Safes have 27 signers. The overlap between the two sets is empty, and the main payout destination shares no signer with either. Separately, the Holdings Safes were checked directly for stablecoin activity and are effectively clean — only the Holdings controller shows minor USDC (7 transfers, largest $6,104.60), unconnected to this flow.",
      rows: [
        { label: "Counterparties matching a known Holdings/CEX/escrow address", value: "0 of 262" },
        { label: "Signers shared between Association and Holdings Safes", value: "0" },
        { label: "Signers shared between payout destination and either", value: "0" },
      ],
    },
    {
      heading: "4. The largest destination is a payment processor, not a person",
      body: "The biggest recurring destination is a 2-of-7 Gnosis Safe ([0x3dcb7cfb…](0x3dcb7cfbb431a11cabb6f7f2296e2354f488efc2)) that received $627,639.98 from Conduit across 15 payments since May 2025. On its own, that looks like a large private beneficiary. It is not. That Safe handles $21.5M in from 244 different senders and $22.5M out to 1,341 distinct payees, with 99 of them on recurring schedules, and it cashes out through a Circle deposit contract (CircleDeposit1, $1,401,000). Conduit ranks only 11th among its funders and accounts for 1.8% of its inflow. The shape — many-to-many, high frequency, recurring, fiat off-ramp — is a payroll or mass-payout service that Telcoin-linked funds are one client of.",
      rows: [
        { label: "Destination Safe throughput", value: "$21.5M in / $22.5M out" },
        { label: "Senders in / payees out", value: "244 / 1,341 (99 recurring)" },
        { label: "Conduit's share of its inflow", value: "1.8% (ranked #11)" },
      ],
    },
    {
      heading: "5. Recurring amounts and payment patterns",
      body: "Several genuinely recurring amounts stand out. Exactly $150,000.00 was paid three times — 2025-12-05, 2026-01-21 and 2026-05-11 — each time to a different, freshly-used address rather than a repeat payee. $100,000.00 went twice to the destination Safe. Three payees look like fixed retainers: $10,000.00 exactly three times (Jun/Jul/Aug 2026), $1,500.00 exactly three times, and roughly $1,000 ten times running monthly from Dec 2025 to Aug 2026. One payee receives about $4,000 every month with a slow downward drift, consistent with a fixed amount denominated in another currency. A distinct operator habit also shows up: a $10 test transfer is sent first, then the real amount minutes later — 8 confirmed occurrences, including all three $150,000 payments (sent as $10 + $149,990).",
      rows: [
        { label: "$150,000.00 exactly", value: "3 times, each to a different fresh address" },
        { label: "$100,000.00 exactly", value: "2 times, to the destination Safe" },
        { label: "$10,000.00 / $1,500.00 exactly", value: "3 times each — retainer-shaped" },
        { label: "~$1,000 monthly", value: "10 payments, Dec 2025 – Aug 2026" },
        { label: "$10 test-then-pay protocol", value: "8 confirmed occurrences" },
      ],
    },
    {
      heading: "6. Security finding — active address-poisoning campaign",
      body: "Grouping every counterparty by matching first-four and last-four hex characters exposed 115 lookalike addresses across 24 clusters. Every significant real payee has its own swarm of impostors — the destination Safe has 9, one payee has 17. The lookalikes only ever send zero-value or sub-cent dust transfers, which is the signature of address-poisoning: the fake address is injected into the wallet's transaction history so an operator copying an address from history pays the attacker instead. The good news is that no funds have been lost — every transfer to or from a lookalike is $0.00 or dust, and no real payment has ever landed on one. The risk is live though, and the $10 test-transfer habit above is the single control most likely to keep catching it.",
      rows: [
        { label: "Lookalike addresses detected", value: "115 across 24 clusters" },
        { label: "Funds lost to poisoning so far", value: "$0.00 — none" },
      ],
    },
    {
      heading: "5b. Where the money actually ends up",
      body: "Following the payouts to their terminal points, the destinations are regulated venues rather than anonymous wallets. The three $150,000 payments flow to an aggregating address that passes 100% of its volume — $79.5M lifetime — into Coinbase Prime, Coinbase's institutional custody and brokerage arm. The large payout Safe is itself funded primarily from Coinbase Prime ($2.19M), Coinbase ($1.50M) and Bybit ($201K), which is consistent with it being a payment/payroll operator that tops up from exchanges and then distributes. Separately, Uphold sent $153,000.46 into the TA Sale Wallet across 3 transfers — an inbound funding source, not an outflow. Note this corrects an earlier pass that reported no exchange links: that check used only the 139 labelled addresses in exclusions.json rather than the full 27,240-wallet CEX list.",
      rows: [
        { label: "$150k payments → aggregator → Coinbase Prime", value: "$79.5M lifetime through that aggregator" },
        { label: "Payout Safe funded by Coinbase Prime", value: "$2,194,281.45 over 29 transfers" },
        { label: "Payout Safe funded by Coinbase", value: "$1,503,782.50 over 20 transfers" },
        { label: "Payout Safe funded by Bybit", value: "$201,122.92 over 5 transfers" },
        { label: "Uphold → TA Sale Wallet (inbound)", value: "$153,000.46 over 3 transfers" },
      ],
    },
    {
      heading: "7. Caveats and open items",
      body: "Base is not covered — Blockscout's Base API was down during this trace and no Etherscan/Alchemy key was available as a fallback, so any Base-side stablecoin activity is invisible here. The destination Safe's history was pulled to a 4,000-transfer cap, covering 2025-08-01 onward; its lifetime totals are therefore floors, not exact. One earlier hypothesis was checked and discarded: a contract that appeared to pay both Conduit and the Holdings controller turned out to be a KyberSwap aggregator executor, i.e. shared public DEX infrastructure and not evidence of any relationship. Finally, neither Conduit nor Recipient appears in config/exclusions.json, so both are still counted as ordinary retail holders on the live site — the same unresolved classification issue already logged in data/association-payment-mapping.md.",
      rows: [],
    },
  ],
};

