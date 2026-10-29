# Solana token-flows scanner — WIP

No scanner implementation landed in this run. `scripts/scan-solana-flows.js` is still the dry-run stub (writes `data/<slug>/solana-flows-sample.json` only). ZBCN `public/data/zebec-network/tier-outflows.json` and `exchange-flow-history.json` are still the empty placeholders from PR #48. TEL’s EVM path was not changed.

This note is the handoff. It is not a design to implement from scratch without reading the files below.

## What already exists

- `scripts/lib/solana/tokenFlows.js` — `mintDeltasByOwner` (per-tx mint deltas) and `classifyFlow` (cex/dex tag). Covered by `tokenFlows.test.js`.
- CEX venues: `config/projects/zebec-network/cex-wallets.json` via `classification.cexWallets` (base58, case-sensitive).
- DEX venue: `contracts.orcaWhirlpoolWsolZbcn` in `config/projects/zebec-network.json` (`role: "dex"`). There is no ZBCN `dex-contracts` file.
- `generate-tier-outflows.js` and `scan-exchange-flows.js` skip Solana (`projectChains` is EVM-only). With zero EVM chains they publish empty feeds and force `complete: false`.
- `.github/workflows/refresh-zebec-network.yml` does **not** call `scan-solana-flows.js`. `SOLANA_RPC_0` is only on the staking and holder steps.
- Holder snapshots for ZBCN start **2026-10-25** (`git log` on `public/data/zebec-network/tel-holders.json`). Do not invent earlier history.

## What a live probe showed (2026-10-29, public mainnet RPC)

Public `https://api.mainnet-beta.solana.com` answered `getTokenAccountsByOwner`, `getSignaturesForAddress`, and `getTransaction` (`jsonParsed`). It also returned HTTP/JSON-RPC 429 on a 10-call `getTransaction` batch. This environment has no `SOLANA_RPC_0`.

In-window signature counts (since 2026-10-25 UTC) for three venues:

| Venue | Token account | Signatures in window |
|---|---|---|
| Crypto.com `6FEVkH…51Jy` | `9LDLfNpN…` | 5 (one page, reached the floor) |
| MEXC `ASTyfSim…iaJZ` | `17Lv34SN…` | 141 (one page) |
| Orca WSOL-ZBCN whirlpool `FaoZEZFs…Y79w` | `22PKBgeA…` | 8000+ and still above the floor (8 pages, truncated) |

A full whirlpool backfill is thousands of `getTransaction` calls. Bounded, checkpointed runs are required. Helius (`SOLANA_RPC_0`) is the intended CI endpoint.

`getTransaction` token balances match `mintDeltasByOwner`: `meta.preTokenBalances` / `postTokenBalances` with `uiTokenAmount.amount`, owner = wallet/PDA, `accountIndex` into `message.accountKeys[].pubkey`.

## Remaining steps

1. Replace the stub in `scripts/scan-solana-flows.js` (keep `ported: true`). For each CEX owner and each `contracts{}` `role: "dex"` owner: `getTokenAccountsByOwner(mint)` → `getSignaturesForAddress` → `getTransaction` → `mintDeltasByOwner` + `classifyFlow`.
2. Track progress **by signature** in `data/<slug>/solana-flows-checkpoint.json`. Resume with `before` / `until`. Dedup a tx that touches two scanned token accounts (attribute once). Stop at the earliest holder-snapshot date (`SOLANA_FLOWS_SINCE` / `--since` override). Budget with `SOLANA_FLOW_MAX_TX`.
3. Write the TEL day-store shape to `data/<slug>/tier-outflows-days.json` (schema 9: per day, per tier, `dex` / `cex` / `moved`, `inflows`, `byChain.solana`, `byExchange`). Write exchange day buckets to `data/<slug>/solana-exchange-flow-days.json` (`in` / `out` / `dexIn` / `dexOut`). Do not publish `public/data` from the scanner.
4. When `projectChains` is empty, `generate-tier-outflows.js` rolls that day store up and sets `complete: true` only if the checkpoint shows every venue walked from the tip back to the snapshot floor. `scan-exchange-flows.js` publishes exchange history from the Solana day store instead of an empty file. Leave the EVM branch byte-for-byte alone.
5. In `refresh-zebec-network.yml`, run `node scripts/scan-solana-flows.js` in **Generate feeds** before `scan-exchange-flows.js` and `generate-tier-outflows.js`, with `SOLANA_RPC_0` (and `ENV_PASSPHRASE`). A scan failure must not wipe the last checkpoint. Stage `data/solana-flows-checkpoint.json` and `data/solana-exchange-flow-days.json` in the commit file list.
6. Update `docs/MULTI-TOKEN.md` (the “empty on purpose / scaffold” paragraphs). Keep `scripts/lib/zebecFlowFeeds.test.js` honest: `complete: false` and empty tiers until a real checkpoint exists.
7. Vitest: cursor + attribution unit tests, plus TEL regression (non-empty `public/data/tier-outflows.json` / `exchange-flow-history.json` unchanged). Then backfill from 2026-10-25 forward — measured rows only.

Venue-anchored scanning sees CEX and DEX legs. Wallet-to-wallet moves that never touch a listed venue are out of scope for this scanner.
