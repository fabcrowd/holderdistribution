# Holder Distribution

On-chain holder analytics for multiple tokens — holder distribution and tiers, supply
breakdown, exchange flows, staking and historical growth — published at
[holderdistribution.com](https://holderdistribution.com) under the **Holder Distribution** brand.
Registered projects (see `config/projects.json`): **TEL** (Telcoin; Ethereum, Polygon, Base),
**ZBCN** (Zebec Network; Solana) and **ONDO** (Ondo; Ethereum). The site is the product; each
project is a page at `/<slug>`, and none is special in the app.
ZBCN history starts at 2026-10-25; there is no backfill yet.

A single-page React app: `/` is the token picker and `/<slug>` (e.g. `/tel`,
`/zebec-network`) is that token's terminal (Holders · Distribution · Supply tabs). It reads
static JSON feeds produced by a scheduled Node data pipeline. Independent, community-run; not
affiliated with any token or project.

## Stack

React 18 · TypeScript · Vite 5 · Tailwind CSS 3 · Radix UI · Recharts · TanStack Query ·
Supabase (auth only) · Netlify (static hosting + one function).

## Quick start

```bash
nvm use            # Node 22 (.nvmrc)
npm ci
npm run dev        # http://localhost:8080
```

No secrets are needed to run the UI: it reads the committed JSON in `public/data/` and uses
the public Supabase anon key baked in as a default. See [`.env.example`](.env.example).

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (regenerates the sitemap first) |
| `npm run lint` | ESLint (0 errors expected; warnings are known) |
| `npm run typecheck` | `tsc` for app + node configs |
| `npm test` | Vitest — UI/config tests in `src/`, pipeline logic tests in `scripts/` |
| `npm run build` | Sitemap + forensics-gate bundle, then `vite build` → `dist/` |
| `npm run preview` | Serve `dist/` locally (port 4173) |
| `npm run check:feeds` / `pipeline:health` | Validate / report on the data feeds |
| `npm run check:go-live` | Fail unless every project is complete: config, feeds, wallet flows, ledger |

## Layout

Find things with this map first; `CLAUDE.md` has the handoff rules and deeper architecture notes.

**App (React SPA)**
```
src/main.tsx, src/App.tsx          entry point and routes
src/pages/                         Landing (/ token picker), Holders (/<slug> terminal), NotFound
src/components/                    widgets; terminal/ (tabs + panels), tierflow/ (tier-flow math + view),
                                   chart/, routing/, ui/ (shadcn primitives); *.test.tsx sit beside each file
src/hooks/                         TanStack Query hooks, one per feed, keyed by project slug
src/lib/                           pure helpers: projects.ts (registry reader), chainViews, chart*, supply*, staking*
src/integrations/supabase/         auth client (public anon key default)
src/data/forensicsWriteups.ts      forensics copy; src/test/ site-config test
src/index.css, tailwind.config.ts  design tokens (Holder Distribution palette)
public/tokens/                     token images (per-token marks)
```

**Config and data**
```
config/projects.json               token registry (source of truth)
config/projects/<slug>.json        per-token config (tel.json, zebec-network.json, ondo.json)
config/*.json                      shared classification: cex-wallets, dex-contracts, exclusions, chains, holder-tiers
public/data/                       generated feeds served to the browser: TEL at the root, others in public/data/<slug>/
data/                              pipeline caches and checkpoints (not served); data/forensics/ = gated wallet flows
```

**Data pipeline (`scripts/`)**
```
scripts/*.js, scripts/*.ts         CLI entry points (holders, history, exchange flows, CEX wallets, Solana, staking)
scripts/lib/                       shared logic with sibling *.test.js; lib/solana/ = Solana adapter and flows
scripts/validate-outputs.js        feed gates: npm run check:feeds, npm run pipeline:health
scripts/check-go-live.js           go-live gate (lib/goLive.js): no skips, placeholders fail; --alignment strict for new tokens
scripts/lib/dayBlocks.js, asOf.js  shared day-cutoff blocks and feed asOf convention
scripts/check-feed-alignment.js    npm run check:alignment (lib/feedAlignment.js): feeds agree on the settled day
scripts/build-cutoffs.js           builds the shared per-day cutoff blocks
scripts/relabel-midnight-history.js  one-off D -> D-1 relabel of midnight-labelled history rows (--apply)
scripts/encrypt-env.js, decrypt-env.js, loadEnv.js   .env.enc secrets
scripts/CLAUDE.md                  TEL v3 accounting rules
```

**Serverless, build and CI**
```
netlify/functions/live-data.mjs    serves fresh feeds from GitHub without a rebuild
netlify/functions/forensics-gate.cjs   bundled gate (built from netlify/functions-src/ by prebuild)
netlify.toml                       security headers, manual-deploy rule
supabase/functions/wallet-analysis-gate/   Supabase edge function for wallet analysis
.github/workflows/                 ci.yml; refresh-holders.yml (nightly holders); per-project refresh,
                                   rebuild, scan and sync jobs; pipeline-watchdog.yml (self-heal stale feeds)
```

**Docs, design and audit**
```
docs/DEPLOYMENT.md                 deploy and production-readiness runbook
docs/LEDGER.md                     developer-wallet ledger
docs/FORENSICS.md                  password-gated forensics (Wallet flows), gate hardening, password rotation
docs/MULTI-TOKEN.md                multi-token layout, --project flag, Solana support, onboarding checklist
docs/PIPELINE-RECOVERY.md          recovering a stalled or broken pipeline
docs/TEL-CONTRACTS.md              TEL contract registry (legacy vs v3) and supply accounting
docs/superpowers/                  feature specs and plans; docs/zbcn-*.md = Zebec candidate lists
design-system/                     brand spec, tokens.json/tokens.css, logos, component specs
audit/                             standalone Node audit scripts against the live site (own package.json)
```

**Local only (not committed):** `tasks/` (todo, lessons, handoff, receipt), `.claude/`, `.cursor/`.

### Reading the Distribution tier flows

Net numbers on the tier-flow diagram are simply **in minus out** over the selected period:
wallets = joined − left, token amount = tokens in − tokens out. The Tiers table "Change"
columns are different: they compare the current snapshot with the period baseline (a † marks
a reclassification that makes the comparison unreliable). Charts support wheel/pinch zoom,
drag to pan, keyboard arrows (Shift+arrows pan, +/− zoom, 0 or Esc reset) and a data-table view.

Mapping a new token is config-only: register it in `config/projects.json`, add
`config/projects/<slug>.json`, and the landing page, sitemap and nightly refresh pick it up.
A project should stay out of `config/projects.json` until its full holder data and every flow
are confirmed; a partially wired project must not go live.
See [docs/MULTI-TOKEN.md](docs/MULTI-TOKEN.md) for the layout, the pipeline `--project <slug>`
flag, Solana support and the onboarding checklist.

Wallet-flow history is 90 days, filled by the first run. The EVM seller scan can read from SQD Portal (`generate-wallet-flows.js --source portal`,
opt-in, EVM only, completeness-gated, no Alchemy CU). See "Backfill via SQD Portal" in
[docs/FORENSICS.md](docs/FORENSICS.md) and step 9 of the onboarding checklist.

## Design notes and pitfalls

Read this before changing the pipeline, the config or the onboarding path. Each item is a mistake
that already cost a run or a PR.

**Registry-driven, never TEL-shaped**
- Nothing may default to TEL. `append-treasury-history.js`, `backfill-treasury-cex-history.js` and
  `check-feed-consistency.js` fall back to TEL's four categories (`treasury, council, holdings, escrow`)
  when a project has no `treasury.categories`. A project with fewer buckets must declare its own
  (ONDO: `["treasury"]`), or its first refresh aborts on a category it does not have.
- List only categories that cannot reach 0: `reconcile-supply` omits a category whose balance is 0 and
  `append-treasury-history` then aborts the whole daily refresh. That is why ONDO and ZBCN list `treasury` only.
- `council` is a naming tag on some TEL wallets (Compliance Council, TELx Council). It carries no logic
  and is not a bucket other tokens need. Do not build behaviour on it.

**Discovery decides staking, per token**
- Staking differs by project: none (ONDO), a `StakeChanged` contract (TEL), a receipt module, or a different contract
  model on another VM (ZBCN's `zebec-stake` program). The discovery phase of onboarding must find out which applies
  and tag it in `config/projects/<slug>.json` (`staking[]` entry with its `kind`, or contracts with role `staking`).
  Never copy TEL's staking assumptions to a new token, and never assume a token has none without checking its contracts.
- The UI must say so. A token with an empty `staking[]` has no Staked tile, and its Staked panel (inside the Holders
  "Details" accordion) shows `staking.none` copy ("{name} has no staking contract or staking mechanism...", overridable
  per project in `copy.text`) in the panel body and its info tip, instead of "No data for this period" or the generic
  "locked in staking" tip (`src/lib/stakingNote.ts`, `StakingNoneNote.tsx`). The Supply tab's staking views and the
  glossary/methodology text are not yet gated on this; check them when onboarding a token without staking.
- A token with no staking contract waives the `staker-balances` job in `nightly.waivers` with a reason, and must also set
  `health.feeds["funding-wallets.json"].disabled: true`. Otherwise `pipeline-health.js` reports the staker feed MISSING
  and exits 1, which the watchdog reads as a broken pipeline. `scripts/lib/healthMatchesNightlyPlan.test.js` enforces
  that the health feed is monitored exactly when the nightly plan runs the job, for every registered project.

**First run of a new token (each of these failed a real run, about 20 minutes each)**
- `supply.target` must exist in the project config before any refresh (`reconcile-supply` throws without it).
- `generate-holder-transitions.js` builds windows from the git history of the committed snapshot, which a
  new token does not have until the commit step. It now writes `{ ranges: {} }` (`scripts/lib/emptyTransitions.js`);
  the UI reads `ranges?.[key] ?? null`, so that is valid. The next night builds the real windows.
- `fill-history-gaps.js` ignores days before a project's first history row (`scripts/lib/missingHistoryDates.js`).
  It cannot rebuild them: the as-of rebuild needs a checkpoint committed at or before the day. History is
  forward-only from the first snapshot (ZBCN from 2026-10-25, ONDO from 2026-11-05). A real backfill is
  `rebuild-holders-history.yml`, which costs RPC budget and is a separate decision.
- Expect the next token to expose the next gap. Run the whole chain once and read the failing step.
- `pipeline.feedsPending` no longer exists. A project is live only when `node scripts/check-go-live.js --project <slug>`
  passes: config, every feed, wallet-flows report, ledger, no placeholders, no skips.

**Workflows and CI**
- A workflow can only be dispatched by a name that exists on the default branch. Config a data run needs
  must be on `main` first, or the run executes against the old config and fails. The nightly is
  `refresh-holders.yml` (renamed from `refresh-tel-holders.yml`; old runs are filed under the old name).
- The holders job has a per-project limit (`pipeline.workflowTimeoutMinutes`, 60 for ONDO) and a first scan from a
  deploy block is long. A scan that times out or dies saves `holders-partial-<chain>.json` to the Actions cache
  (`always()`), and the next dispatch resumes from it. Stage 2 (exchange flows, tier outflows, gap fill) shares
  that job's time, so a job can finish the holders feed and still hit the limit in stage 2. `scan-exchange-flows.yml`,
  `generate-tier-outflows.yml` and `fill-history-gaps.yml` have their own 330-minute limits and can be
  dispatched separately (`project=<slug>`) once the holders feed is committed.
- CI runs lint, typecheck, `npm test` (over `src/` and `scripts/`), `check:feeds`, the build and an audit. Run the
  full suite locally (`npx vitest run`, `npm run typecheck`, `npm run lint`); a run limited to `scripts/` once let a
  `src/` test fail in CI.
- Tests assert invariants and use their own fixtures. Never pin live config or feed numbers: a test that
  asserted ZBCN's real config flags its flow feeds as placeholders broke the moment the config was fixed.
- This repo squash-merges, so a merged branch still looks unmerged to git. Classify branches by PR state
  (`gh pr list --state all --head <branch>`) and delete them with `git branch -D`. Never force-remove a worktree.
- `git commit` and `git merge` both need the author and committer identity as env vars on the same command
  (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`); the machine has none configured.

**RPC**
- Free public RPCs are tried first; paid ones are allowed. Keys live in `.env.enc` (decrypted in the workflow with
  `ENV_PASSPHRASE`). GitHub repo secrets hold only `SOLANA_RPC_0` and `SOLANA_RPC_1`, so an empty secrets list
  does not mean no Ethereum keys.
- `rpc.mevblocker.io` answers an over-wide `eth_getLogs` range with `-32005 "query returned more than 10000 results"`.
  That is a range limit, not rate limiting: retrying never helps. `rpc.js` fails it at once (`RANGE_LIMIT_PATTERN`) so
  the caller splits the range. A plain `-32005` rate limit still retries with backoff.

**Forensics registry and ledger must agree**
- `config/projects/<slug>/ledger.json` lists the developer wallets; `data/<slug>/forensics/wallet-flows.registry.json`
  lists the known wallets. `check-go-live.js` fails when a treasury, holdings or association wallet is in the registry
  but not the ledger, or a ledger wallet is not in the registry.
- Do not regenerate the registry with `init-forensics-registry.js --force`: it overwrites hand-curated entries
  (association wallets, `botCluster`, `watchedSellers`, `extraCex`, `extraDex`). Append the missing rows instead.

**Feeds and health**
- `health.feeds.<file>.placeholder: true` means "intentional stub, never alarms as stale". Remove it as soon as the
  feed populates, or a dead feed looks healthy and `check-go-live.js` fails the project. Do not hand-edit generated feeds.
- Solana tier outflows are venue-anchored by design (`scripts/lib/solana/flowFeeds.js`): CEX deposits and withdrawals
  and DEX swaps are measured; wallet-to-wallet moves and counterparty-tier attribution are not. `attributedDays` is 0
  for ZBCN and `sourceTierSince` is `null`. That is expected and the UI shows its coverage caveat. It is not a bug.
- Config changes reach the browser at the next manual Netlify deploy (the config is bundled). Data reaches it
  through `live-data.mjs` without a deploy.

## Recent work
- **2026-11-07: Solana flow scan no longer skips past a null transaction.** When `getTransaction` returns null, `scripts/lib/solana/flowScan.js` now holds the venue cursor below it for up to `NULL_TX_RETRY_RUNS` (3) runs, retrying it first each run; every null in the chunk is charged per run, slots are never split. After the budget it advances and stays recorded in `unavailable`/`missing`. Old checkpoints without `attempts` load as 0.
- **2026-11-07: council diagnostic covers every chain (#165).** The first run (#164) checked Ethereum only and found 0 TEL in every council wallet, because council TEL sits on the other chains. It now scans ethereum, polygon and base from config/chains.json, prints each wallet's label and chains, and exits non-zero when the council total is below 300M.
- **2026-11-07: one-off diagnostic for the TEL council mismatch (#164).** `diagnose-council-transfers.yml` (manual only, read-only) prints the council-wallet TEL transfers of 1M+ since block 26,363,000 and the council balances at the snapshot block and at head, to find the 100M TEL difference between supply-reconciliation and treasury-history.
- **2026-11-07: alignment skips unpinned chains in block comparison (#163).** ONDO's nightly settled 2026-11-06 correctly, but its live snapshot was unpinned and still compared on blocks against the settled feeds (4,819 blocks apart). `feedAlignment.js` now leaves a chain out of block comparison when a feed lists it as unpinned, the same as live.
- **2026-11-07: tier-outflows completeness is measured against the settled end, not the tip (#162).** Tonight's nightly turned TEL's tier-outflows feed to `complete: false` with a null date: the scan now ends at cutoff[today]-1, so no chain ever reached the tip and the "within a day of the tip" test always failed. Each chain records its settled target and counts as caught up at that block (`scripts/lib/tierOutflowsComplete.js`).
- **2026-11-07: gap fill treats unsettled history days as gaps (#161).** The nightly gap fill only looked for missing dates, so a day whose row was unsettled (TEL/ONDO 2026-11-06, after the checkpoint passed the boundary) was never rebuilt and alignment stayed broken. `missingHistoryDates` now also lists explicitly unsettled rows and unmarked rows newer than the newest settled row; `fill-history-gaps.js` rebuilds only the newest such day per run (forward only) and checks the result with the same rule.
- **2026-11-07: consistency check skips history for an unpinned snapshot (#159).** The first nightly on #157 failed TEL at "Check cross-feed consistency": the checkpoint was already past the settled block, so the run snapshotted to head unpinned and, by design, wrote no history row, and the check then compared the new snapshot against the older 2026-11-07 row (102,243 vs 102,229 holders). `check-feed-consistency.js` now leaves holders-history out of the comparison when the snapshot's `asOf.unpinned` is non-empty; every other cross-check still runs.
- **2026-11-07: incremental EVM wallet-flows report (#158).** `generate-wallet-flows.js` used to re-read 90 days of logs every day. It now keeps a per-chain cursor and the 90-day outflow events in `<work>/forensics/wallet-flows-evm-state.json` (`scripts/lib/walletFlowsState.js`) and fetches only new blocks, re-reading back to each chain's confirmation depth (64/128/64). DEX-swap receipt checks are tri-state and retried (`scripts/lib/walletFlowsSwaps.js`, gave up after 3 attempts); the seller scan has its own receipt budget. A full rescan runs on no state or a config/logic-version change, so the first run after merge is a full scan. Report write ordering in the generator is untested (no seam); state size is measured after the first live run.
- **2026-11-07: Solana cutoffs persisted, nightly at 1am EST, fewer hard failures (#157).** Solana flow feeds stamp the cutoff slot (`asOf.blocks.solana`) and Solana slot cutoffs persist to `date-blocks.json`: the "Slot N was skipped, or missing in long-term storage" reply that silently broke every Solana cutoff search is resolved with `getBlocks` (`scripts/lib/dayBlocks.js`). A run whose checkpoint is already past the settled block now snapshots to head as `unpinned` instead of failing (the gap fill rebuilds the settled row). `check-feed-alignment.js` compares settled Solana flow feeds and reports `asOf.noBlock`. Solana balance snapshots stay live by design (`docs/MULTI-TOKEN.md`). `refresh-holders` moves to 06:00 UTC (1am EST), `refresh-ledger` to 07:30 UTC; `fill-history-gaps.yml` now commits `date-blocks.json`.
- **2026-11-06: one day-cutoff / asOf convention across feeds (#154, stacked on #153).** A row dated D is end-of-D state (last block <= D+1 00:00Z), shared by `scripts/lib/dayBlocks.js` and `scripts/lib/asOf.js`; feeds declare `asOf` (date, settled, per-chain blocks). New `npm run check:alignment` gate (`check-feed-alignment.js`, `lib/feedAlignment.js`) fails when feeds disagree on the settled day; `build-cutoffs.js` builds the shared cutoffs. UI: exchange widgets share one exclusive window end (`src/lib/settledEnd.ts`), labels and as-of block markers follow it, an unsettled feed with no asOf date ends after its last available row, and `ExchangeNetDiff` shows balance change beside measured netflow for the same window. ONDO `holders-history.json` rows from `rebuild-history-from-logs.js` were relabelled D -> D-1 (`relabel-midnight-history.js`, 1023 rows) and the rebuild now emits D-1 going forward. Unvalidated against live RPC.
- **2026-11-06: `--as-of` works on and after the TEL v3 deploy.** A gap-fill day at or after a chain's v3 deploy block used to be refused (legacy-only replay), so any recent TEL gap would have failed the nightly. `pull-holders-rpc.js --as-of` now runs the live scan (legacy, v3 and staking receipts) from the anchor checkpoint pinned to the day-boundary block (`fetchChainBalances(..., { pinBlock })`, `usesV3Scan` in `scripts/lib/holdersAsOfReplay.js`) and saves no checkpoint. Chains before their v3 deploy keep the cached-log replay. Unit-tested for the routing only; the RPC scan itself has not been run against a real gap (the 2026-11-06 gap-fill runs found none).
- **2026-11-06: history gap-fill no longer anchors on a fixed TEL date.** The 2026-11-05 nightly failed in ONDO's "Fill holders-history gaps" step: `pull-holders-rpc.js --as-of` read the committed checkpoint as of a hardcoded `2026-08-21`, and ONDO's first checkpoint is from 2026-11-05 (TEL's is from 2026-09-20, so it failed the same way). The anchor now defaults to the target date, so every project replays from its own newest checkpoint at or before the gap; `--anchor-date` still overrides, and `replayChainRawBalances` rejects an anchor past the target block. Covered by `scripts/lib/holdersAsOfReplay.test.js`. Tracked in #71 (close after a green `fill-history-gaps` run). Still open: `--as-of` refuses dates on or after TEL's v3 deploy, so a recent TEL gap would fail on that check.
- **2026-11-06: onboarding skill is now a step-by-step runbook (#145, #147, #148, #149, #151).** `.claude/skills/onboard-project/SKILL.md` is committed and rewritten as ten ordered steps (pre-flight, discovery, one owner question pass, `add-project.js` scaffold, config, first-data order, gates, visual check, verifier sign-off, report), each with commands, a pass check and a stop condition, so an LLM can onboard a token in one pass. It now requires per-supply holder tiers (ONDO inherited TEL's 100B tiers, #148), the replay/snapshot holder-definition check (#147), the `stale-tail` freshness gate and today-anchored flow windows (#145), and tier-outflows' tier fingerprint reset (#149). `docs/MULTI-TOKEN.md` matches.
- **2026-11-06: ONDO gets its own holder tiers.** ONDO had no `holders` block, so it inherited `config/holder-tiers.default.json` (TEL's tiers, sized for a 100B supply): 99.8% of its 214K wallets sat in the '1-250K' tier and the 250M-500M and 100M-250M tiers were empty, which made the Distribution concentration look wrong. `config/projects/ondo.json` now declares tiers sized for its 10B supply (50M+, 25M-50M, 10M-25M, 5M-10M, 2.5M-5M, 1M-2.5M, 500K-1M, 100K-500K, 25K-100K, 1-25K; TEL's divided by 10) and `megaHolderThreshold` 2B (20% of supply, TEL's ratio). `scripts/lib/registryTiers.test.js` checks every registered project's tiers are contiguous, ordered, open at the top, start at 1 and have unique labels. Tier labels are join keys into `holders-history`, `holder-transitions` and `tier-outflows`, so changing them needs a regeneration in this order: rebuild the holders history (`rebuild-holders-history.yml`), holders refresh, holders-lite, history, holder-transitions, tier-outflows. Until the history is rebuilt the Distribution table shows no change column for ONDO (old labels do not match). When you onboard a token, set its `holders.distributionTiers` for its own supply before the first rebuild. The largest ONDO retail wallet (0x460a..., 729.5M, an unlabeled wallet that looks like a trading hub, not Foundation-funded) is deliberately left in retail.
- **2026-11-06: tier-outflows resets when a project's tiers change.** `generate-tier-outflows.js` keeps a per-day store keyed by tier label and only reset on a `SCHEMA_VERSION` bump, so changing a project's `holders.distributionTiers` (ONDO moved from TEL's default tiers to its own 10B-supply tiers) would have left old-label days mixed with new ones for good. `scripts/lib/tierFingerprint.js` hashes the resolved tiers (label, min, max) and stores the fingerprint in the days store and in `tier-outflows.json`; a different fingerprint, or an unstamped store holding labels outside the current set, resets the store and checkpoint. TEL and ZBCN stores carry no fingerprint but only their own labels, so they are adopted without a re-scan. A reset restarts the scan from `latest - (365+3) days`, capped at `MAX_BLOCKS_PER_RUN` (3M blocks per chain per run), so a fast chain needs several runs. `generate-holder-transitions.js` recomputes everything each run and needs no change.
- **2026-11-06: replay counts the same holders as the snapshot.** After ONDO's history was rebuilt from Transfer logs, its holder count stepped 220,198 to 214,346 (-2.7%) at the first snapshot row. Cause: the snapshot rounds balances to 6 decimals (`roundTel`) and drops zeros, so a wallet under 5e-7 token is not a holder; the replay kept any balance of at least 1 raw unit, which for an 18-decimal token admitted 5,957 dust addresses (about 0.0002 ONDO in total). Balances agreed to under 0.001 ONDO at the same block. `createReplayLedger` now takes `dropRoundedDust` (opt-in, used by `rebuild-history-from-logs.js`) and reuses `roundTel`/`rawToTel` from `telTokens.js`, so there is one holder definition; the ledger's resume checkpoint still keeps sub-floor balances because a later transfer can lift them over the floor. For tokens with 6 or fewer decimals (TEL) the rule never drops anyone. Lessons: a rebuild must use the same holder definition as the nightly snapshot, and a series-break marker is the wrong tool for a bug (it suppresses every Distribution Change cell with a dagger and says wallets were reclassified). ONDO's history needs one rebuild plus a holders refresh after this merges. Still open: the replay's `cexBalance` is one constant for every date (ONDO has a single CEX history row), so past `totalHeld` is wrong; the replay's large-tier counts differ from the live row by about 49M ONDO on 2026-11-05 (cause not isolated); ONDO uses TEL's default tiers, sized for 100B supply, so 99.8% of wallets fall in the 1-250K tier.
- **2026-11-05: stale data no longer looks current.** A visual audit found ONDO's Exchange Net Flow showing +398.53M under the YTD range from a feed that ends 2025-10-27: the panel took its windows from the feed's own last row, so a stale feed rendered as current, and `pipeline-health`/`check:feeds` passed because they only read `generatedAt`. `src/lib/flowWindow.ts` now anchors windows to today (UTC), shows "No exchange-flow data in this range. Feed has data through <date>" when the window is empty and a "Data through <date>" note when the last row is over 3 days old. `feedHealth.js` gains a `stale-tail` status (newest dated row older than `maxLastEntryAgeDays`; `exchange-flow-history.json` defaults to 3 days, any feed can opt in through `health.feeds`), and `pipeline-health.js` prints the `problems` list from `pipeline-status.json`. ONDO failed the tail check until its exchange-flow backfill ran (scan-exchange-flows, `max_blocks_per_run=3000000`, one run of about 4 minutes took it from 2025-10-27 to 2026-11-05, 1,023 entries); do not mask a stale tail with a placeholder. ONDO's holders history was rebuilt from Transfer logs with `rebuild-holders-history.yml` (`start=2024-01-18`, 1,024 daily rows, about 22 minutes, no Etherscan cross-check because no transfers were cached); its treasury and CEX balance history are still one row each. Also: mobile Staking shows the no-staking note, empty growth charts say why (0 snapshots, 1 snapshot, range before history start) instead of "No data for this period", and null stays null ("—") instead of being coerced to 0 for retail share, Gini and tier counts. Known gaps: `check-go-live.js` does not yet use the tail check; the ONDO glossary still lists "Staked ONDO"; tier-flow windows say YTD while history is shorter.
- **2026-11-05: a note for tokens without staking.** ONDO has no staking mechanism, but its Staked panel showed "No data for this period" and an info tip saying "ONDO locked in staking... can't be sold until unstaked", which is false. A project with an empty `staking[]` now shows `staking.none` copy in that panel and tip and hides the Staking drill-down button. Verified with unit and render tests; a browser check was not possible (the Chrome extension was not connected).
- **2026-11-05: ONDO health follows its nightly plan.** The first scheduled-path ONDO refresh succeeded (26 minutes, two commits to `main`), but `pipeline-health.js --project ondo` exited 1 with "Staker balances MISSING": ONDO has no staking contract and waives the staker job, yet the health check still expected `funding-wallets.json`. ONDO now disables that feed, and a test keeps health feeds and the nightly plan in step for every project.
- **2026-11-05: ZBCN flow feeds are no longer placeholders.** `exchange-flow-history.json` and `tier-outflows.json` were flagged `placeholder` in `config/projects/zebec-network.json` although the nightly has committed them every day since 2026-11-02, so `check-go-live.js` failed ZBCN and `pipeline-health.js` could never report them stale. The flags are removed; the feeds now use the default freshness limits (5.7h old against 48h and 96h) and `check-go-live.js --all` passes for TEL, ZBCN and ONDO. Solana tier outflows stay venue-anchored by design (`scripts/lib/solana/flowFeeds.js`): wallet-to-wallet moves and counterparty-tier attribution are not measured, so `attributedDays` is 0 for ZBCN and the UI shows its existing coverage caveat.
- **Merged to `main`:** #128 developer wallets ledger and view, #129 developer-wallets headline from DOM text, #130 ONDO project, #132 nightly framework, #135 go-live gate (ONDO is live, `check-go-live.js` is the single completeness gate), #137-#140 ONDO first-feed fixes (config, range-limit retry, first-run transitions, gap fill), and #127 Solana replay fixes (fail fast without a keyed RPC, history-start note; supersedes #105).
- 2026-11-01 forensics: every project now needs a forensics registry (`npm run init:forensics`, enforced by `check:feeds`). Solana tokens get a gated Wallet flows report (`scripts/generate-wallet-flows-solana.js`) with swap proceeds and one- or two-hop tracing of unlabelled recipients (`WALLET_FLOWS_TRACE_DEPTH`, call-budgeted). `sync-cex-wallets.yml` now imports the spellbook CEX list for every registry project. Merged in #126. See `docs/FORENSICS.md` and `docs/MULTI-TOKEN.md` step 11.

- **2026-11-05: ONDO is live (go-live gate, #133/#134 landing as #135).** ONDO's first feeds, flow feeds, wallet-flows report and developer-wallet ledger are on `main`, `pipeline.feedsPending` is removed, and `check-go-live.js --project ondo` passes. The five Foundation allocation wallets that the ledger tracks (0xc5d9, 0xac7d, 0x0d37, 0x7fd8, 0xb165) are added to `data/ondo/forensics/wallet-flows.registry.json` from the ledger's own curated rows, so registry and ledger agree. ZBCN's two flow feeds were still flagged placeholder at that point; see the next entry.
- **2026-11-05: history-gap fill for a new token.** `fill-history-gaps.js` counted the 14 days before a project's first history row as gaps and then failed trying to rebuild them (no earlier checkpoint exists), which failed ONDO's first run and would have failed it nightly for two weeks. Days before the first row are now ignored (`missingHistoryDates`). A project's history is forward-only from its first snapshot, as ZBCN's is.
- **2026-11-05: first-run holder transitions.** A new token's first refresh failed at "Verify generated files": `generate-holder-transitions.js` builds its windows from the git history of the committed snapshot, which does not exist until the commit step that follows, so it wrote nothing. It now writes a valid empty feed (`ranges: {}`, which the UI already reads as no data) on a first run; the next night builds the real windows. ZBCN had worked around this by committing its first feeds by hand.
- **2026-11-05: ONDO refresh speed and treasury categories (#138).** The first ONDO scan lost ~2 minutes on every dense eth_getLogs range: `rpc.js` retried mevblocker's `-32005 "query returned more than 10000 results"` six times as if it were rate limiting, though that answer never changes. A `-32005` that matches the range-limit wording now fails at once so the range is split immediately (plain `-32005` rate limits still retry). ONDO also declares `treasury.categories: ["treasury"]`, because `append-treasury-history` defaulted to TEL's four categories and aborted on the missing `council`. `council` stays a naming tag on TEL wallets (Compliance Council, TELx Council); it carries no special logic.
- **2026-11-05: ONDO config for its first feeds.** The ONDO refresh failed at `reconcile-supply` because `main`'s `config/projects/ondo.json` had no `supply.target`. This brings over the ONDO config from #133 (10B target, Foundation treasury and distribution-Safe roles, circulating and developer-holdings rules, CEX wallets, developer-wallet ledger). `pipeline.feedsPending` stayed on until the first feeds were committed, and the go-live gate (#135) removed it.
- **2026-10-31 22:29 (ET): UI and landing page.** Header is one row: "Holder Distribution" title, the open token's mark beside the chain and timeframe selectors, and a Stale/Delayed pill only when the refresh is behind (no date badge). Brand text is "Holder Distribution" across UI, meta and docs; asset file names are unchanged. SEO descriptor is "Token Holder Distribution & Supply Data". Landing page has a hero with the tagline "Blockchain without the BS.", a "Cutting through the noise" band and the token list. Raw green/red/amber classes moved to semantic tokens; shared `Callout` component added; unused badge variants and the violet/sky tab accents removed. Typecheck, lint and the full suite (173 files, 1541 tests) pass. Not yet checked in a browser at phone width.
- **SQD Portal backfill (opt-in, local):** `generate-wallet-flows.js --source portal` reads EVM logs from SQD Portal instead of Alchemy, with a completeness gate against RPC; `--as-of <date> --out <path>` builds historical reports. See [docs/FORENSICS.md](docs/FORENSICS.md).
- **2026-11-01: nightly pipeline cost and reliability.** ZBCN exchange and tier flows populate nightly (2026-10-25 onward, forward-only history). The Solana flow scan reads `SOLANA_RPC_0` and `SOLANA_RPC_1` (Helius free tier) before the public node, saves progress every 60 transactions, asks for transaction version 1, and runs up to 40 minutes and 15,000 transactions a night (about 12k a day is ZBCN's venue volume). Run metrics write `data/<slug>/rpc-usage.json` and check month-to-date use against `config/budgets.json` (30M Alchemy CU, 1M Helius credits). The holders pull shares its Transfer logs with the exchange-flow and tier scans (`HD_SHARED_SCAN=off` disables), and staker balances are read through Multicall3. A final "Stage verdict" step turns any failed non-fatal stage into a red run and a failure issue. A ZBCN backlog of about 88k transactions cost about 90k Helius credits.
- **Known issues:** the Dune API CEX sync fails with HTTP 402 (the account's datapoint cap), so the CEX list has not grown since 2026-09-20; `--source spellbook` is a free supplement, and `sync-cex-wallets.yml` runs it for every registry project (EVM adds addresses; other chains get review candidates only). ZBCN has a forensics registry (`data/zebec-network/forensics/`), but its wallet flows are not yet confirmed.

## Deploying

Production deploys are **manual** from the Netlify dashboard — git pushes (including branch
and PR previews) are suppressed by `ignore = "exit 0"` in `netlify.toml`. Read
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before shipping.
