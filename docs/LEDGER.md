# Developer-wallet ledger

A gated, per-project ledger of every token and stablecoin move by a project's
developer wallets, over 24h / 72h / 30d / 90d windows.

## Files

| What | Where |
| --- | --- |
| Transaction types (labels, meaning, how identified) | `config/ledger-tx-types.json` (shared by scripts and UI) |
| Per-project config | `config/projects/<slug>/ledger.json` |
| Generator | `scripts/build-ledger.js` → `data/<slug>/ledger/ledger.json` + `ledger-checkpoint.json` |
| Bot proceeds trace | `scripts/trace-bot-proceeds.js` → `data/<slug>/ledger/bot-proceeds.json` |
| Nightly workflow | `.github/workflows/refresh-ledger.yml` (02:30 UTC, own concurrency group, `[skip netlify]`) |
| Gate keys | `project-ledger`, `bot-proceeds` (`netlify/functions-src/ledgerSource.ts`) |
| UI | Supply → **Developer wallets** tab (`capabilities.projectWallets`), `src/components/projectWallets/` |

`data/` is never served publicly; the gate reads the committed file from GitHub
with `LIVE_DATA_GITHUB_TOKEN` after the password / admin check.

## Rules

- **Developer selling** = developer-wallet DEX sales + exchange deposits + the
  **developer-funded share** of bot-cluster sales (pro-rata by funding; TEL:
  the Settlement hub's 611,434,638 TEL counts, KuCoin's 1,158,380,277 does not).
- Moves between developer wallets are `internal_shuffle`: listed, never in headlines.
- BitGo / Anchorage and escrow contracts are `custody`, not sales.
- Every event and every proceeds hop carries a tx hash.

## Providers

EVM: Alchemy `alchemy_getAssetTransfers` (keys from `.env.enc` via
`ENV_PASSPHRASE`, or `<PREFIX>_RPC_n`), Etherscan free tier as a count
cross-check (`ETHERSCAN_API_KEY`). Solana: `SOLANA_RPC_0` (Helius) then
`SOLANA_RPC_1` (public). A chain that fails keeps its previous data and is
marked stale in `coverage`; runs are incremental from the checkpoint.

## Running locally

```
node scripts/build-ledger.js --project tel --dry-run          # nothing written
node scripts/build-ledger.js --project zebec-network --max-tx 40 --dry-run
node scripts/trace-bot-proceeds.js --project tel --dry-run
```

Never commit `data/*/ledger` from a laptop; CI owns those files.

## Adding a project

```
node scripts/add-project.js --slug foo --name "Foo" --ticker FOO \
  --chain ethereum:0xTOKEN:18 --wallet 0xDEV:Treasury:treasury --dry-run
```

Writes the registry entry, `config/projects/<slug>.json`,
`config/projects/<slug>/ledger.json` and an empty wallet registry, validates
them, and prints the remaining manual steps. The nightly workflows pick the
project up from `config/projects.json`.

## Onboarding a new token in one prompt

```
node scripts/add-project.js --slug foo --name "Foo Network" --ticker FOO \
  --chain base:0xTOKEN:18            # or --chain solana:<MINT>:<decimals>
  --wallet <address>:<label>[:treasury|holdings|association]   # repeatable
```

That one command writes everything a token needs. No per-token code edits:

| Piece | Where | How it is picked up |
|---|---|---|
| Registry entry | `config/projects.json` | Route `/<slug>`, gate allowlist (`gatedSlugsFrom` in `netlify/functions-src/gatedProjects.ts`), workflow matrix (`workflow-paths.js matrix`) |
| Project config | `config/projects/<slug>.json` with `capabilities.projectWallets: true` | Supply → Developer wallets tab (`showsProjectWallets`), deep link `#supply/project-wallets`; explorer links from `chains[].explorer` (Solscan for Solana) |
| Ledger config | `config/projects/<slug>/ledger.json` | `refresh-ledger.yml` runs `build-ledger.js` + `trace-bot-proceeds.js` for every matrix project that has one |
| Wallet registry | `data/<slug>/forensics/wallet-flows.registry.json` | Wallet flows report |
| Gate keys | `project-ledger`, `bot-proceeds` → `data/<slug>/ledger/*.json` | Same for every project |

`scripts/add-project.e2e.test.js` scaffolds a fake EVM and a fake Solana token and asserts all of the above.

## EVM / Solana parity

Both VMs produce the same `ledger.json` and `bot-proceeds.json` schema and the same UI:

- **Transfers:** EVM via `alchemy_getAssetTransfers` (with the Swap-in-receipt flag). Solana via token-balance deltas: a seller that lost the token and gained a stablecoin or wSOL in the same transaction swapped.
- **Bot proceeds:** EVM uses `proceeds.js` (`traceSale`). Solana uses `solanaProceeds.js` (`traceSolanaSale`), which decodes wallet-held legs the same way the sales journal does. Native SOL and wSOL are folded into SOL. It follows up to `trace.maxHops` hops to a labelled stop. Both feed `summarizeProceeds`.
- **No mapped cluster:** the report is still complete. It has `status`, `evidence: null`, `chains: []`, an empty `summary` and `detection`.
- **Detection:** `botDetect.js` lists unlabelled wallets that developer wallets fund repeatedly. These are candidates only and never counted. Confirm one by adding a `botCluster` with its funding split.
- **Summary bullets:** every figure links to a type+window filter of the transaction list, with an `[n tx]` proof popover. Named entities link to their explorer address, with the chain shown. A claim backed by a single transaction links straight to it (`src/lib/ledgerClaims.ts`).
