# Solana chain support — design

- **Date:** 2026-10-25
- **Status:** Approved design (not implemented)
- **Related:** [Wrapped / bridged tokens design](./2026-10-25-wrapped-bridged-tokens-design.md), `docs/MULTI-TOKEN.md`

## Goal

Run the full holder pipeline (holders, tiers, history, combined view) for a
mapped project's Solana deployment, using the same feed shapes the site already
reads for EVM chains.

Solana work runs **only when a mapped project lists a Solana chain** in its
`chains[]`. Nothing Solana-related runs for TEL, or for any project, until
that happens. TEL output stays byte-for-byte the same.

## Background: what assumes EVM today

- `config/projects/<slug>.json` `chains[]` entries carry `chainId`, `fromBlock`,
  `tokens[].address` (0x hex), `tokens[].deployBlock` and `contracts{}` with
  `role`. Everything downstream assumes these are EVM.
- `scripts/lib/rpc.js` assumes EVM JSON-RPC (`eth_blockNumber`, `eth_getLogs`,
  `eth_call`). Key pools come from `<PREFIX>_RPC_0..9`, with public fallbacks
  from `PUBLIC_RPC_FALLBACKS`, `chains[].rpc.publicUrls` or
  `PUBLIC_RPC_URLS_<CHAIN>`.
- Holder scans (`pull-holders-rpc.js`, `v3Scan.js`, history/replay helpers)
  rebuild balances from ERC-20 `Transfer` logs.
- Addresses get lowercased all over (`toLowerCase()` in `supply.js`,
  `tokenChains.js`, exclusion and classification matching). That is safe for hex
  addresses but **corrupts base58 Solana addresses**.
- Explorer links are built as `<explorer>/token/<address>` and
  `<explorer>/address/<address>`.
- `scripts/lib/tokenChains.js` (`detect-token-chains`) probes EVM chains only.
- Feeds: `holders-lite.json` has `views.combined` plus `views.<chainKey>`;
  history and transitions keep per-chain data under `chains.<chainKey>`.

## Architecture (approach A: an adapter per ecosystem)

```
config chains[] ──► chain adapter registry (by vm)
                      ├─ evm    → existing scanners (unchanged)
                      └─ solana → scripts/lib/solana/* (new)
                 ──► normalized per-chain holder sets
                 ──► existing feed writers (views.<key>, chains.<key>, combined)
```

- **Adapter selection:** each chain entry resolves `vm` (default `"evm"`). A
  small registry (`scripts/lib/chainAdapters.js`) maps `vm` to an adapter that
  exposes the same interface:
  - `health(chain)`: is the RPC pool usable?
  - `tokenMeta(chain, token)`: symbol, decimals, supply
  - `scanHolders(chain, token, { asOf? })`: `[{ address, balance, raw }]`
  - `explorerUrl(chain, kind, id)`: kind is `token`, `address` or `tx`
  - `normalizeAddress(chain, address)`
- **EVM adapter:** wraps today's code paths without changing behavior.
  `normalizeAddress` lowercases.
- **Solana adapter** (new, under `scripts/lib/solana/`):
  - `rpc.js`: Solana JSON-RPC client that follows the same pool rules as
    `scripts/lib/rpc.js` (see Config).
  - `splScanner.js`: SPL Token and Token-2022 holder scan for a mint.
  - `metadata.js`: reads decimals and supply from the mint account, and
    name/symbol from Metaplex Token Metadata when the mint has no
    Token-2022 metadata extension.
  - `normalizeAddress` returns the address unchanged (base58 is
    case-sensitive). It only trims whitespace and checks for valid base58 of
    32-byte length.
- **Feed writers stay shared.** The Solana adapter emits the same normalized
  holder records, so `holders-lite`, holder history, transitions, tiers and the
  combined view are produced by the existing writers keyed by `chains[].key`
  (for example `views.solana`, `chains.solana`).

## Config changes

All fields are optional and additive. A project with no Solana chain needs no
edits.

On a `chains[]` entry:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `vm` | `"evm" \| "solana"` | `"evm"` | Picks the adapter. A chain with `key: "solana"` and no `vm` is treated as `vm: "solana"`. |
| `cluster` | `"mainnet-beta"` | `"mainnet-beta"` | Solana only. Devnet and testnet are not supported. |
| `explorer` | string | n/a | Base URL, as today. |
| `explorerTemplates` | `{ token?, address?, tx? }` | per-vm default | URL templates using `{address}` / `{tx}`. Solana default: Solscan (`https://solscan.io/token/{address}`, `https://solscan.io/account/{address}`, `https://solscan.io/tx/{tx}`). EVM default reproduces today's `/token/{address}` and `/address/{address}`. |
| `rpc.publicUrls` | string[] | built-in fallback | As today; for Solana, overrides the built-in public endpoint list. |
| `bridge` | `"native" \| "lock-mint" \| "burn-mint"` | `"native"` | Supply netting. See the [wrapped/bridged design](./2026-10-25-wrapped-bridged-tokens-design.md#config-changes). |

On `chains[].tokens[]` for a Solana chain:

| Field | Meaning |
| --- | --- |
| `address` | Mint address in base58, stored **exactly as written** (never lowercased). |
| `program` | `"spl-token" \| "token-2022"`. Optional; detected from the mint account's owner when missing. |
| `decimals` | Optional; read from the mint when missing. |
| `generation`, `status` | Same meaning as EVM. |

EVM-only fields (`chainId`, `fromBlock`, `deployBlock`) are ignored for
`vm: "solana"`. Validation (`scripts/lib/projects.js`) rejects a Solana entry
that has them set to avoid confusion.

`contracts{}` on a Solana chain lists program-owned or escrow **token accounts
or owner wallets** with the same `role` values (`escrow`, `bridge`, `cex`,
`dex`, `staking`). These feed the same non-retail and exclusion sets.

**RPC environment (matches EVM):**

- Key pool: `SOLANA_RPC_0` … `SOLANA_RPC_9` (the existing `rpcEnvPrefix` rule
  applied to key `solana`).
- Public fallback: built-in `https://api.mainnet-beta.solana.com`, overridable
  with `chains[].rpc.publicUrls` or `PUBLIC_RPC_URLS_SOLANA`.
  `PUBLIC_RPC_FALLBACK=off` and `RPC_PREFER_PUBLIC=1` behave the same as for EVM.
- Public RPC is tried first, as decided. Paid keys are optional and only add
  throughput or reach for `getProgramAccounts`.

## Data flow

1. **Load project.** `projectChains(project)` returns entries with a resolved
   `vm`. If no entry is `solana`, the Solana adapter is never imported and
   nothing changes.
2. **Health.** `getHealth` / `getSlot` on each pool URL. Unusable URLs are
   dropped, as `getUsableRpcUrls` does today.
3. **Mint metadata.** `getAccountInfo(mint, jsonParsed)` returns the owner
   program (SPL vs Token-2022), decimals and supply. Name/symbol come from the
   Token-2022 metadata extension, or from the Metaplex metadata PDA when that
   is missing.
4. **Holder scan (snapshot).**
   `getProgramAccounts(<tokenProgram>, filters: [dataSize(165) for SPL, memcmp(offset 0 = mint)])`
   with `jsonParsed`. Token-2022 accounts can be larger, so that path uses only
   the memcmp filter. Accounts with a zero balance are dropped.
5. **Aggregate by owner.** A wallet can hold several token accounts (ATA plus
   others). Balances are summed per **owner** address, which becomes the holder
   identity. That matches what EVM addresses mean in the feeds.
6. **Classify.** Owners and token accounts in `contracts{}`, exclusions or
   classification lists are matched case-sensitively and marked non-retail by
   role.
7. **Write feeds.** `views.solana` in `holders-lite`, `chains.solana` in history
   and transitions, and tier buckets through the existing writers.
   `chainOrder` follows `chains[]` order.
8. **Combined.** `views.combined` merges every configured chain. Holder
   overlap/dedup runs **within** an address format only: EVM addresses dedupe
   across EVM chains, and Solana owners never match an EVM address. The
   combined unique holder count is the EVM unique count plus the Solana owner
   count. Supply netting follows the
   [wrapped/bridged design](./2026-10-25-wrapped-bridged-tokens-design.md#data-flow).
9. **History.** Daily snapshots append to holder history the same way EVM
   snapshots do (one point per run). Back-filling Solana history before the
   first snapshot is not part of this design.

## Error handling

- **No usable RPC:** that chain's step fails with a clear message
  (`RPC pool solana: no usable endpoint`). Other chains still publish. The
  previous `views.solana` is kept, and chain status
  (`scripts/lib/chainStatus.js` / `write-chain-status.js`) marks Solana stale.
  This matches current EVM behavior.
- **`getProgramAccounts` rejected or too large on public RPC:** retry on the
  next pool URL. If every URL fails, log a hint to set `SOLANA_RPC_*`. Never
  publish a partial holder set as complete.
- **Rate limits (429):** back off and rotate URLs with the shared retry rules in
  `rpcCall`.
- **Invalid mint/address:** fail config validation before any network call.
- **Metadata missing:** use `tokens[].symbol` / project `ticker` and continue.
  Decimals come from the mint and are never guessed.
- **Supply sanity:** the existing max-supply tolerance check still runs on the
  netted total (see the wrapped/bridged spec). The pipeline refuses to publish
  a wrong denominator.

## Testing

- **TEL regression:** existing tests (693 at PR #39) stay green. Add a snapshot
  test asserting that TEL's `projectChains` resolve to `vm: "evm"` and that the
  feed outputs for a fixture are unchanged.
- **Config:** `projects.test.js` covers `vm` defaulting, `key: "solana"`
  inference, rejection of EVM-only fields on Solana, and that base58 addresses
  round-trip without case changes.
- **Address handling:** a test that a Solana address passes through classify,
  exclusions and explorer URL building with its case preserved.
- **Solana scanner:** unit tests with stubbed RPC responses for SPL and
  Token-2022 (multiple token accounts per owner, zero balances, decimals,
  Token-2022 extension metadata, Metaplex fallback).
- **Adapter registry:** an EVM-only project never loads `scripts/lib/solana/*`.
- **Combined merge:** a fixture with EVM and Solana chains checks that the
  unique holder count and per-chain views are right.
- **Explorer templates:** default Solscan links, custom templates, and
  unchanged EVM default links.
- No live-network tests in CI. There is an optional manual smoke script against
  a known mint.

## Out of scope

- The forensics paywall.
- Non-EVM ecosystems other than Solana (Cosmos, Bitcoin, Sui, Aptos, etc.).
- Scheduled or cron chain discovery.
- Automatically writing `chains[]`. Discovery stays advisory.
- Solana staking or gated forensics views. They can be added per project
  later.
- Back-filling Solana holder history from transaction logs.
- Solana support for exchange-flow and wallet-flow scans.

## Open questions

- **Public RPC limits.** `api.mainnet-beta.solana.com` may reject
  `getProgramAccounts` for mints with many holders. When a real Solana project
  is mapped, decide whether a free-tier key in `SOLANA_RPC_0` is needed.
