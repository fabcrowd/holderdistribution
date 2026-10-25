# ZBCN CEX wallet candidates (owner-approved 2026-10-25 — classified)

> **Owner-approved 2026-10-25:** all 11 candidates below are approved and classified as CEX via `config/projects/zebec-network/cex-wallets.json` (`classification.cexWallets`). Scheduled sync still needs a Solana-only `pipeline.duneCexQueryId` (never TEL 3761086).

> _Superseded:_ this list was candidates-only until owner approval on 2026-10-25; these 11 wallets now publish in `public/data/zebec-network/cex-wallets.json` and are excluded from retail.

- Generated: 2026-10-25T18:19:32.906Z (UTC) by
  `node scripts/sync-cex-wallets-dune.js --project zebec-network --candidates --source spellbook`
- Machine-readable: `data/zebec-network/cex-dune-candidates.json`
- Source: Dune spellbook model `cex_solana.addresses` (the static table Dune serves through
  `cex.addresses` for `blockchain = 'solana'`), raw file
  `dbt_subprojects/hourly_spellbook/models/_sector/cex/addresses/chains/solana/cex_solana_addresses.sql`
  at spellbook `main` (last commit touching it: `447a87c`, 2026-10-19). Labels are Dune community
  labels (added_by `hildobby`), not exchange attestations.
- Holder snapshot: `public/data/zebec-network/tel-holders.json` generated 2026-10-25T17:33:32.003Z (UTC),
  111,519 owner-keyed holders. Match is exact base58 (case-sensitive) on the token-account **owner**.

## Result

112 labelled Solana CEX addresses → **11 hold ZBCN**, together
3,125,956,364 ZBCN (~3.13% of supply).

| Holder rank | Owner address | Exchange | Dune label | ZBCN | % supply |
|---:|---|---|---|---:|---:|
| 7 | [`6FEVkH17P9y8Q9aCkDdPcMDjvj7SVxrTETaYEm8f51Jy`](https://solscan.io/account/6FEVkH17P9y8Q9aCkDdPcMDjvj7SVxrTETaYEm8f51Jy) | Crypto.com | Crypto.com 1 | 2,062,785,706 | 2.0628% |
| 11 | [`u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w`](https://solscan.io/account/u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w) | Gate.io | Gate.io 6 | 847,593,209 | 0.8476% |
| 67 | [`ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ`](https://solscan.io/account/ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ) | MEXC | MEXC 1 | 88,764,725 | 0.0888% |
| 91 | [`BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6`](https://solscan.io/account/BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6) | KuCoin | KuCoin 2 | 60,207,901 | 0.0602% |
| 116 | [`AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS`](https://solscan.io/account/AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS) | Crypto.com | Crypto.com 2 | 36,690,614 | 0.0367% |
| 238 | [`A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR`](https://solscan.io/account/A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR) | Bitget | Bitget 1 | 17,694,957 | 0.0177% |
| 351 | [`Fe7SEekiKygziaEGKxsDsgLVzrCfNvVBvAYsaJBwFA8s`](https://solscan.io/account/Fe7SEekiKygziaEGKxsDsgLVzrCfNvVBvAYsaJBwFA8s) | Swissborg | Swissborg 2 | 12,188,972 | 0.0122% |
| 40640 | [`GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE`](https://solscan.io/account/GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE) | Coinbase | Coinbase 3 | 24,245 | 0.0000% |
| 54221 | [`2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm`](https://solscan.io/account/2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm) | Coinbase | Coinbase 2 | 5,400 | 0.0000% |
| 66204 | [`5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9`](https://solscan.io/account/5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9) | Binance | Binance 1 | 534 | 0.0000% |
| 83940 | [`9uyDy9VDBw4K7xoSkhmCAm8NAFCwu4pkF6JeHUCtVKcX`](https://solscan.io/account/9uyDy9VDBw4K7xoSkhmCAm8NAFCwu4pkF6JeHUCtVKcX) | FTX | FTX 3 | 100 | 0.0000% |

## Review notes

- **Material:** Crypto.com 1 (#7, ~2.06B) and Gate.io 6 (#11, ~848M) are ~91% of the matched balance;
  MEXC 1, KuCoin 2, Crypto.com 2, Bitget 1, Swissborg 2 are mid-size. Suggest Solscan-label check of each before approve.
- **Dust:** Coinbase 2/3, Binance 1 and FTX 3 (defunct exchange) hold < 25k ZBCN — classifying them is harmless but immaterial.
- **Coverage gap:** this only finds wallets Dune has labelled. Exchanges listing ZBCN with no labelled Solana
  hot wallet here (e.g. Bybit, any Binance ZBCN-specific wallet) are not found; the top holder `5rhms6jZ…` (~20.55B)
  is not in the Dune list. Unlabelled custodial wallets need the fan-in/fan-out path (`detect-cex-candidates`, EVM-only today) or Solscan labels (Phase 4b stream).
- **Approve path:** owner picks rows → create e.g. `config/projects/zebec-network/cex-wallets.json` with
  `{ "wallets": [{ "address", "label", "walletName" }] }` (base58 as written), add
  `classification.cexWallets` to `config/projects/zebec-network.json`, then `pull-cex-wallets --project zebec-network`.
  Not done here.

## Dune query the owner still needs (for the scheduled sync)

No ZBCN Dune query id exists yet, so `pipeline.duneCexQueryId` is **not set** and the default
`--source dune` run exits 2 with a TODO. To enable it, save this query in Dune and put its id in
`pipeline.duneCexQueryId` (or `DUNE_QUERY_ID`):

```sql
-- ZBCN CEX labels (Solana). Output columns map 1:1 to sync-cex-wallets-dune.js.
SELECT blockchain, address, cex_name, distinct_name
FROM cex.addresses
WHERE blockchain = 'solana'
```

The holder intersect is done locally against the pipeline's own snapshot, so the query does not need to
join ZBCN balances. Never reuse TEL's query 3761086 (EVM).
