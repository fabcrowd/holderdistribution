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

* The three legacy TEL contracts above. They remain the tracked token in the holder pipeline (`tokenAddress`,
  `decimals: 2` in `config/chains.json` are intentionally unchanged) until the pipeline is taught about v3.
* The Sepolia/Base Sepolia addresses in `tel-v3/docs/bridge-integration.md` are testnet only; never use them.

## Pipeline impact (not changed here, needs a decision)

1. **The migration contract is the largest "holder" in the legacy data.** On 2026-10-18 `TokenMigration` held
   legacy TEL of 3,777,095,818.94 (Ethereum), 19,098,965,437.02 (Polygon) and 123,053,750.56 (Base). The last
   published snapshot (`public/data/tel-holders.json`, 2026-10-02) already lists it at 19.30B TEL, unlabelled, so
   it is counted as a retail wallet. `MigrationVault` will hold legacy TEL once Phase 2 starts. Proposed labels
   for `config/exclusions.json` (category `escrow`, evidenceTier `contract-analysis`, confidence `confirmed`):
   `0x2703e00cae30a7707e4d18c38f8cb6a4a40c2703` "Telcoin TEL v3 upgrade contract (TokenMigration)" and
   `0x222213deb441c5a9f71df2942db431978a733333` "Telcoin TEL v3 MigrationVault". This was **not** applied because
   the repo's standing rule requires a matching `classification-changelog.json` entry plus a historical backfill
   (`scripts/check-feed-consistency.js`, step 7), and that needs the data pipeline running.
2. `tokenAddress`/`decimals` are single-valued per chain, so balances of v3 (18 decimals) are not tracked. Adding
   v3 means summing legacy + v3 per wallet with a per-token decimals scale, and rethinking the supply identity
   in `scripts/lib/supply.js` (which assumes Ethereum is the only mint chain and total supply is 100B).
3. Stakers must unstake before upgrading, so legacy-denominated staking numbers will fall as upgrades proceed.
