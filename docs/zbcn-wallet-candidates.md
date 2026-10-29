# ZBCN — named + developer wallet candidates (Phase 4b)

**Status (2026-10-28): two Solscan-labeled CEX wallets auto-applied** under the director explorer-confirmed auto-apply rule (no second review). Added to `config/projects/zebec-network/cex-wallets.json` (`classification.cexWallets`, now **46** wallets):

| address | label / walletName | proof |
|---|---|---|
| `7Ci23i82UMa8RpfVbdMjTytiDi2VoZS8uLyHhZBV2Qy7` | Poloniex Hot Wallet | https://solscan.io/account/7Ci23i82UMa8RpfVbdMjTytiDi2VoZS8uLyHhZBV2Qy7 |
| `9CKnC2kmqG9ZBtQXDfxR5H7Av7X878geV367DdYtybT4` | FalconX Hot Wallet | https://solscan.io/account/9CKnC2kmqG9ZBtQXDfxR5H7Av7X878geV367DdYtybT4 |

`pipeline.duneCexQueryId` is still unset.

**Status (2026-10-28): leftover owner YES — APPLIED.** Five cex rows and one holdings row. Research is on each `$comment`, in `pipelineNotes.cexWallets` / `pipelineNotes.leftoverClassification`, and in the Supply section (`supply.holdings.description`, `supply.cex.description`, `methodology.supplyBreakdown`). `cex-wallets.json` is now **51** wallets. Staking math is unchanged. `duneCexQueryId` stays unset.

| address | role | walletName / contract | confidence | research |
|---|---|---|---|---|
| `8gQjn3qPAcKXpDpcGSLKXetTSG4zFgeWcAVnNAy9ru2f` | **APPLIED** cex | Uphold custody (Fireblocks) · Uphold/Fireblocks cluster 8gQjn | medium-high | [Solscan](https://solscan.io/account/8gQjn3qPAcKXpDpcGSLKXetTSG4zFgeWcAVnNAy9ru2f) · [Uphold Fireblocks custody](https://uphold.com/en-us/legal/platform-risk-statement-canada) · [buyback program](https://zebec.io/blog/inside-the-zbcn-buyback-program) · [Uphold is a top holder](https://alphagrowth.io/spaces/zebec-x-uphold-countdown-to-tip-off) |
| `J8FNbQnRGmgHaPrmUsjJ7sdM7gaJVbcvEfYGCmVs69bE` | **APPLIED** cex | Uphold custody (Fireblocks) · Uphold/Fireblocks cluster J8FN | medium-high | [Solscan](https://solscan.io/account/J8FNbQnRGmgHaPrmUsjJ7sdM7gaJVbcvEfYGCmVs69bE) · [Uphold Fireblocks custody](https://uphold.com/en-us/legal/platform-risk-statement-canada) · [buyback program](https://zebec.io/blog/inside-the-zbcn-buyback-program) |
| `82P4QkJ3rdXVeEduue29H19EHvuQG1r2dA4ndup1Ahya` | **APPLIED** cex | Uphold custody (Fireblocks) · Uphold/Fireblocks cluster 82P4 | medium-high | [Solscan](https://solscan.io/account/82P4QkJ3rdXVeEduue29H19EHvuQG1r2dA4ndup1Ahya) · sent ZBCN to Uphold Hot Wallet 3 · [Uphold Fireblocks custody](https://uphold.com/en-us/legal/platform-risk-statement-canada) |
| `6XHzigwW96CXM98L19CMfphFfnW1e7Yn9JLFjtkdoGLh` | **APPLIED** cex | Uphold custody (Fireblocks) · Uphold/Fireblocks cluster 6XHz | medium-high | [Solscan](https://solscan.io/account/6XHzigwW96CXM98L19CMfphFfnW1e7Yn9JLFjtkdoGLh) (exact base58) · [Uphold Fireblocks custody](https://uphold.com/en-us/legal/platform-risk-statement-canada) · [buyback program](https://zebec.io/blog/inside-the-zbcn-buyback-program) |
| `Eueeb9FKXpk7duw7jKeYm1NNWmTeFN7fGKYMmasY7C9x` | **APPLIED** cex | Poloniex custody · Squad Vault SOL-P (Poloniex) | high on-chain / low off-chain | [Solscan](https://solscan.io/account/Eueeb9FKXpk7duw7jKeYm1NNWmTeFN7fGKYMmasY7C9x) · [ZBCN/USDT](https://www.poloniex.com/trade/ZBCN_USDT) · [Messari listing history](https://messari.io/project/zebec/markets) · [Blockworks TTF](https://blockworks.com/token-transparency/filing/zebec-network) |
| `56veXoivcbZNwkN4MCvhdyromDrp6cp9EuJZ9arknGSF` | **APPLIED** holdings, **not Team** | `contracts.allocation56veX` | medium | [Solscan](https://solscan.io/account/56veXoivcbZNwkN4MCvhdyromDrp6cp9EuJZ9arknGSF) · [tokenomics blog](https://zebec.io/blog/zebec-network-zbcn-tokenomics) · [docs](https://docs.zebec.io/zebec-protocol/tokenomics) · [Blockworks TTF](https://blockworks.com/token-transparency/filing/zebec-network) |

Uphold caveat (same handling as Hot Wallet 3/5 — footnote only, no wallet-level split): a buyback subset of ~545M (504.7M as of Jul 2026 plus 40.54M in the Q3 post) may sit inside the omnibus Fireblocks/Uphold wallets and stays cex. A Figment/Uphold webinar says assets never leave Fireblocks custody. Most disclosed buybacks did not go straight to Uphold: EkXEg sent ~437M to team ops 9Sq2 in four transfers (Jul 2025–Jan 2026); EkXEg still holds ~108.26M. A partial 9Sq2 scan (Sep 2025–Oct 2026) found no direct transfers to this cluster or to Eueeb. MiCA white paper (Oct 2026): unlocks ended Mar 2026; buybacks are held with institutional custodians (plural). 56veX is the 40M/month stream from 9Sq2 that continues past that vesting end; the recipient is unknown.

Not added: gas station `EbsUZEFAU23Z2SgAymFtU2hADLiyNLzaPLKiJfvpKnE7` (0 ZBCN, flow tracking only). Unlabeled `8HdkaV…` (~166M from 9Sq2) stays retail — full address not applied. CsF6fs, 2Ejnns, the rest of §5, and governance `7ngHDD5` / `F6VVzy` stay retail until an escrow bucket exists.

**Excluded — no bucket tags (0 ZBCN pass-through / ops / card vaults).** These are not in `contracts{}`, `cex-wallets.json`, or any other supply bucket. Tagging them would double-count balances that already sit on the destination wallet (or count an empty vault):

| address | why excluded |
|---|---|
| `GXD2FnXi718y9tPUd6CW1CW6khZ14DGtQc5cBpYkjm5J` | Zebec stream (zbcKG) pass-through vault used by 9Sq2 → 71LxiE. 0 ZBCN. |
| `43wqg9cUzGW42uLbMEKt3CE4Jzt9dxujrCMjgw7iVr8E` | Zebec stream pass-through used by FNuqK → H8Hr. 0 ZBCN. |
| `BGfzhZmDybCYH1BuMcmZfWUj8GsL6W8cQVj2xcWr7cKd` | Unlabeled buyback supplier into EkXEg. 0 ZBCN. |
| `75UeVz3WhiGU6D6e7ZJv8FKPU3oZghL17fr8j6fLTTzs` | Ops / card vault. 0 ZBCN. |

**Status (2026-10-26, America/New_York): §1 treasury/team cluster APPLIED (owner-approved exact list)** — treasury vaults H8Hr, 3J7n5, 71LxiE added to `config/projects/zebec-network.json` `contracts{}` as `role: "treasury"` (medium confidence); signers 9Sq2 (high), EsDV3m, FNuqK, G82t, 6enQZ, 8vKi (medium), 9jRRK (low) added as `role: "holdings"` (Team Wallets). Rationale in `pipelineNotes.treasuryTeam`. GXD2 and 43wqg stay excluded (0 ZBCN pass-throughs, no bucket). 56veX was **APPLIED 2026-10-28** as holdings (not Team); see the status block at the top.

**Earlier status (2026-10-25): §3 Solscan-confirmed exchange + Fireblocks custody wallets APPLIED** under the owner's explorer-confirmed auto-apply rule (no second owner review): 33 new rows added to `config/projects/zebec-network/cex-wallets.json` (`classification.cexWallets`, now 44 wallets incl. the 11 Dune-approved), and the Orca WSOL-ZBCN Whirlpool `FaoZEZ…` added as a `dex` contract role in `config/projects/zebec-network.json`. **Still not in config:** §2 authorities/fee vault/Wormhole custody, and the §2 governance realm `7ngHDD5…` (deferred: ZBCN has no escrow bucket/copy yet; ~0.46M; left retail). §1 56veX and §3 Squad Vault `Eueeb…` were **APPLIED 2026-10-28** (see the top status). Four §5 wallets (8gQjn, J8FN, 82P4, 6XHz) were applied as cex the same day; the other §5 rows stay retail. GXD2, 43wqg, BGfzh, and 75UeVz are excluded (0 ZBCN; no bucket), not candidates.

> ⚠ Uphold caveat: Zebec says buybacks are consolidated with Uphold Institutional for custody, so part of Uphold Hot Wallet 3/5 (~20.55B / ~128.6M) and part of the 2026-10-28 Uphold/Fireblocks cluster (~2.30B) may be project custodial buybacks (~545M: 504.7M as of Jul 2026 plus 40.54M in the Q3 post). Counted as cex (cannot split on-chain); recorded in `pipelineNotes.cexWallets` and in the Supply section copy.

## NEW vs known (Phase 4b scrape, 2026-10-25)

Index of the scrape already recorded in the tables below. No address in this section is new; each one is copied from §1–§5 or from `docs/zbcn-cex-candidates.md`.

**Already known before the Solscan pass**

- Buyback treasury `EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW` (official X post; already `buybackTreasury`).
- Staking program `zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv` and the stake-vault / reward-vault ATAs listed in §4.
- 11 owner-approved Dune spellbook CEX wallets (`docs/zbcn-cex-candidates.md`, commit f131e02). The six that also appear in the Solscan top-300 table are marked **already in config** in §3: Crypto.com 1 `6FEVkH17…`, Gate `u6PJ8DtQ…`, MEXC `ASTyfSima4…`, KuCoin `BmFdpraQ…`, Crypto.com 2 `AobVSwdW9…`, Bitget `A77HErqtf…`.

**New, and applied**

- 33 Solscan name-tag exchange and Fireblocks custody wallets in §3 (rows marked **APPLIED 2026-10-25**). With the 11 above, `cex-wallets.json` holds 44 wallets. Uphold Hot Wallet 3/5 stay cex; buyback custody cannot be split on-chain.
- Orca WSOL-ZBCN Whirlpool `FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w` as `dex` (also §3).
- 2026-10-26 owner approval of the §1 treasury vaults `H8Hr964A…`, `3J7n5Usm…`, `71LxiE4P…` and team signers `9Sq2nZ48…`, `EsDV3m3x…`, `FNuqKqgJ…`, `G82tVZ6e…`, `6enQZWH…`, `8vKiBgHF…`, `9jRRKgb6…`.

**Scraped, still not in config**

- Pass-through vaults `GXD2FnXi…`, `43wqg9cU…` (§1). `56veXoiv…` was **APPLIED 2026-10-28** as holdings, not Team.
- Squad vault `Eueeb9FK…` was **APPLIED 2026-10-28** as Poloniex custody.
- §2 authorities, the staking fee vault, Wormhole custody `9cJBJyzj…`, and governance realm `7ngHDD5R…` (left retail until an escrow bucket exists).
- §5 except the four Uphold/Fireblocks cluster wallets applied 2026-10-28 (8gQjn, J8FN, 82P4, 6XHz). CsF6fs and 2Ejnns stay retail.

Method and blocked lookups are § "Method" and §6. Solscan api-v2 was Cloudflare-blocked; labels are page titles only.

- Mint: `ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU` · staking program: `zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv`
- Holder snapshot: `public/data/zebec-network/tel-holders.json` (111,519 owners). Rank/balance column = owner rank / ZBCN in that snapshot.
- Researched 2026-10-25 (America/New_York). Addresses are exact base58 as returned by RPC/Solscan (never case-altered).
- Confidence: **high** = explicit public label or official project link / verified on-chain derivation; **medium** = strong on-chain linkage to a high-confidence wallet; **low** = circumstantial.

## Method

- **A. Solscan labels**: public account page `<title>` name tags for the top 300 holders + all traced counterparties (Solscan api-v2 is Cloudflare-blocked; only page titles used).
- **B. Seeds**: official Zebec X post linking the buyback wallet (https://x.com/Zebec_HQ/status/2112911986245910804 → t.co → `https://solscan.io/account/EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW`), Zebec blog https://zebec.io/blog/inside-the-zbcn-buyback-program, NullTX https://nulltx.com/zebec-zbcn-buyback-405m-tokens-held-not-burned-as-supply-stays-unchanged. Counterparties chased via public RPC (`api.mainnet-beta.solana.com`) `getSignaturesForAddress` + `getTransaction` token-balance deltas.
- **C. Checklist**: mint/freeze authority (RPC), staking program upgrade authority + lockup creators/fee vaults (repo `zebecStake.js` decoder), Zebec multisig program `b6ZPysThkApNx2YDiGsPUiYPE7Ub1kTRdCWp7gBkzbr` (Serum-style: signer PDA = `createProgramAddress([multisig, [nonce]])`, verified for each), Zebec stream/vault program `zbcKGdAmXfthXY3rEPBzexVByT2cqRqCZb9NwWdGQ2T`, SPL-Governance realm search by community mint, unlabeled top holders.

## 1. Project treasury / team cluster (Zebec multisig)

All three large multisig vaults below are signer PDAs of Zebec-multisig accounts whose owner sets overlap with the multisig that controls the **published** buyback treasury `EkXEg…` (owners 9Sq2, 6enQZ, G82t, 8vKi). Funds flow between these vaults and the same signer wallets. No public doc names them, so they are proposals, not facts.

| address | proposed role | evidence | seed tx | confidence | notes |
|---|---|---|---|---|---|
| `EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW` | treasury | Official X post links it (https://x.com/Zebec_HQ/status/2112911986245910804); https://solscan.io/account/EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW | [26kU8yo6tg…](https://solscan.io/tx/26kU8yo6tg7a9WLUiHAMqm1c4dwFbFbJ3j8vpFiU5xLUEfkv57LTG59WFb2xC12SJ8dic8QMqwtjQ9Kj3iro9RCk) | high | **already in config** (`buybackTreasury`). Signer PDA of multisig 2UrE7a47… (nonce 252). Outflows go to ops wallet 9Sq2 (e.g. [3haJ57vAuk…](https://solscan.io/tx/3haJ57vAukLmnwGPRVeNkqb99ZTR4rfvVW518mmooFg1sfwb98rFuQwKQXzn1VbQUP4UxWGRSqgPaKQpTwheCoqi) 363.4M, 2025-07-06; [sxzaZGAgxZ…](https://solscan.io/tx/sxzaZGAgxZbmSAUbpg8r7CFMPaW3AAPUe5aM5eDuytANoMznBS9atVG3VM6ae3CEqjcX9C4NR5iecm158hspvFt) 43.77M, 2026-01-05). #54 / 108.26M |
| `H8Hr964ApEP3ie1rwRTT7wkSrgvUqJQb8oNAKspkDDfR` | **APPLIED** treasury | https://solscan.io/account/H8Hr964ApEP3ie1rwRTT7wkSrgvUqJQb8oNAKspkDDfR (unlabeled); signer PDA of multisig EoqY5nPYoL7zH1hWSh1T5Nsbq5q6hhtztU6JStDeVgjG (3-of-4: FNuqK, G82t, EsDV3m, 6enQZ) | [66Dj97jLt4…](https://solscan.io/tx/66Dj97jLt4Nvde9iJmdxR7rS9T497igESSQACQKgiuoDri58mdbpocMjYUcSYt3oPcGjxDU1jReBNjtYpyVMyPJU) | medium | #3 / 7,000.22M. Received ~30.65B via 43wqg (FNuqK pass-through), e.g. [36ZWSuNALb…](https://solscan.io/tx/36ZWSuNALbbusaGwWK7xFFeW1MFSXR68xyVRfTM16Qks6Yr3QiXwkyTzx3GfzadY2FzLp66e6mMy4DjWoXnyY9gX) 3.5B (2025-07-19); paid 5B to G82t ([66Dj97jLt4…](https://solscan.io/tx/66Dj97jLt4Nvde9iJmdxR7rS9T497igESSQACQKgiuoDri58mdbpocMjYUcSYt3oPcGjxDU1jReBNjtYpyVMyPJU), 2025-04-09) and 5B to FNuqK ([3CEnoyRH7b…](https://solscan.io/tx/3CEnoyRH7bWMwiCPkjR5jfbcYbJoHDbQyXxpbpc8DNSRstyjpJGXstjNgcLTA1WNUxoRjMrcLvAUDvL4DNKBzFmN), 2024-10-01). ATA 5L4EM1G2uTCrrXgvbwtQqrJkbU9qNDcpLbZ5yKCsb4yB. Could be treasury or team/ecosystem allocation; owner to decide. |
| `3J7n5Usmei8BqgUHan5xuBiJkAx6M1AQQhGwbKiVdQ17` | **APPLIED** treasury | https://solscan.io/account/3J7n5Usmei8BqgUHan5xuBiJkAx6M1AQQhGwbKiVdQ17 (unlabeled); signer PDA of multisig GiiWgFNnkWbAGnKiDt7ohny1tTtb2pzxpJAXVZv3T1pt (3-of-4: 9Sq2, 6enQZ, G82t, EsDV3m) | [CXmpZ2arvX…](https://solscan.io/tx/CXmpZ2arvXyBTX3DfskogXsb2ZNKpFvKy65AV5aFnxegnGdBDo9RjwByjBBEduTjFfAA61Qus8KmR2jGUVfbYUQ) | medium | #4 / 5,500.00M. Funded 7.0B from EsDV3m on 2026-04-02 (seed tx = 3B leg). Outflows 1B → EsDV3m (NrDf71uT…, 2026-04-27), 500M → 9Sq2 ([3waNh14q2e…](https://solscan.io/tx/3waNh14q2e839J9HuVU9CUupqUQEw9y7fHUDGCHSHKjuKnkdE2DxRqyv2ZKdCdWyHosapJWJkeE7ycUXRig9y67V), 2026-08-21). ATA CZMwajZAkdtPtDC3EfPokkzWmmoQo6jmZJPzDXG3DHR3. |
| `71LxiE4PvxdZxLmtGcoKAJEWKofPqYw5Wdn6PSpXHodV` | **APPLIED** treasury | https://solscan.io/account/71LxiE4PvxdZxLmtGcoKAJEWKofPqYw5Wdn6PSpXHodV (unlabeled); signer PDA of multisig GMeugYRQbdBUsSkgVePSf4xaTQCmUcg26x6ie7U1woDX (2-of-3: 9Sq2, EsDV3m, 9jRRK) | [3pAWKsq76M…](https://solscan.io/tx/3pAWKsq76M7qNEjduW5Cjy5pdFHz76WBHuxr5yKMvhHY2iSEa5AFMRe5rsDTcxut6WMGwiU7hKDSdsNGwSt6YHLw) | medium | #20 / 518.80M. Received ~10.6B from 9Sq2 via its Zebec vault GXD2 (seed: 5B, 2025-04-10); sent ~13.6B to EsDV3m over 81 txs. Looks like an operating/distribution vault. ATA 7v2z3toeo1sgT7SUypFETbGMX2GpT49RmqHYvvtuVmDJ. |
| `9Sq2nZ481aiEkoDB9gavcfD6v7pr4LEcPnUdky4TEine` | **APPLIED** holdings (team) | https://solscan.io/account/9Sq2nZ481aiEkoDB9gavcfD6v7pr4LEcPnUdky4TEine; owner on multisigs 2UrE7a47 (EkXEg), GiiWg, GMeug | [2ZrcMZaBN5…](https://solscan.io/tx/2ZrcMZaBN5Gf6JVFKw9w2VfXHUvCtY4ppCx979x7Wpa5ky4kTkzxJYnUxEHfEawNspkfTEv8HdzEriGJb3sU18xf) | medium | #664 / 7.39M. Ops/payout hot wallet (3000+ txs, many small payouts). Signed the 114M seed into EkXEg (2024-10-02) and [pJAzdU7Wqn…](https://solscan.io/tx/pJAzdU7WqnSca5TzsLs43mbNWTJP18rh2w7CsNS8jQy1WDtX7ZZhqBBrVDhj4hvApQNsPYavFEchN7azpj8Fu88) (19.2M, 2026-04-17). Only signer wallet currently holding ZBCN. |
| `EsDV3m3xUZ7g8QKa1kFdbZT18nNz8ddGJRcTK84WDQ7k` | **APPLIED** holdings (team) | https://solscan.io/account/EsDV3m3xUZ7g8QKa1kFdbZT18nNz8ddGJRcTK84WDQ7k; owner on EoqY5, GiiWg, GMeug | [CXmpZ2arvX…](https://solscan.io/tx/CXmpZ2arvXyBTX3DfskogXsb2ZNKpFvKy65AV5aFnxegnGdBDo9RjwByjBBEduTjFfAA61Qus8KmR2jGUVfbYUQ) | medium | not a holder. Signer; funded 3J7n5 with 7B, received ~13.6B from 71LxiE. Currently 0 ZBCN, so no supply impact. Useful as a cluster tag. |
| `FNuqKqgJLzJExhZQo1r8ZjQDQRp7hJX2j4bvE2hjcgtM` | **APPLIED** holdings (team) | https://solscan.io/account/FNuqKqgJLzJExhZQo1r8ZjQDQRp7hJX2j4bvE2hjcgtM; owner on EoqY5 | [3CEnoyRH7b…](https://solscan.io/tx/3CEnoyRH7bWMwiCPkjR5jfbcYbJoHDbQyXxpbpc8DNSRstyjpJGXstjNgcLTA1WNUxoRjMrcLvAUDvL4DNKBzFmN) | medium | not a holder. Signer; funded H8Hr via pass-through 43wqg. |
| `G82tVZ6eu2YRPfGFFnPYs3qLz8HtAQXnsnmNKpqfMnx7` | **APPLIED** holdings (team) | https://solscan.io/account/G82tVZ6eu2YRPfGFFnPYs3qLz8HtAQXnsnmNKpqfMnx7; owner on 2UrE7a47, EoqY5, GiiWg | [66Dj97jLt4…](https://solscan.io/tx/66Dj97jLt4Nvde9iJmdxR7rS9T497igESSQACQKgiuoDri58mdbpocMjYUcSYt3oPcGjxDU1jReBNjtYpyVMyPJU) | medium | not a holder. Signer; in Jan 2025 distributed ~11.2B to 5 unlabeled wallets (now 0 ZBCN): 9RE2Gcyt4PhdYeTWpCwWeSik9Fpumk2tNbc7sQvFsg6i 6.25B, Vr25znzeh9oUzbDDWuqK9hhsSb2JQfJxiWAjwpxuZQL 2.22B, 2bYFLw9ZM7jBMN4AyeqfnQ4mpgtQER52CzfiDsr2cZig 1.22B, HtGMxGGNU7GKeqDpuxBVCZYoVeKkaubYxLpL4aMpejxV 1.03B, 34XBQCetCDBfa2LDA7rr1T1SRdSnwj8miFPwESoQeCSx 444M (likely vesting/investor unlocks — low confidence, not proposed). |
| `6enQZWHkQ5ayxyFbJXgrNdUwDZpcUon98SNCuVNSRbd2` | **APPLIED** holdings (team) | https://solscan.io/account/6enQZWHkQ5ayxyFbJXgrNdUwDZpcUon98SNCuVNSRbd2; owner on 2UrE7a47, EoqY5, GiiWg |  | medium | not a holder. Multisig signer only. |
| `8vKiBgHFgR7BTUTwjNXj91P95GrRDCt3xNt6iLgHVMJw` | **APPLIED** holdings (team) | https://solscan.io/account/8vKiBgHFgR7BTUTwjNXj91P95GrRDCt3xNt6iLgHVMJw; owner on 2UrE7a47 (EkXEg multisig) |  | medium | not a holder. Multisig signer only. |
| `9jRRKgb69WSMRLrqrPsk1byunMhD5tXxixYAdoESHdM3` | **APPLIED** holdings (team) | https://solscan.io/account/9jRRKgb69WSMRLrqrPsk1byunMhD5tXxixYAdoESHdM3; owner on GMeug |  | low | not a holder. Signer on one multisig only. |
| `GXD2FnXi718y9tPUd6CW1CW6khZ14DGtQc5cBpYkjm5J` | **EXCLUDED** (no bucket) | https://solscan.io/account/GXD2FnXi718y9tPUd6CW1CW6khZ14DGtQc5cBpYkjm5J; zbcKG (Zebec stream) per-user vault PDA used by 9Sq2 | [3pAWKsq76M…](https://solscan.io/tx/3pAWKsq76M7qNEjduW5Cjy5pdFHz76WBHuxr5yKMvhHY2iSEa5AFMRe5rsDTcxut6WMGwiU7hKDSdsNGwSt6YHLw) | medium | 0 ZBCN. Pass-through vault (9Sq2 → 71LxiE). **Excluded 2026-10-28** — no bucket tag; tagging would double-count. |
| `43wqg9cUzGW42uLbMEKt3CE4Jzt9dxujrCMjgw7iVr8E` | **EXCLUDED** (no bucket) | https://solscan.io/account/43wqg9cUzGW42uLbMEKt3CE4Jzt9dxujrCMjgw7iVr8E; zbcKG vault pass-through for FNuqK | [36ZWSuNALb…](https://solscan.io/tx/36ZWSuNALbbusaGwWK7xFFeW1MFSXR68xyVRfTM16Qks6Yr3QiXwkyTzx3GfzadY2FzLp66e6mMy4DjWoXnyY9gX) | medium | 0 ZBCN. Pass-through vault (FNuqK → H8Hr). **Excluded 2026-10-28** — no bucket tag; tagging would double-count. |
| `56veXoivcbZNwkN4MCvhdyromDrp6cp9EuJZ9arknGSF` | **APPLIED** holdings (not Team) | https://solscan.io/account/56veXoivcbZNwkN4MCvhdyromDrp6cp9EuJZ9arknGSF (unlabeled) · https://zebec.io/blog/zebec-network-zbcn-tokenomics · https://docs.zebec.io/zebec-protocol/tokenomics · https://blockworks.com/token-transparency/filing/zebec-network | [cNQGEemMpJ…](https://solscan.io/tx/cNQGEemMpJjF8aEqVMUeHnD5rMYZSBQcYPnJ8L3LJhPRUYqEXSnvregZjiB9BoAHJ6s2y4hqEr3PRR9Qj3xSuAK) | low | #25 / 399.92M. Received 3×40M from ops wallet 9Sq2 (2026-06-15, [5xYj1uYhom…](https://solscan.io/tx/5xYj1uYhom77Dw9MsuuGZjvLsRAR5tB7h2hGWsLMGDkUfwMxBdt8WHZc5xSCvEhi2C367CCxdhMsAQ9fLRqcaV23) 2026-07-23, [5xo2565e9N…](https://solscan.io/tx/5xo2565e9NGt3J2iS5vWGuRTFL5ceoVP6WpeZtBp1DCCmrskSaexLhXdgSMkC5QmJF4MCnUus99z3hguaAbe5wC1) 2026-08-18). Rest of balance from elsewhere. **APPLIED 2026-10-28** → `contracts.allocation56veX` role holdings, not Team. ~400M; 40M/month from team ops 9Sq2 past the official vesting end (16 Mar 2026; MiCA white paper Oct 2026: unlocks ended Mar 2026). Recipient unknown. |

Multisig accounts (not token holders; for reference): `2UrE7a47Tuze41BYEp1bMYPtpnCzu9Ruv1p3JkdxUNza` (EkXEg, 3/4, nonce 252), `EoqY5nPYoL7zH1hWSh1T5Nsbq5q6hhtztU6JStDeVgjG` (H8Hr, 3/4), `GiiWgFNnkWbAGnKiDt7ohny1tTtb2pzxpJAXVZv3T1pt` (3J7n5, 3/4), `GMeugYRQbdBUsSkgVePSf4xaTQCmUcg26x6ie7U1woDX` (71LxiE, 2/3). Other `b6ZPys…` multisigs with tiny balances are unrelated third parties and are excluded.

Earlier buyback suppliers into EkXEg (unlabeled, likely OTC/MM; **not proposed**): `CGeY5GbhUW31gfiSaM4BZyRLdcqz13etUza1aBH3oywb` (2024-10 → 2025-04, e.g. [3bLBbFYvw6…](https://solscan.io/tx/3bLBbFYvw6n7jvwWSsCormRMhkaZzeayb8THrptPuwpUYLBVswj7eMm9azFVYVEXBdF8g4E8AAFb2VdZH8cL6aHr) 45.7M; not a holder), `BGfzhZmDybCYH1BuMcmZfWUj8GsL6W8cQVj2xcWr7cKd` ([54u1yBP1xT…](https://solscan.io/tx/54u1yBP1xTotk82KRooDEX6tggNawp5Zm2FKvDpkZTWkyJBhHXcSmrRLhyJ87zDoNnuYhrpypv6yiDamZSeWWsZ) 43.76M, 2026-01-02; not a holder). **BGfzh excluded 2026-10-28** — 0 ZBCN, no bucket tag.

`75UeVz3WhiGU6D6e7ZJv8FKPU3oZghL17fr8j6fLTTzs` — ops/card vault, 0 ZBCN. **Excluded 2026-10-28** — no bucket tag (would double-count). Not a holder in the current snapshot.

## 2. Authorities, staking & governance

| address | proposed role | evidence | seed tx | confidence | notes |
|---|---|---|---|---|---|
| `ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU` | authority | RPC `getAccountInfo` (jsonParsed) on mint |  | high | **mintAuthority = null, freezeAuthority = null** (renounced). Nothing to classify. |
| `93aZawDHMCagDDPy8dbcJdx4Xd4WsYP5KWE6EScocDLN` | authority | Upgrade authority in programData FDaxBG4fxAYojaNo6rebnr55J9n6mHmh6FvvxK6txtRi of staking program zSTKzG… |  | high | not a holder. Staking program upgrade key (no Solscan label). |
| `35gFV52ZwSd64CmD7weVjSfxgUiqkKWGderXKDXvyHSQ` | authority | `creator` field of all 6 staking lockups (005, 003, "ZBCN Lockup", 002, 004, UAT_001), decoded with `scripts/lib/solana/zebecStake.js` |  | high | not a holder. Lockup admin. |
| `2Nz9xczcGaWvu5pZNzzXundLEdP5tf2aCAoWy4CGrjxD` | other | `feeVault` of all 6 lockups (fee = 0) |  | high | #100085 / 0.00M. Staking fee vault; negligible balance. |
| `5aUDpuNNbAvme6hPi4o2vBbzHMrF7h3xB4kfKNMk6V8h` | authority | Upgrade authority of Zebec multisig program b6ZPysThkApNx2YDiGsPUiYPE7Ub1kTRdCWp7gBkzbr and stream program zbcKGdAmXfthXY3rEPBzexVByT2cqRqCZb9NwWdGQ2T |  | high | not a holder. Zebec dev key. |
| `7ngHDD5RtRuLv1Eg2QnBiRvF1nLPKQXovaMKnbbMLehJ` | other | SPL-Governance (GovER5…) Realm account; name "Zebec Network", community mint = ZBCN (RPC getProgramAccounts memcmp) |  | high | #11189 / 0.46M. Owner of governance token-holding account F6VVzyH9oMoUXHWWX1XtK6CbB3NRoh5KVqifxf4GrsyR (= voter deposits / DAO escrow, ~235 TokenOwnerRecords). Realm authority = governance BuXDBUSn8RhCMgd5i1KG4PpXUoyfjZ8H7NRN1qjA3Dbi; its native treasury 94kzzyh3aD1isJt9ExTVtXk6mtFKYvo1kZpX3ZJmfQCV holds 0 ZBCN. Suggest classifying as staking/escrow-like. |
| `9cJBJyzjt8B26fifTqoG7kuSxyEGsz5DDH1v5wgw8PSt` | other | Wormhole custody token account (owner GugU1tP7doLeTw9hQP51xRJyS8Da1fWxuiy2rVrnMD2m) |  | medium | ~21 ZBCN. Bridge custody; negligible. |

No burn address/candidate: no ZBCN burn txs found; ZIP-4 paused burns and buyback tokens are held (NullTX, Zebec blog).

## 3. Exchanges / custody (Solscan name tags, top-300 holders)

Evidence for every row is the Solscan account page `https://solscan.io/account/<address>` (name tag in page title, fetched 2026-10-25).

| address | proposed role | evidence | seed tx | confidence | notes |
|---|---|---|---|---|---|
| `5rhms6jZQaXnQc6wbicnrxDTkKqKi4iwfWW3612r5rHb` | cex | Solscan: "Uphold Hot Wallet 3" (https://solscan.io/account/5rhms6jZQaXnQc6wbicnrxDTkKqKi4iwfWW3612r5rHb) |  | high | #1 / 20,548.59M. ⚠ Zebec says buybacks are 'consolidated periodically with Uphold Institutional for custody' (X post https://x.com/Zebec_HQ/status/2112911986245910804; https://zebec.io/blog/inside-the-zbcn-buyback-program). Some Uphold-labeled balance may be custodial project funds; cannot be split on-chain. Keep cex unless owner decides otherwise. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `22Wnk8PwyWZV7BfkZGJEKT9jGGdtvu7xY6EXeRh7zkBa` | cex | Solscan: "Crypto.com Hot Wallet 3" (https://solscan.io/account/22Wnk8PwyWZV7BfkZGJEKT9jGGdtvu7xY6EXeRh7zkBa) |  | high | #2 / 7,564.26M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `E2RvJg2myWpKcbkhBuF81gfhYr6KvmNcDbSmr5qnatYy` | cex | Solscan: "Kraken Cold Wallet (E2RvJ)" (https://solscan.io/account/E2RvJg2myWpKcbkhBuF81gfhYr6KvmNcDbSmr5qnatYy) |  | high | #6 / 3,043.56M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `6FEVkH17P9y8Q9aCkDdPcMDjvj7SVxrTETaYEm8f51Jy` | cex | Solscan: "Crypto.com Hot Wallet 1" (https://solscan.io/account/6FEVkH17P9y8Q9aCkDdPcMDjvj7SVxrTETaYEm8f51Jy) |  | high | #7 / 2,062.79M.  **already in config** (`config/projects/zebec-network/cex-wallets.json`, commit f131e02). |
| `CBEADkb8TZAXHjVE3zwad4L995GZE7rJcacJ7asebkVG` | cex | Solscan: "OKX Cold Wallet (CBEAD)" (https://solscan.io/account/CBEADkb8TZAXHjVE3zwad4L995GZE7rJcacJ7asebkVG) |  | high | #8 / 1,319.98M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w` | cex | Solscan: "Gate Hot Wallet (u6PJ8)" (https://solscan.io/account/u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w) |  | high | #11 / 847.59M.  **already in config** (`config/projects/zebec-network/cex-wallets.json`, commit f131e02). |
| `ADqZYsW9SVZ6bCSGDqfBiPkfaZuQKGg79MA357otX8Ud` | cex | Solscan: "Crypto.com Hot Wallet 5" (https://solscan.io/account/ADqZYsW9SVZ6bCSGDqfBiPkfaZuQKGg79MA357otX8Ud) |  | high | #12 / 810.85M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `4GC3a1RkRXx5shwGP8pTY6cxXgSWkbfc66vM53a6qSKj` | cex | Solscan: "CoinSpot Hot Wallet (4GC3a)" (https://solscan.io/account/4GC3a1RkRXx5shwGP8pTY6cxXgSWkbfc66vM53a6qSKj) |  | high | #13 / 700.01M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `FcmiyrjpbPXQA1nTo8ntGRYAsZR8pSmL5uVpmXLUt6Bs` | other (Fireblocks custody, owner unknown) | Solscan: "Fireblocks Custody (Fcmiy)" (https://solscan.io/account/FcmiyrjpbPXQA1nTo8ntGRYAsZR8pSmL5uVpmXLUt6Bs) |  | medium | #14 / 659.82M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `7TWnq4WeYcwQWBCwKeEX2Q9xqVtthPGkB7adNvueuVuh` | cex | Solscan: "Bitget Cold Wallet (7TWnq)" (https://solscan.io/account/7TWnq4WeYcwQWBCwKeEX2Q9xqVtthPGkB7adNvueuVuh) |  | high | #15 / 656.46M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `5PAhQiYdLBd6SVdjzBQDxUAEFyDdF5ExNPQfcscnPRj5` | cex | Solscan: "MEXC #2" (https://solscan.io/account/5PAhQiYdLBd6SVdjzBQDxUAEFyDdF5ExNPQfcscnPRj5) |  | high | #18 / 558.28M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `C68a6RCGLiPskbPYtAcsCjhG8tfTWYcoB4JjCrXFdqyo` | cex | Solscan: "OKX Hot Wallet (C68a6)" (https://solscan.io/account/C68a6RCGLiPskbPYtAcsCjhG8tfTWYcoB4JjCrXFdqyo) |  | high | #22 / 463.56M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `8wM44Ryv9DFCSfkgUnPEPgnsc53arT4cnmXL6LnnC4UW` | cex | Solscan: "OKX Hot Wallet (8wM44)" (https://solscan.io/account/8wM44Ryv9DFCSfkgUnPEPgnsc53arT4cnmXL6LnnC4UW) |  | high | #24 / 403.18M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `EFE3j1pcSP1paUzA86zW7989ZjsFP2J7ginyUqo4ewqR` | cex | Solscan: "Kraken Cold Wallet (EFE3j)" (https://solscan.io/account/EFE3j1pcSP1paUzA86zW7989ZjsFP2J7ginyUqo4ewqR) |  | high | #26 / 395.64M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `6BhBoBB47wSGjK5uzcGWNcTf2oNRPQNuv6GVdkNyj9PB` | cex | Solscan: "KuCoin Cold Wallet (6BhBo)" (https://solscan.io/account/6BhBoBB47wSGjK5uzcGWNcTf2oNRPQNuv6GVdkNyj9PB) |  | high | #27 / 391.50M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF` | cex | Solscan: "Kraken Hot Wallet (6LY1J)" (https://solscan.io/account/6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF) |  | high | #28 / 385.89M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `7RmkMNQerKaVioRnmqZsHM5Gm8F3gngQG8umLNoK97q4` | cex | Solscan: "Bitrue Hot Wallet (7RmkM)" (https://solscan.io/account/7RmkMNQerKaVioRnmqZsHM5Gm8F3gngQG8umLNoK97q4) |  | high | #30 / 369.71M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `FixDET3jRBMjT9M69Wim8iRpMQiJHkSSfD7wivStuuph` | cex | Solscan: "Bitvavo Cold Wallet (FixDE)" (https://solscan.io/account/FixDET3jRBMjT9M69Wim8iRpMQiJHkSSfD7wivStuuph) |  | high | #31 / 344.42M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `Eueeb9FKXpk7duw7jKeYm1NNWmTeFN7fGKYMmasY7C9x` | **APPLIED** cex (Poloniex custody) | Solscan: "Squad Vault "SOL-P" (Eueeb)" (https://solscan.io/account/Eueeb9FKXpk7duw7jKeYm1NNWmTeFN7fGKYMmasY7C9x) · https://www.poloniex.com/trade/ZBCN_USDT · https://messari.io/project/zebec/markets · https://blockworks.com/token-transparency/filing/zebec-network |  | high on-chain / low off-chain | #34 / 281.65M. **APPLIED 2026-10-28** → cex-wallets.json as Squad Vault SOL-P (Poloniex). Sampled flows are only with Poloniex Hot Wallet 7Ci23. |
| `AGVhmrhDi3RKLu9nxnRqp3CUpaG3SVeYXWkWcygHAk8N` | cex | Solscan: "KuCoin Cold Wallet (AGVhm)" (https://solscan.io/account/AGVhmrhDi3RKLu9nxnRqp3CUpaG3SVeYXWkWcygHAk8N) |  | high | #35 / 267.06M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `GL8T72PKygWaYrLKtSteN9UUvYYnuC8azNDunk4eaqqQ` | cex | Solscan: "KuCoin Cold Wallet (GL8T7)" (https://solscan.io/account/GL8T72PKygWaYrLKtSteN9UUvYYnuC8azNDunk4eaqqQ) |  | high | #42 / 165.39M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `FZ1t8TZtx7VSCQdBsxvFJiezj9paUBF6Ub7RKA2eTGyE` | cex | Solscan: "KuCoin Cold Wallet (FZ1t8)" (https://solscan.io/account/FZ1t8TZtx7VSCQdBsxvFJiezj9paUBF6Ub7RKA2eTGyE) |  | high | #46 / 160.65M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `CSEncqtqbmNRjve42sNnbs5cCSmrjUNsAEwc17XY2RCs` | cex | Solscan: "CoinSpot Hot Wallet (CSEnc)" (https://solscan.io/account/CSEncqtqbmNRjve42sNnbs5cCSmrjUNsAEwc17XY2RCs) |  | high | #47 / 148.65M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `FPRFLszBJFHCThF2yWvkGkfvtwyFPRGX9MFHnDGP6UYp` | cex | Solscan: "KuCoin Cold Wallet (FPRFL)" (https://solscan.io/account/FPRFLszBJFHCThF2yWvkGkfvtwyFPRGX9MFHnDGP6UYp) |  | high | #49 / 140.00M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `8QCVZ7KL65pBhUxbvfwbyyg4ronxNAEXbDrGLYLrRNn5` | cex | Solscan: "Uphold Hot Wallet 5" (https://solscan.io/account/8QCVZ7KL65pBhUxbvfwbyyg4ronxNAEXbDrGLYLrRNn5) |  | high | #50 / 128.56M. Same Uphold Institutional custody caveat as #1. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `4yqgcP2EvCyyE14Zd9H2jPFMK59q67YUz7bBnUcKcfVE` | other (Fireblocks custody, owner unknown) | Solscan: "Fireblocks Custody (4yqgc)" (https://solscan.io/account/4yqgcP2EvCyyE14Zd9H2jPFMK59q67YUz7bBnUcKcfVE) |  | medium | #52 / 121.22M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `3n7E2gZmCaDGpmvmHVHhHg13x7y1zG37tnEXvizxnKY1` | cex | Solscan: "OKX Cold Wallet (3n7E2)" (https://solscan.io/account/3n7E2gZmCaDGpmvmHVHhHg13x7y1zG37tnEXvizxnKY1) |  | high | #53 / 117.82M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `FxmR1j3mDiPnyTT1mW4vX6drikupeTf4Tb7hEp4XCAb2` | other (Fireblocks custody, owner unknown) | Solscan: "Fireblocks Custody (FxmR1)" (https://solscan.io/account/FxmR1j3mDiPnyTT1mW4vX6drikupeTf4Tb7hEp4XCAb2) |  | medium | #65 / 92.09M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ` | cex | Solscan: "MEXC" (https://solscan.io/account/ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ) | [2aQNVMnJmA…](https://solscan.io/tx/2aQNVMnJmAYGQkVCex2RPJUBe1nHpzC9yTKAw94iKquFxZcVz6Xo1TiDmhaApsooYqGFMckoNRsuVYpbtne7vipM) | high | #67 / 88.61M. Source of buyback deliveries into EkXEg (2025-09-30; also 4q1LxQsz…, 2025-07-11). **already in config** (`config/projects/zebec-network/cex-wallets.json`, commit f131e02). |
| `8PFD2CYF275p8YdRmhk4C1wcNoKeRVrouYdMbZV6HwHH` | cex | Solscan: "OKX Cold Wallet (8PFD2)" (https://solscan.io/account/8PFD2CYF275p8YdRmhk4C1wcNoKeRVrouYdMbZV6HwHH) |  | high | #76 / 71.02M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `3Ln6KEgLoMR2xFHfqtYazP7CxFQPDtUVVtwCVsLKVfmV` | cex | Solscan: "BingX Cold Wallet 1" (https://solscan.io/account/3Ln6KEgLoMR2xFHfqtYazP7CxFQPDtUVVtwCVsLKVfmV) |  | high | #77 / 70.72M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `2UL8hbNaoErAYNePqgQYPP9yDCDRZGWbzKW4krLqkhNL` | cex | Solscan: "Bitvavo Hot Wallet (2UL8h)" (https://solscan.io/account/2UL8hbNaoErAYNePqgQYPP9yDCDRZGWbzKW4krLqkhNL) |  | high | #90 / 61.23M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6` | cex | Solscan: "KuCoin Hot Wallet (BmFdp)" (https://solscan.io/account/BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6) |  | high | #91 / 60.21M.  **already in config** (`config/projects/zebec-network/cex-wallets.json`, commit f131e02). |
| `FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w` | other (DEX pool) | Solscan: "Orca (WSOL-ZBCN) Market" (https://solscan.io/account/FaoZEZFsRS2jJAzg5PXwNjDdA1hDAjDGAkDf4xRfY79w) |  | high | #100 / 46.33M. **APPLIED 2026-10-25** → `contracts.orcaWhirlpoolWsolZbcn` role `dex`. |
| `9isrZBGb9CWU79466DCUxN25iH7krrLRei5niqvH5WxU` | cex | Solscan: "OKX: Hot Wallet 6" (https://solscan.io/account/9isrZBGb9CWU79466DCUxN25iH7krrLRei5niqvH5WxU) |  | high | #104 / 44.33M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `9jA4MUtsPAXy3ZhsiQUhkSXMop2ogrCWYv7rE9xovsWp` | cex | Solscan: "Bitunix Hot Wallet (9jA4M)" (https://solscan.io/account/9jA4MUtsPAXy3ZhsiQUhkSXMop2ogrCWYv7rE9xovsWp) |  | high | #113 / 39.81M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS` | cex | Solscan: "Crypto.com Hot Wallet 2" (https://solscan.io/account/AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS) | [26kU8yo6tg…](https://solscan.io/tx/26kU8yo6tg7a9WLUiHAMqm1c4dwFbFbJ3j8vpFiU5xLUEfkv57LTG59WFb2xC12SJ8dic8QMqwtjQ9Kj3iro9RCk) | high | #116 / 36.69M. Source of Q3-2026 buyback deliveries into EkXEg (also 38sYh3He…, 2026-10-21; 37mcu1wH…, 2026-07-20). **already in config** (`config/projects/zebec-network/cex-wallets.json`, commit f131e02). |
| `EhDyxGpEz9hryw6MwiBB7898WEzcoGTCAjVQMHbo6Q1M` | cex | Solscan: "OKX Hot Wallet (EhDyx)" (https://solscan.io/account/EhDyxGpEz9hryw6MwiBB7898WEzcoGTCAjVQMHbo6Q1M) |  | high | #117 / 35.61M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `DSFWxvJjgvLbVqoQ1Zwoe1iVHhwFgrfSiF3ZK1h7nd1K` | cex | Solscan: "CoinDCX: Fireblocks Custody (DSFWx)" (https://solscan.io/account/DSFWxvJjgvLbVqoQ1Zwoe1iVHhwFgrfSiF3ZK1h7nd1K) |  | high | #121 / 35.43M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `6xfPFKnwv48XvxpFf4athewqGFvSTKQcMmfzYapgZ2sG` | cex | Solscan: "BingX Cold Wallet 3" (https://solscan.io/account/6xfPFKnwv48XvxpFf4athewqGFvSTKQcMmfzYapgZ2sG) |  | high | #166 / 24.53M. **APPLIED 2026-10-25** → cex-wallets.json (Solscan auto-apply). |
| `A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR` | cex | Solscan: "Bitget Exchange" (https://solscan.io/account/A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR) | [3HGBb6KL4u…](https://solscan.io/tx/3HGBb6KL4uhYvUtDe2Gf4nCP1teVq71b7AQj5PLn4vE5j88fBnaeS9KRQUvSDVr8iMx2NMA7BwmtYr39Ce381udS) | high | #238 / 17.69M. Source of a 2025-07-11 buyback delivery into EkXEg. **already in config** (`config/projects/zebec-network/cex-wallets.json`, commit f131e02). |
| `7Ci23i82UMa8RpfVbdMjTytiDi2VoZS8uLyHhZBV2Qy7` | cex | Solscan: "Poloniex Hot Wallet" (https://solscan.io/account/7Ci23i82UMa8RpfVbdMjTytiDi2VoZS8uLyHhZBV2Qy7) |  | high | Snapshot 2026-10-28: 141,705.85 ZBCN. **APPLIED 2026-10-28** → cex-wallets.json (Solscan auto-apply). |
| `9CKnC2kmqG9ZBtQXDfxR5H7Av7X878geV367DdYtybT4` | cex | Solscan: "FalconX Hot Wallet" (https://solscan.io/account/9CKnC2kmqG9ZBtQXDfxR5H7Av7X878geV367DdYtybT4) |  | high | Snapshot 2026-10-28: 19,781.91 ZBCN. **APPLIED 2026-10-28** → cex-wallets.json (Solscan auto-apply). |

## 4. Already in config (no change proposed)

- `EkXEg6de172aoLvr7w86YzQ2rf5oEFD3iUt8uQsLQuQW` buybackTreasury (treasury) — confirmed by official X post above.
- `zSTKzGLiN6T6EVzhBiL6sjULXMahDavAS2p4R62afGv` staking program; stake-vault ATAs `3DC8cdCN…`, `8bbygT4w…`, `7dvTVafo…`, `FnJhFWTi…`, `BcfMnwQM…` (owner PDAs HJqK7re4…, 5Fe1JVUk…, DWwty3vn… appear as holder owners); reward-vault ATAs `ErF9raeV…` (owner FqtZSfVX986itJuFqdt1SmNqMSQc9MgCjijXZJ2aSCiG) and `DGMT79t6…` (owner 7oKEHLFXbya57ZixovrDStQCxWpVJmisHszLSSiZXPdG).

- 11 Solana CEX wallets in `config/projects/zebec-network/cex-wallets.json` (parallel CEX workstream, f131e02); the 6 that overlap §3 are marked there.
- 2026-10-25: +33 §3 Solscan-confirmed exchange/Fireblocks wallets (44 total) and the Orca Whirlpool (`dex` role) applied under the owner auto-apply rule.
- 2026-10-28: +2 Solscan-confirmed CEX wallets (Poloniex Hot Wallet, FalconX Hot Wallet; 46 total) applied under the same auto-apply rule. GXD2, 43wqg, BGfzh, and 75UeVz stay untagged (0 ZBCN pass-through/ops/card vaults).
- 2026-10-28 owner YES: +5 cex (Uphold/Fireblocks cluster 8gQjn, J8FN, 82P4, 6XHz; Poloniex Squad Vault SOL-P Eueeb) and holdings `allocation56veX` (not Team). 51 cex wallets. Gas station EbsUZE noted only (0 ZBCN). See the status block at the top.

## 5. Large unlabeled holders — no project link found (gaps, not proposed)

Top-50 owners with no Solscan tag in the 2026-10-25 scrape. Four were later linked to Uphold/Fireblocks custody and **APPLIED 2026-10-28** (see the top status and research links there). CsF6fs, 2Ejnns, and every other row stay retail.

| rank | address | ZBCN |
|---|---|---|
| 9 | `8gQjn3qPAcKXpDpcGSLKXetTSG4zFgeWcAVnNAy9ru2f` | 1,043.62M **APPLIED** cex |
| 10 | `CsF6fsHVVrMJUhnJ7uoxmV3ZFJRvFwdRjhpaShfyypvg` | 1,027.48M |
| 16 | `2Ejnns2Fd5gsZdFJbnkZmQEwbrgoiMc2ikKcS2z2Ps3e` | 655.20M |
| 17 | `74rRXKtZ3iGwm3V59dbtdjNmTNP7h6HjDXyzoSCXyWnG` | 600.18M |
| 21 | `J8FNbQnRGmgHaPrmUsjJ7sdM7gaJVbcvEfYGCmVs69bE` | 500.71M **APPLIED** cex |
| 23 | `82P4QkJ3rdXVeEduue29H19EHvuQG1r2dA4ndup1Ahya` | 428.80M **APPLIED** cex |
| 29 | `9a3DbEtTC615cW6vXZLUVbCHBcHqg2Yo7gfZKnkFjFim` | 384.10M |
| 32 | `6XHzigwW96CXM98L19CMfphFfnW1e7Yn9JLFjtkdoGLh` | 336.12M **APPLIED** cex |
| 33 | `Ctua7faNtcDH2NZAiiJ4q8a4xJgMKLkNMSTSFPWwkbxM` | 327.24M |
| 36 | `GHYoW2wmhr6iE6maSNY43wVSNjXuxP1rNznFzbFqSWRZ` | 240.47M |
| 37 | `AGiAVqZiQrz32m1zKC5T4UfQKcDoGNG34sqSHSVNgwtv` | 205.09M |
| 38 | `5KU7vrqRt9NvVJRvrXzvvARq3YAiG91xv8NdRBf97AfE` | 193.01M |
| 39 | `DwzTuEDaE9pkrVJQvznV7zz7YNJcggKxN5wKhYt8JqXY` | 192.03M |
| 41 | `75sjEgLaWz4jcTT9j6dj8jDoYumqp1QBauYwrwzy16wp` | 173.00M |
| 43 | `GbzsJectquYtBRSjYQ1R9ZSxW6QjU48rJua3T4NLbQvG` | 164.33M |
| 44 | `J1KmWcv9Ab6hyv5ojPN7FhLbCo1BAoasDZZst6bgQ3yP` | 161.04M |
| 45 | `BxYATcCtPdmonQxD2VgB4fEhvXhK7gXRnNs5oNbDDcQw` | 160.72M |
| 48 | `837Dvdn5HuC7i7DWuw5ztjBBaTc6Rws8hTp9ZPhyyaUN` | 144.50M |

(Staking lockup vault owner PDAs at ranks 5, 19, 40 are already in config and are omitted.)

## 6. Gaps / blocked lookups

- Solscan api-v2 (labels/transfers API) is Cloudflare-blocked; only public page titles were used, so Solscan tags beyond the top 300 holders + traced counterparties were not checked.
- Uphold Institutional custody: Zebec says buybacks are consolidated with Uphold Institutional, but no distinct custody address is identifiable; Uphold-labeled #1 (20.55B) / #50 may include project funds.
- No public doc/GitHub/tokenomics page publishes team, treasury, investor or vesting wallets (Blockworks: multisig undisclosed). Cluster attribution in §1 is on-chain inference only.
- Discord/Telegram not scanned; X checked via search of @Zebec_HQ posts (only EkXEg link found).
- Histories sampled: most ATAs newest ~120–150 signatures; 9Sq2 has 3000+ txs (not exhaustively traced). Older vesting/investor distributions (e.g. G82t → 5 wallets, Jan 2025) not followed further since those wallets now hold 0.
- Public RPC only (SOLANA_RPC_0 empty); no indexer-based full transfer graph.
