# Hedera (HBAR) exchange account candidates

Research 2026-11-11. Owner acceptance rule (2026-11-08): an exchange's own proof-of-reserves first, then HashScan labels the owner has reviewed. Verified addresses only. Nothing here is in any config until the owner accepts it. Balances are from the public mirror node on 2026-11-11.

## Meets the rule (exchange-published)

| Account | Exchange | Source | HBAR |
|---|---|---|---|
| 0.0.615421 | Bybit | [Bybit proof-of-reserves report 2026-10-27 (Hacken)](https://www.bybit.com/common-static/cht-static/por/Bybit_PoR_Audit_2026_Oct_27.pdf), verified-wallets table row "Hedera 0.0.615421" (checked in the PDF text) | 297,249,729 |

HashScan has no public labels on mainnet (its live config loads no label list), so the rule's second tier is empty today.

## Third-party only (HashPack wallet support list): owner decision needed

Source: [HashPack, Exchange deposit addresses](https://hashpackapp.zendesk.com/hc/en-us/articles/27512469973777-Exchange-deposit-addresses). HashPack says the list is "not proof of current control" and not exhaustive.

| Account | Exchange (per HashPack) | HBAR |
|---|---|---|
| 0.0.1872300 | Upbit (also 0.0.37073) | 1,695,241,077 |
| 0.0.1268012, 0.0.6942669, 0.0.611791 | Crypto.com | 482,751,312 / 488,510,471 / 5,673,792 |
| 0.0.10358775 | Kraken | 296,272,354 |
| 0.0.1873771, 0.0.16852, 0.0.16853, 0.0.1030878 | Binance | 71,772,786 / 19,274 / 0 / 32 |
| 0.0.858938 | MEXC | 66,622,979 |
| 0.0.29000 | Gate | 49,454,020 |
| 0.0.1155594, 0.0.1133968, 0.0.1134089 | Coinbase | 9,944,339 / 1,154,934 / 444,318 |
| 0.0.1686714, 0.0.1686716, 0.0.407219 | KuCoin | 3,027,676 / 2,985,347 / 13,242 |
| 0.0.615422 | Bybit | 3 |
| 0.0.15852 | OKX | 0 |
| 0.0.50570, 0.0.50571 | HTX (0.0.50570 is "Binance Exchange" in a HashScan staging example; unresolved) | 0 / 3 |

## Large unlabelled accounts (no source names an owner)

- 0.0.640701, 3.14B HBAR: compound (likely multisig) key, created 2022-01-11; numeric memos on incoming transfers look like exchange deposits; trades with HashPack-listed Kraken and Coinbase accounts. Unidentified.
- 0.0.652978, 2.31B HBAR: single key, created 2022-01-19; large counterparties are 0.0.1030878 (HashPack: Binance) and 0.0.9933945. Binance's May 2026 PoR reported about 2.57B HBAR, which fits a Binance cold wallet. Unverified: Binance's PoR page lists reserve addresses but could not be read automatically.

## Not published

OKX, Bitget, HTX (HBAR not in their PoR assets); Gate and Kraken (do not publish addresses); Crypto.com 2022 list (no Hedera); KuCoin 2022 list (no HBAR; a 2026-09-30 list was not read); Coinbase (no address list found).

## Next

The owner checks Binance's proof-of-reserves HBAR address list by hand (it may confirm 0.0.652978 and others), and decides whether the HashPack list is an acceptable tier. With Bybit alone, about 3B+ HBAR on exchanges would still count as retail.
