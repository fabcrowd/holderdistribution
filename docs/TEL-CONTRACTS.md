# TEL contract registry

Last verified: **2026-10-18** (public RPC `eth_call`/`eth_getCode`, Blockscout, Sourcify, Etherscan).
The machine-readable copy is `config/chains.json` (`tokens` and `contracts` per chain); the UI copy is
`src/lib/telContracts.ts`. `scripts/lib/telContracts.test.js` fails if the three drift apart.

## What changed

Telcoin upgraded TEL to a new 18-decimal token ("TEL v3" / "new TEL"). Holders swap legacy TEL for new TEL
1:1 on whichever chain they already hold it on. Legacy TEL is **deprecated**, not destroyed: the old contracts
still exist and the upgrade contracts lock the legacy tokens they receive.

| | Legacy TEL | TEL v3 (canonical) |
|---|---|---|
| Decimals | 2 | 18 |
| Address | different on every chain | **same on every chain** (CREATE3) |
| Status | deprecated, retired via upgrade | canonical; native gas token of Telcoin Network |

## Token contracts

| Chain | Role | Address | Verified as |
|---|---|---|---|
| Ethereum (1) | **TEL v3** (new) | `0x7E13B43065380aCdeC1c2d138c579cbBbafA0731` | `TelcoinV3`, name `Telcoin`, symbol `TEL`, **18** decimals |
| Polygon (137) | **TEL v3** (new) | `0x7E13B43065380aCdeC1c2d138c579cbBbafA0731` | same |
| Base (8453) | **TEL v3** (new) | `0x7E13B43065380aCdeC1c2d138c579cbBbafA0731` | same |
| Ethereum | Legacy TEL (deprecated) | `0x467Bccd9d29f223BcE8043b84E8C8B282827790F` | `Telcoin` / `TEL`, 2 decimals (unchanged) |
| Polygon | Legacy TEL (deprecated) | `0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32` | `Telcoin (PoS)` / `TEL`, 2 decimals (unchanged) |
| Base | Legacy TEL (deprecated) | `0x09bE1692ca16e06f536F0038fF11D1dA8524aDB1` | `Telcoin` / `TEL`, 2 decimals (unchanged) |

## Upgrade and bridge contracts (identical address on Ethereum, Polygon and Base)

| Name | Address | Role |
|---|---|---|
| `TokenMigration` | `0x2703E00cAE30A7707e4d18C38f8CB6A4a40c2703` | Phase 1 upgrade: escrows the caller's whole legacy balance and mints v3 1:1. The FAQ calls it the "upgrade contract". Window currently expires 2027-09-24 (governance can extend). |
| `MigrationVault` (ERC-1967 proxy) | `0x222213DeB441C5A9F71Df2942db431978a733333` | Phase 2 long-tail upgrade from a pre-funded reserve after Phase 1 closes. |
| `TelcoinBridge` | `0x6A7E6616653e84eee0c70257eC2E3d79A4476a7e` | LayerZero OFT: burns v3 on the source chain, mints on the destination. |
| `MintBurnWrapper` | `0x4A1c2ab0661651Ee55C41DB1239F292e00C3D149` | Approve target / mint-burn adapter for the bridge. |

Owner of `TelcoinBridge` on all three chains is the Association governance Safe
`0x6012dBcb4350Ab297FeB7f96D4d86258062aeB03` (read on-chain via `owner()`; it is also the deployer Safe named in
`telcoin-laboratories-contracts/script/telx/README.md`). It holds no TEL.

## How each address was verified

Sources (authoritative, cross-checked against each other):

1. Official upgrade portal, FAQ: <https://tel3.telcoin.network/faqs> (token, upgrade contract, legacy addresses).
2. Official upgrade portal, bridge page: <https://tel3.telcoin.network/bridge> (token, bridge, wrapper).
3. Telcoin Association repo `tel-v3`: <https://github.com/Telcoin-Association/tel-v3> —
   `deployments/{ethereum,polygon,base}.json` (all five addresses) and `docs/migration-integration.md`.
4. Telcoin Association constitution preamble, <https://www.telcoin.org/docs/telcoin-association-constitution.pdf>,
   and the TELIP / TGIP threads on <https://forum.telcoin.org> (TELIP "The TEL Token Upgrade"; "TGIP Voting Guide").
5. Etherscan token page for v3: <https://etherscan.io/token/0x7E13B43065380aCdeC1c2d138c579cbBbafA0731>
   (contract `TelcoinV3`, source verified, "Token Contract (WITH 18 Decimals)").

On-chain checks (2026-10-18, Ethereum block 26,223,058 / Polygon 95,776,411 / Base 52,790,308):

* v3 on all three chains: `name()` = `Telcoin`, `symbol()` = `TEL`, `decimals()` = 18, identical 16,172-byte runtime code.
  `totalSupply()`: Ethereum 3,557,591,836.26 · Polygon 19,258,707,311.05 · Base 182,591,114.83 TEL.
* Wiring read from the contracts, not from docs: `TokenMigration.oldToken()` returns the chain's legacy token and
  `.telcoinV3()` the v3 token; `MigrationVault.OLD_TOKEN()/NEW_TOKEN()` return the same pair;
  `TelcoinBridge.token()` and `MintBurnWrapper.token()` return v3. All five contracts have code on all three chains.
* Source verification: all five verified on Ethereum (Blockscout); `TokenMigration`, `TelcoinBridge`,
  `MintBurnWrapper` and v3 matched on Polygon and Base (Sourcify). `MigrationVault` on Polygon/Base was not found
  on Sourcify, but it is the same CREATE3 address as the verified Ethereum proxy and its token wiring was read
  on-chain as above.
* Legacy tokens: names, symbols and 2 decimals re-read; unchanged.

Note: the page `telcoin.org/documentation/telcoin-platform/telcoin-tel-token` already shows the v3 address but
still says "Decimals: 2". That is a stale doc row; the chain says 18.

## Not mapped (unverified or not live), do not treat as confirmed

| Item | What the sources say | Why it is not in `chains.json` |
|---|---|---|
| Telcoin Network native TEL | ERC-20 precompile at `0x00000000000000000000000000000000000007e1` (tn-contracts `SECURITY.md`). | Network was not live as of the July 2026 voting guide; no public mainnet explorer/RPC to check against. |
| Telcoin Network system contracts (`WTEL 0x…37E1`, `StakeManager`/`ConsensusRegistry 0x07e1…07e1`, `Issuance 0x07a0…07a0`, Safe suite) | `Telcoin-Association/tn-contracts` `deployments/deployments-mainnet.json` genesis config. | Genesis config in a repo, not observed on a live chain. |
| TELx v4 `PositionRegistry` `0x00637FBbae593E920B1d08300EC1f05d6D61Aa61`, `TELxSubscriber` `0xD9e2c4A560ba8FD0f28A5Bf25B3940576cc53fEC` | Predicted CREATE3 addresses in `telcoin-laboratories-contracts` (`script/telx/README.md`). | `eth_getCode` returns empty on Ethereum, Polygon and Base: **not deployed yet**. |
| New TELx / DEX pools for v3, new TAN staking contract | TELIP says the councils will update TAN and TELx contracts. | No address published yet. The existing Polygon staking proxy `0x92e43Aec…6330` is unchanged and still has code, but it holds legacy TEL. |
| LayerZero endpoint, DVN set | In `tel-v3` docs. | Infrastructure, not needed by this site. |

## Deprecated

* The three legacy TEL contracts above. The holder pipeline now tracks them together with TEL v3 (see "Supply
  accounting"); `tokenAddress`/`decimals: 2` in `config/chains.json` still point at the legacy token for the scripts
  that only read the legacy token.
* The Sepolia/Base Sepolia addresses in `tel-v3/docs/bridge-integration.md` are testnet only; never use them.

## Supply accounting: legacy + v3 = 100B

Implemented 2026-10-18 (`scripts/lib/telTokens.js`, `v3Scan.js`, `supply.js`, `reconcileSupply.js`).
Re-derive the table below from the chains at any time with `node scripts/verify-tel-supply.js`
(keyless public RPCs, no repo data needed).

### What the chains say

All three chains read at the last block at or before **2026-10-19 03:44:05 UTC** (one instant, because v3 crosses
chains by burn-and-mint and reading each chain at its own "latest" shows bridge traffic as phantom supply):

| | Ethereum (26,224,012) | Polygon (95,784,065) | Base (52,796,049) | Total |
|---|---:|---:|---:|---:|
| Legacy TEL `totalSupply` (2 dec) | 100,000,000,000.00 | 38,889,754,532.20 | 888,595,049.09 | 139,778,349,581.29 |
| TEL v3 `totalSupply` (18 dec) | 3,557,333,552.74 | 19,271,543,982.98 | 183,445,719.33 | 23,012,323,255.05 |
| Legacy held by TokenMigration + MigrationVault | 3,779,440,827.66 | 19,110,053,421.21 | 123,053,750.56 | 23,012,547,999.43 |
| ... of which swapped (v3 minted in the same tx) | 3,779,440,827.66 | 19,109,828,676.83 | 123,053,750.56 | 23,012,323,255.05 |
| ... of which stranded (sent in, never swapped) | 0.00 | 224,744.38 | 0.00 | 224,744.38 |
| v3 held by the upgrade contracts | 0 | 0 | 0 | 0 |
| Legacy locked in the labelled Ethereum bridge locks | 39,779,492,726.52 | | | |

```
Σ legacy supply, all chains                              139,778,349,581.29
− legacy retired into v3 (swapped)                        23,012,323,255.05
+ v3 supply, all chains                                   23,012,323,255.05
= TEL held on the chains (legacy + v3, no overlap)       139,778,349,581.29
− legacy mirrors backed by the Ethereum locks             39,778,349,581.29   (Polygon + Base legacy supply)
= TOTAL TEL                                              100,000,000,000.00
```

The Ethereum bridge locks hold 1,143,145.23 TEL more than the Polygon + Base legacy mirrors (39,779,492,726.52 vs
39,778,349,581.29): bridge transfers in flight / the mirrors' own drift. It is published as `mirrorResidual`, not netted
into the total.

The v3 replay is also checked against the chain: the balances rebuilt from the v3 `Transfer` logs sum to each
chain's `totalSupply()` exactly, so the log scan is complete.

### Why legacy + v3 would be 123B+ without netting

A swap moves legacy TEL from the holder into `TokenMigration` (where it stays forever) and mints the same amount of
v3 to the holder. If both sides are counted, every swapped TEL is counted twice: the ~23.0B swapped so far would
push the three-chain sum from 100B to ~123.0B. (The ~103.08B seen in an earlier local run is a different, smaller
overshoot, consistent with the committed staker feed being stale: 4.17B attributed to stakers vs 0.80B actually
staked once holders unstaked to upgrade, see `docs/PIPELINE-RECOVERY.md`. Refreshing `funding-wallets.json` removes
that part; v3 netting handles the swapped part.)

### Design: how double counting is avoided

1. **Balance = legacy + v3, per token decimals.** `combineChainBalances` scales legacy (decimals from
   `chains.json`, 2) and v3 (18) to a common integer precision with BigInt, adds them per wallet and converts to TEL
   (6 dp). Nothing is hardcoded to 2 decimals. Dust floor: one legacy raw unit (0.01 TEL), on the combined balance.
2. **Swapped legacy is retired.** A legacy `Transfer` *into* `TokenMigration`/`MigrationVault` counts as swapped only
   when the **same transaction** also issues v3 (a mint from the zero address, or a release from an upgrade
   contract), capped at the v3 issued in that tx. Retired legacy is subtracted from that contract's wallet. Whatever
   is left on the contract (the 224,744.38 TEL Polygon transfer that had no v3 mint) is stranded, not swapped, so it
   stays counted: once, on the contract's own wallet. This is determined from the logs, not assumed from balances.
3. **Both contracts are `escrow`-labelled** in `config/exclusions.json` (global exclusions), so even their remainder
   is never retail. The remainder is the only thing the `escrow` bucket gains (224,744 TEL); the swapped TEL is
   counted as v3 in the swapper's wallet.
4. **Supply identity.** `totalSupply` = legacy supply on Ethereum (all 100B was minted there; every other balance
   is a mirror of it or a 1:1 re-issue as v3). `byChain` parts still sum to it. The independent cross-check
   `crossCheckTotal = Σ chains (legacy − retired + v3) − Ethereum bridge locks` must land on it too, and the
   residuals are published: `mirrorResidual` (legacy mirror supply vs bridge locks), `v3Residual` (v3 supply vs
   legacy retired, ≈ 0 apart from bridge traffic in flight) and, in `supply-reconciliation.json`,
   `residualParts.upgradeUnbacked`. A `v3Residual` above 0.01% of supply logs a warning.
5. **Bridging.** v3 crosses chains by LayerZero burn-and-mint (`TelcoinBridge` + `MintBurnWrapper`), so there is no
   v3 lock contract to double count; Σ v3 supply over chains equals the swapped amount.
6. **v3 deployment blocks** (found on-chain with `eth_getCode` bisection): Ethereum 25,698,794 (2026-08-06),
   Polygon 91,565,963, Base 49,632,434; stored as `tokens.v3.deployBlock`. v3 is checkpointed separately
   (`holders-checkpoint.json` → `chains.<chain>.v3 = {lastBlock, rawBalances, retired}`) and scanned from its deploy
   block, so pre-v3 data is untouched. With no `tokens.v3` config the pipeline behaves exactly as before.
7. **History.** Rows before 2026-08-06 are exact (v3 = 0). Rows between the v3 deployment and the first v3-aware
   run are legacy-only (swapped TEL sits on TokenMigration, counted as retail) and are left as published: applying
   the escrow label backwards without adding v3 would remove up to ~19B of swapped TEL from retail. See the
   `2026-10-18-tel-v3-upgrade-escrow` changelog event (`backfillStatus: "not-possible"`) for what a full backfill
   needs. `--as-of` rebuilds refuse dates on or after the v3 deploy block.

### Polygon scan start (found while reconciling)

Even with v3 netted, the scan reached only 99.70B (mirror residual −299.5M): the Polygon legacy scan started at block
21,500,000 but the token was deployed at 11,264,036 (first Transfer 11,356,608; 6.49B minted and 3.69B burned before
21.5M). Balances are replayed from zero, so holders that had not moved since 21.5M were missing: 38,591,385,281.67
counted vs 38,889,754,532.20 on-chain. `fromBlock` is now 11,264,036, checkpoints record their `fromBlock`, and the
legacy part of an older checkpoint is rebuilt. Check with a seeded run (replay 11.26M-21.5M, `balanceOf` at the
head for the 5,177 early holders, scan balances for everyone else): 38,889,742,196.68, within 12,335.52 TEL of
`totalSupply()` (sub-dust balances). After it the published residual is 1,155,480.75 TEL (0.0012%) = 1,143,145.23 (bridge
locks vs mirrors, above) + 12,335.52 (dust floor). See changelog event `2026-10-18-polygon-scan-start-block`.

### Known limits

* **Phase 2 (`MigrationVault`)** holds nothing yet. The code treats a v3 release from the vault in the same tx as a
  legacy deposit into it like a Phase-1 swap, but if the vault's pre-funded v3 reserve is minted *without* retiring
  legacy elsewhere, `v3Residual` will show it (and warn) rather than hide it. Re-verify when Phase 2 opens.
* **Exchange-flow, tier-outflow and DEX scans** (`scan-exchange-flows.js`, `generate-tier-outflows.js`,
  `extend-transfer-caches.js`, `rebuild-history-from-logs.js`) still read only the legacy token, so flows of v3 are
  not in those feeds yet. Balances (including CEX and DEX balances) are v3-aware.
* **First run after merge:** Polygon's legacy checkpoint is rebuilt from block 11,264,036 (~42k getLogs at Alchemy's
  2,000-block cap), and v3 is scanned from the deploy blocks, so it is slower than a daily catch-up. It is a one-off.
* **Native Telcoin Network TEL** is not tracked (no public network yet).
* Pool addresses for v3 liquidity are not in `config/dex-contracts.json` yet, so v3 sitting in a new DEX pool shows
  up as a (large) unlabelled wallet until the pools are added.
