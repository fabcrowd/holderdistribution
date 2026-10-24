# Data pipeline: why feeds went stale, and how to recover

Written 2026-10-18 after the feeds sat stale since 2026-10-02.

## What happened (two stacked causes)

1. **Alchemy monthly capacity exhausted (2026-10-03 → 10-13).** Every configured Alchemy key on
   Ethereum/Polygon/Base returned `Monthly capacity limit exceeded`, so
   `pull-holders-rpc.js` failed `3 of 3 chain(s)` and refused to write partial data. The
   failing runs also burned ~50 billed Actions minutes each on the throttled Etherscan fallback.
2. **GitHub Actions blocked at the account level (2026-10-14 → now).** Every job fails in ~3 s with
   no steps. The check-run annotation reads: *"The job was not started because recent account
   payments have failed or your spending limit needs to be increased. Please check the 'Billing &
   plans' section in your settings."* This repo is private, and the billed minutes for 2026-10-01..13
   total ~2,170 against the 2,000 included on the Free plan, with a $0 spending limit.
   Nothing in the repo can bypass this.

Also found: the staker-balance guard refused a real >40 % drop (TEL v3 upgrade forces holders to
unstake legacy TEL; on-chain `totalStaked()` is ~0.80 B vs 4.17 B in the stale feed).

## Fixes in code (branch `fix-stale-feeds`)

* `scripts/lib/rpc.js`: when **every** configured key is dead, fall back to curated keyless public
  endpoints (`PUBLIC_RPC_FALLBACK=off` disables; `PUBLIC_RPC_URLS_<CHAIN>` overrides). `getLogs` now
  bisects on vague "range too large" errors and remembers each URL's working span.
* `scripts/pull-holders-rpc.js`: chunk-level failover across the RPC pool.
* `scripts/pull-staker-balances.js`: a >40 % drop is accepted when the sum reconciles with
  on-chain `totalStaked()`; still refused when it does not (truncated response).
* Workflows: `timeout-minutes` on refresh/watchdog (was 360 default), step cap on the staker step,
  shared `holders-refresh` concurrency group, runners pinned to `ubuntu-24.04`
  (`ubuntu-latest` moves to Ubuntu 26 on 2026-10-19).
* UI: the banner now says "Data feed delayed" with the real age instead of "node offline".

## What a human must do

1. GitHub → Settings → Billing and plans: fix any failed payment and/or raise the **Actions
   spending limit** above $0 (or wait for the monthly reset on the 1st). Or make the repo public
   (Actions minutes are free for public repos). Confirm with a single manual run of
   "Refresh TEL holders snapshot".
2. Alchemy: the keys reset on their billing cycle; upgrade the plan or add keys. Until then the
   public fallback keeps a daily incremental run alive (a 16-day catch-up took ~7 min locally).
3. TEL v3 is now tracked alongside legacy TEL (see `docs/TEL-CONTRACTS.md`, "Supply accounting"). The first v3-aware run scans v3 from its deploy block per chain (a one-off extra scan; keyless public RPCs need ~15 min for it).

## 2026-10-19: daily schedule and live delivery

* Daily commits were not reaching the site at all: `netlify.toml` ignores git builds, so the
  live site served the last manual deploy. Now served through `/live-data/*` (see
  `docs/DEPLOYMENT.md`, "Data pipeline (daily) and live data"), which needs the
  `LIVE_DATA_GITHUB_TOKEN` Netlify env var.
* All daily stages are one job in `refresh-tel-holders.yml`; the other data workflows are
  manual-only and the watchdog is weekly, to fit the 2,000 free Actions minutes/month.
* Manual recovery is unchanged: fix Actions billing, then run *Refresh TEL holders snapshot*
  once (Actions → that workflow → Run workflow). Its commits go live within ~1 h, no deploy.

## 2026-10-23: keyless local refresh (branch `data/refresh-snapshot`)

The published snapshot had been stuck at 2026-10-02. It was regenerated locally
with no API keys at all:

- **Staker balances without Etherscan.** `pull-staker-balances.js` used to exit
  when `ETHERSCAN_API_KEY` was missing. It now discovers `StakeChanged`
  candidates over JSON-RPC (`scripts/lib/stakingDiscovery.js`, from the staking
  contract's deployment block 36,751,757 in 1M-block chunks) and reads
  `stakedBy()` / `totalStaked()` from the same pool. Etherscan is still used
  first when a key exists. Result: 1,207 stakers, 727,240,183.70 TEL, equal to
  `totalStaked()`.
- **TEL v3 StakingModule.** Polygon `0x573105be…5731` (proxy of StakingModule
  `0xd12ba966…03ae`) holds stakers' v3 TEL (~2.99B). It is configured under
  `config/chains.json` → `polygon.tokens.v3.staking`; `pull-holders-rpc.js`
  replays the module's receipt-token Transfer logs (checkpointed under
  `chains.polygon.v3Staking`) and moves each position onto its staker, and the
  module is labelled `staking-contract`.
- **Archive getLogs without keys.** Tenderly's public Polygon gateways serve
  wide archive `eth_getLogs` ranges (rate-limited, retried); publicnode refuses
  archive requests and Pocket/QuickNode cap ranges at ~5–10k blocks.

Recipe (from a worktree; no secrets needed):

```bash
export RPC_PREFER_PUBLIC=1
export PUBLIC_RPC_URLS_POLYGON="https://polygon.gateway.tenderly.co,https://gateway.tenderly.co/public/polygon"
export MATIC_GETLOGS_CHUNK_SIZE=50000 POLYGON_V3_GETLOGS_CHUNK_SIZE=50000
for s in pull-staker-balances pull-holders-rpc pull-cex-wallets generate-holders-lite \
         generate-holders-history generate-holder-transitions reconcile-supply \
         append-treasury-history sync-classification-changelog; do node scripts/$s.js || break; done
node scripts/validate-outputs.js && node scripts/check-feed-consistency.js
node scripts/verify-tel-supply.js
```

A full Polygon legacy rescan from block 11,264,036 takes many hours on public
RPCs; resume from an existing `holders-checkpoint.json` instead. Unset
`RPC_PREFER_PUBLIC` before `npm test` (one rpc test asserts the keyless default).

holders-history rows 2026-10-03..22 were backfilled on 2026-10-24, because
`pull-holders-rpc.js --as-of` (and so `fill-history-gaps.js`) only reconstructs
the legacy token and refuses dates after the v3 deployment. Method (scratch
only, not shipped): reverse-replay the 10-24 `holders-checkpoint.json` back to
each date's 23:59:59 UTC block (legacy + v3 Transfer logs, `applyV3Batch` for
retired legacy, StakingModule receipts), legacy staking from the first
`StakeChanged.oldStake` after the boundary. The replay reproduced the committed
10-23 checkpoint exactly and matched `totalStaked()` at every boundary. Each
day's checkpoint was then fed to the normal snapshot scripts against a local
RPC stub whose head is the boundary block. Those rows carry no
`cumulativeHolders`/`newHolders` (forward-only ever-set). Boundary blocks are
in `data/holders-asof-blocks.json`.

### Tier outflows

`data/tier-outflows-days.json` and its checkpoint were never in this repo, so
the first run is a full 368-day scan. On public RPCs:

```sh
TIER_DEX_CLASSIFY=logs MAX_BLOCKS_PER_RUN=20000000 \
FLOW_CHUNK_ETHEREUM=10000 FLOW_CHUNK_POLYGON=20000 FLOW_CHUNK_BASE=1000 \
NODE_OPTIONS=--max-old-space-size=6144 node scripts/generate-tier-outflows.js
```

`TIER_DEX_CLASSIFY=logs` labels swap vs LP from one LP-event `eth_getLogs` per
chunk instead of one receipt per DEX transfer (Polygon has ~500k of those a
year). It agreed with the receipt rule on 111 of 112 sampled txs. Tenderly's
public Base gateway caps `eth_getLogs` at 1,000 blocks; drpc's free tier no
longer serves Polygon/Base log ranges.
