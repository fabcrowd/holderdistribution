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
