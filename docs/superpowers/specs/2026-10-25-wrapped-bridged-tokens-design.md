# Wrapped / bridged tokens — design

- **Date:** 2026-10-25
- **Status:** Approved design (not implemented)
- **Related:** [Solana chain support design](./2026-10-25-solana-chain-support-design.md), `docs/MULTI-TOKEN.md`, `docs/TEL-CONTRACTS.md`

## Goal

Net a project's deployments across chains, whether native, bridged or wrapped,
into **one project total** with a per-chain breakdown, the way CoinGecko does.
There is **no separate "wrapped" product line**: no wrapped tab, no wrapped
project and no second market cap.

## Background

**How aggregators handle it**

- CoinGecko lists one coin with a `platforms` map of contract addresses per
  chain. Circulating supply and market cap are reported once for the coin.
  Third-party wrappers that aren't the issuer's own deployment (for example
  "Bridged USDC (…)") are separate listings and are left out of the main
  coin's totals so nothing is counted twice.
- CoinMarketCap uses the same idea: one asset, many contracts, one supply.
- DefiLlama avoids counting bridged copies twice in chain TVL.

**What the repo does today**

- One project, many `chains[]`. The Combined view plus per-chain tabs come from
  `chains[]` (PR #39).
- `scripts/lib/supply.js` already nets TEL. Legacy TEL on Polygon/Base mirrors
  is backed by locks on Ethereum (`contracts` with `role: "bridge"`), so
  locked legacy is subtracted. TEL v3 crosses chains by burn-and-mint, so it
  is summed. The checks are `mirrorResidual` and `v3Residual`.
- `detect-token-chains` (`scripts/lib/tokenChains.js`) reports candidate
  chains from same-address probes and CoinGecko `platforms`. It is advisory
  and never writes config.

This design turns TEL's hand-tuned netting into a generic, config-driven rule.

## Architecture

- **Bridge type per chain entry** (`chains[].bridge`) tells the supply step how
  that chain's supply relates to the origin chain's supply.
- **Supply netting** (`scripts/lib/supply.js`) gets a generic path driven by
  `bridge`. TEL keeps its existing path (see Config changes), so its numbers
  do not move.
- **Holders** are summed per chain. Bridge/escrow addresses are non-retail and
  excluded from retail percentages. The combined unique count follows the
  dedup rules in the [Solana design](./2026-10-25-solana-chain-support-design.md#data-flow)
  (dedup within an address format only).
- **Discovery** proposes candidates only. CoinGecko `platforms` today, bridge
  token lists later. A person confirms each candidate into `chains[]` during
  the map-new-token questionnaire, including its `bridge` type.
- **UI:** Combined plus per-chain tabs, unchanged. The supply panel can show
  "locked in bridge (non-circulating)" using the existing escrow/bridge
  wording. No new product surfaces.

## Config changes

On a `chains[]` entry (EVM or Solana):

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `bridge` | `"native"` \| `"lock-mint"` \| `"burn-mint"` | `"native"` | How this chain's supply relates to the project total. |
| `origin` | boolean | existing | Already used. Exactly one chain is the origin for `lock-mint` netting. |

Rules:

- **`native`:** supply minted directly on this chain, not backed by any other
  chain. **Summed** into the total.
- **`burn-mint`:** tokens are burned on one chain and minted on another, so
  each chain's supply is real and unique. **Summed** into the total.
- **`lock-mint`:** tokens on this (mirror) chain are backed by tokens locked on
  the origin chain. The total counts **source (origin) supply only**. Mirror
  supply is not added, and the origin-side lock/escrow balance is treated as
  **non-circulating**, so holders on the mirror chain are counted once
  instead of twice.
- `bridge` on the origin chain itself is ignored, since the origin is always
  counted.
- Lock and escrow addresses are listed in that chain's `contracts{}` with
  `role: "bridge"` or `role: "escrow"` (existing roles), or in exclusions.
  Validation warns when a project has a `lock-mint` chain but no `bridge`/`escrow`
  contract on its origin chain.

**TEL compatibility.** TEL's chains carry two generations with different
bridge models (legacy is lock-mint, v3 is burn-mint). TEL keeps
`supply.generationsSumOneToOne: true` and its existing `supply.js` path, and
its config is **not edited** by this work. The generic `bridge` path applies to
projects without generation-specific supply rules. `chains[].bridge` is
chain-level, as decided. Per-token overrides are noted under Open questions.

## Data flow

1. **Discovery** (`detect-token-chains`, run manually): it reports candidate
   chain/address pairs from same-address probes and CoinGecko `platforms`.
   When a Solana address appears in `platforms.solana`, it is reported as a
   Solana candidate without lowercasing (see the
   [Solana design](./2026-10-25-solana-chain-support-design.md#config-changes)).
   The report suggests `bridge: "native"` for every candidate and flags that a
   human must confirm the type. It never writes `chains[]`.
2. **Confirm** (map-new-token questionnaire): the operator adds the chosen
   chains with `bridge` and labels lock/escrow contracts.
3. **Per-chain supply:** each adapter reports total supply for the chain's
   canonical token (EVM `totalSupply()`, Solana mint `supply`).
4. **Net:**
   - `total = origin supply + Σ supply(chains where bridge ∈ {native, burn-mint})`
   - Chains with `lock-mint` add 0 to `total`.
   - `nonCirculating += Σ balance(origin bridge/escrow addresses)`, plus the
     existing exclusions.
   - `circulating = total − nonCirculating`.
5. **Backing check** (generalizes TEL's `mirrorResidual`):
   `Σ supply(lock-mint chains) − Σ origin lock balances`. A residual above 1% of
   total is logged as a warning: an unlabelled bridge contract, or a mint
   that's really native.
6. **Sanity:** the existing max-supply tolerance check runs against `total`
   when `supply.target` is set. A mismatch refuses to publish.
7. **Holders:** per-chain holder sets go to the shared writers. Bridge/escrow
   addresses are non-retail on every chain. Combined = all configured chains.

## Error handling

- **Missing `bridge`:** treated as `native`. Validation warns when CoinGecko
  lists the chain as bridged but config says `native` (only when discovery has
  run).
- **Backing residual above 1%:** a warning that names the chain and the
  amount. Feeds still publish (this matches TEL today).
- **Total outside the supply target tolerance:** throw and don't publish (this
  matches TEL today).
- **One chain's supply call fails:** don't publish a netted total that is
  missing a chain. Keep the previous supply feed and mark that chain stale in
  chain status.
- **No origin chain** with a `lock-mint` chain configured: config validation
  error.

## Testing

- **TEL regression:** `supply.test.js` and the feed fixtures are unchanged, and
  the TEL path is selected when `generationsSumOneToOne` is set.
- **Generic netting:** unit tests for `native` + `burn-mint` summing,
  `lock-mint` adding nothing, lock balances counted as non-circulating, the
  backing residual warning, and a mixed EVM + Solana project (Solana as
  `burn-mint` or `native`).
- **Validation:** a `lock-mint` chain without an origin is an error, a
  `lock-mint` chain without an origin bridge/escrow contract is a warning, and
  an unknown `bridge` value is an error.
- **Discovery report:** a CoinGecko `platforms` fixture that includes a Solana
  address keeps its case, the report suggests a `bridge` type, and config is
  never written.
- **Holders:** bridge/escrow addresses are excluded from retail percentages on
  mirror chains.

## Out of scope

- The forensics paywall.
- Bridge token lists (Superchain, Axelar, Wormhole, etc.) as discovery sources.
  These are planned for later, not in this design.
- Scheduled discovery and auto-writing `chains[]`.
- Non-EVM ecosystems other than Solana.
- Tracking third-party wrappers that aren't the project's own deployments as
  part of the project. These are excluded, the same as CoinGecko.
- Migrating TEL onto the generic `bridge` path.

## Open questions

- **Per-token bridge overrides.** Should `chains[].tokens[].bridge` be allowed
  for projects that, like TEL, have generations with different bridge models?
  Defer until a second such project is mapped.
