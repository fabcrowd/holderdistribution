# Holder Distribution

On-chain holder analytics for multiple tokens — holder distribution and tiers, supply
breakdown, exchange flows, staking and historical growth — published at
[holderdistribution.com](https://holderdistribution.com) under the **Holder Distribution** brand.
Registered projects (see `config/projects.json`): **TEL** (Telcoin; Ethereum, Polygon, Base),
**ZBCN** (Zebec Network; Solana), **ONDO** (Ondo; Ethereum) and **HBAR** (Hedera; native coin; listed since 2026-11-15). The site is the product; each
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
| `npm run check:data` | The checks of the committed data itself (`scripts/datachecks/`, `src/datachecks/`); `-- --project <slug>` or `HD_PROJECT` runs one project's. `npm test` passes without `public/data/` and `data/` |
| `npm run check:go-live` | Fail unless every project is complete: config, feeds, wallet flows, ledger |
| `npm run onboard:check -- --project <slug> [--skip-tests]` | Local onboarding gates in one go: vitest, typecheck, lint, feed consistency, pipeline health, strict go-live; logs in `tasks/` |

## Layout

Find things with this map first; `CLAUDE.md` has the handoff rules and deeper architecture notes.

**App (React SPA)**
```
src/main.tsx, src/App.tsx          entry point and routes
src/pages/                         Landing (/ token picker), Holders (/<slug> terminal), NotFound
src/components/                    widgets; terminal/ (tabs + panels), tierflow/ (tier-flow math + view),
                                   chart/, routing/, ui/ (shadcn primitives); *.test.tsx sit beside each file
src/hooks/                         TanStack Query hooks, one per feed, keyed by project slug
src/lib/                           pure helpers: projects.ts (registry reader; LISTED_PROJECTS skips onboarding ones),
                                   comingSoon.ts, chainViews, chart*, supply*, staking*, explorerLinks.ts (per-chain
                                   links incl. Hedera), format.ts (the one compact number formatter: T, B, M, K, sub-1),
                                   cexComparison.ts (cex-flows `comparison` reader), venueFlows.ts (venue-scanned flow copy)
src/components/terminal/NetworkStakeTile.tsx   staked-HBAR tile (network-wide, informational)
src/components/TokenSwitcher.tsx, src/lib/tokenSwitch.ts   token switcher in the header (Ctrl/Cmd+K; keeps the open view)
src/integrations/supabase/         auth client (public anon key default)
src/data/forensicsWriteups.ts      forensics copy
src/test/                          site-config test; projectShapes.render.test.tsx + shapeFixtures.ts (render-shape
                                   tests: every section for the registered projects and synthetic tiny, huge,
                                   hedera and solana-staking shapes)
src/index.css, tailwind.config.ts  design tokens (Holder Distribution palette)
public/tokens/                     token images (per-token marks)
```

**Config and data**
```
config/projects.json               token registry (source of truth)
config/projects/<slug>.json        per-token config (tel.json, zebec-network.json, ondo.json, hedera.json)
config/*.json                      shared classification: cex-wallets, dex-contracts, exclusions, chains, holder-tiers
public/data/                       generated feeds served to the browser: TEL at the root, others in public/data/<slug>/
data/                              pipeline caches and checkpoints (not served); data/forensics/ = gated wallet flows
```

**Data pipeline (`scripts/`)**
```
scripts/*.js, scripts/*.ts         CLI entry points (holders, history, exchange flows, CEX wallets, Solana, staking)
scripts/lib/                       shared logic with sibling *.test.js; lib/solana/ = Solana adapter, flows, Alchemy flow backup
scripts/lib/chainAdapters.js, chainVms.js   chain-VM dispatch; lib/hedera/ = Hedera adapter, resumable snapshot scan, transfer replay,
                                   exchange flows (flow*.js), wallet flows and ledger source (walletFlow*.js, ledgerSource.js),
                                   network stake
scripts/scan-hedera-flows.js, generate-wallet-flows-hedera.js   Hedera exchange/tier flows and gated wallet-flows report
scripts/lib/cexFlows.js            cex-flows one-day comparison rule (previous-snapshot rotation, `comparison` block)
scripts/lib/snapshotFormat.js      tel-holders.json layout: slim single-chain writer, `hydrateChainHolders` reader, size gate (warn 50 MiB, fail 95 MiB)
scripts/lib/transitionBase.js      base snapshot of a holder-transitions window: never one dated before the first history row
scripts/lib/snapshotShards.js, snapshotIo.js   sharded snapshot (head tel-holders.json + tel-holders.d/wallets-NNN.tsv, from 50 MiB); the only
                                   way to read or write a holder snapshot: readSnapshot, writeSnapshotFiles, publishSnapshot
scripts/lib/stateStore.js          the only way to read a PAST version of a data file (versionsByDate, revisionAsOf, readJsonAt,
                                   readSnapshotAtRev); backed by git today. gitReadGuard.test.js fails on any other git read in scripts/
                                   or in a workflow run step
scripts/lib/coinNeutralGuard.test.js   every coin is treated the same: fails when shared code or a workflow names a registered coin
                                   (slug, ticker, price id, address), holds a table of numbers keyed by chain name, or uses legacyRoot
                                   outside the registry. Words come from config/ at test time. Today's violations are listed with a
                                   reason each; the list may only shrink
scripts/lib/chainBranchGuard.test.js   fails on a branch on the chain family (evm, solana, hedera) outside the adapter layer; same
                                   shrinking list. scripts/lib/guardScan.js: the shared scanner (comment-aware, line-numbered)
scripts/lib/adapter/contract.js    the ledger adapter contract: what every ledger must provide (settledEnd, ranges, fullList, changes,
                                   supply, positions) and the capabilities it declares; validateAdapter rejects a wrong shape by name
scripts/lib/adapter/read.js        the only readers of an adapter: every row exactly once or a named error; bounded pages, empty
                                   pages, tokens and tracked accounts, so a read always stops. Memory per range for a full list and
                                   per changed account for unsorted changes (bounded, named error), never per coin
scripts/lib/adapter/synthetic.js   a generated ledger of any size (seeded, supply conserved, fault injection); syntheticMath.js: its
                                   arithmetic. The size proof: scripts/adapter-size-run.js --accounts N --changes C --days D
scripts/lib/adapter/conformance.js the checks every adapter must pass (full list at A plus changes A to B equals full list at B,
                                   ranges cover, supply, transfers explain changes, ...); run on the generated ledger in CI
scripts/lib/store/                 the data store (design and status: docs/STORE.md). Tables: buckets.js, codec.js, tableWrite.js,
                                   tableRead.js, pastDay.js, yearlyCopy.js, stateCheck.js (rows keyed by account in hash buckets, a base per
                                   bucket plus daily change files with old and new values; any day inside the horizon is read forward or
                                   undone back; every rebuilt bucket is checked against a recorded count and hash); bytes go through
                                   itemStore.js. Packs and the blob store: pack.js, packNames.js, blobStore.js with blobStoreFolder.js and
                                   blobStoreRelease.js (GitHub Releases through an injected HTTP client; a stored location is never replaced,
                                   a release rolls over at 900 assets, a read costs no API request), packItemStore.js, fakeReleaseServer.js
                                   for tests. Records of a publish: bundle.js, manifest.js, usage.js, pointerFiles.js, candidate.js,
                                   chain.js and acceptChain.js (the one function a publish calls to accept a chain), references.js.
                                   Cleanup: sweepPlan.js and sweepRules.js (pure), sweep.js and sweepExecute.js (I/O; a dry run unless told
                                   otherwise), releaseRecord.js. Lane: packLane.js, packItemInfo.js, adoption*.js (continue from unpublished
                                   bundles of earlier runs), staleCodeGuard.js, startRecord.js, laneRestore.js, lanePack.js, lane*.js helpers.
                                   Publish: publish.js, publishIndex.js, publishSweep.js, publishFiles.js. Table formats: tableFormats.js
                                   (the ever-held list `holders-ever-checkpoint.json`, rebuilt byte for byte through keyRuns.js) and
                                   tableSpecs.js (`tableSpecsFor(slug, layout)`, the `--table-specs` module; no workflow passes it yet)
scripts/lib/storeFiles.js          which files of a coin are stored, per kind (per-coin `excludedFiles` in the registry)
scripts/store-restore.js, store-pack.js   the lane's restore and pack steps (called by refresh-holders.yml)
scripts/store-publish.js           the publish job's decision step (phase publish: manifests, index rows, store.json) and sweep (phase sweep, dry run)
scripts/check-store-files.js       (`npm run check:store-files`) every file a coin writes is stored or excluded by the store (same listing as the pack); runs in `verify`
scripts/store-overlay.js           builds the after-publish origin facts for the restore check (published manifests over origin, absent markers cleared)
scripts/store-origin-facts.js      writes the origin/main facts the store CLIs read (data/manifests, stale-code guard history, head commits); the one script that runs git for them
scripts/store-compare.js           the publish job's file-hash check: restored files against the lane's generated ones (dual-write)
scripts/store-guard.sh             runs a store command so it can never fail a workflow step (status files, timeout, summary, one issue)
scripts/store-probe.js             by-hand probe of the unmeasured GitHub release behaviors (docs/STORE.md, "Pack and release model") on a throwaway `probe-` series; never run by a workflow
data/manifests/                    the store's records in git: one manifest and one index file per coin, store.json (written by the publish job)
scripts/lib/tierCounterpartyDays.js   venue-flow tier outflows: each past snapshot is read once; the looked-up counterparty balances
                                   are kept per snapshot date in data/<slug>/tier-counterparty-days/<date>.json
scripts/lib/firstLiveDate.js       `firstLiveDate` of holders-history.json (the first live snapshot day; the venue flow scans' floor)
scripts/datachecks/, src/datachecks/   *.datacheck.* files: checks of the committed data (npm run check:data, vitest.datacheck.config.ts);
                                   CI runs all of them, the nightly runs the project's after its last push
scripts/fixtures/                  small fixed inputs for code tests (never generated feeds)
scripts/lib/walletFlowsHash.js     EVM wallet-flows scan hash (sender set, tokens, logic only; legacy-hash adoption)
scripts/validate-outputs.js        feed gates: npm run check:feeds, npm run pipeline:health
scripts/check-go-live.js           go-live gate (lib/goLive.js): no skips, placeholders, unhealthy feeds, incomplete tier outflows
                                   and borrowed tiers fail; --alignment strict for new tokens
scripts/onboard.js                 npm run onboard: discovery from an address or mint, answers template, then add-project.js (lib/onboard.js)
scripts/lib/onboardAnswers.js      the onboarding answers schema, validation messages and class -> config mapping;
config/onboarding.answers.example.json   a complete example answers file (fictional addresses)
scripts/onboard-run.js             first-data driver behind onboard-project.yml: runs each step until go-live (lib/onboardRun.js)
scripts/onboard-check.js           npm run onboard:check: the local gates in one command (lib/onboardCheck.js)
scripts/lib/projectSizing.js       supply-scaled thresholds (wallet-flow seller/swap, CEX candidates, consistency tolerance)
scripts/lib/networkStake.js        `networkStake` block of holders-lite.json (informational; Hedera adapter port `stakingInfo`)
scripts/lib/registrySizing.test.js   every registered project: mega threshold within supply, tiers and sizing consistent
scripts/lib/feedCoverage.test.js     every feed the browser fetches is served by live-data.mjs and required by go-live
scripts/dump-wallet-transfers.js   read-only multi-project wallet transfer dump (CSV to stdout)
scripts/derive-holder-tiers.js     a project's own holder tiers from its own snapshot (lib/deriveHolderTiers.js); prints, never writes
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
                                   rebuild, scan and sync jobs; pipeline-watchdog.yml (self-heal stale feeds);
                                   onboard-project.yml (one dispatch: a scaffolded token's first data to go-live)
```

**Docs, design and audit**
```
docs/DEPLOYMENT.md                 deploy and production-readiness runbook
docs/NIGHTLY-FRAMEWORK.md          nightly job plan, Alchemy CU budget guard, public ledger source
docs/LEDGER.md                     developer-wallet ledger
docs/FORENSICS.md                  password-gated forensics (Wallet flows), gate hardening, password rotation
docs/MULTI-TOKEN.md                multi-token layout, --project flag, Solana support, onboarding checklist
docs/STORE.md                      the data store: design, dual-write, failure table, rollback, status
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

Mapping a new token is config-only and driven by one answers file. The runbook is the
onboard-project skill (`.claude/skills/onboard-project/SKILL.md`).
1. `npm run onboard -- --address <0x… or mint>`: discovery on-chain and from CoinGecko, writes an
   answers template to `tasks/onboard-<slug>.answers.json`.
2. Fill it (staking, wallets and classes, DEX pools, CEX list, history start; every decision needs
   evidence). `config/onboarding.answers.example.json` is a complete example.
3. `npm run onboard -- --address <addr> --answers <file> --write` expands it into every config file.
   Review and merge (with the README update).
4. `gh workflow run onboard-project.yml -f project=<slug>` runs every first-data step until
   `check-go-live` passes; each stop prints a `Fix:` block, fix it and dispatch again.
5. `npm run onboard:check -- --project <slug>` runs the local gates; then a visual check.

The registry entry carries `"onboarding": true` until go-live passes: the nightly runs it and
`/<slug>` renders, but the landing page and sitemap leave it out.
See [docs/MULTI-TOKEN.md](docs/MULTI-TOKEN.md) for the layout, the pipeline `--project <slug>`
flag, Solana support and the manual reference.

Wallet-flow history is 90 days, filled by the first run. The EVM seller scan can read from SQD Portal (`generate-wallet-flows.js --source portal`,
opt-in, EVM only, completeness-gated, no Alchemy CU). See "Backfill via SQD Portal" in
[docs/FORENSICS.md](docs/FORENSICS.md) and the wallet-flow history item in the manual reference of
[docs/MULTI-TOKEN.md](docs/MULTI-TOKEN.md).

## Store

Generated data is moving out of git into a store of packed files in GitHub Release assets, with a small
manifest per coin in `data/manifests/` naming the current state. Account tables are kept as hash buckets
plus one change file per day, so a night writes what changed, not the whole coin. Today the holders
nightly dual-writes to it (git stays the source of truth, a store failure cannot fail the run, a kill
switch turns it off); no table format is wired in yet, no data has left git, and no release is deleted.
[docs/STORE.md](docs/STORE.md) has the why, the size model, the pack and release model, lanes and publish,
the failure table, rollback and a status table of what is built and what is not.

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
  and is not a bucket other tokens need. Do not build behaviour on it. The association flow panel is shown
  only when the project sets `gated.associationFlows: true` (TEL does); never infer it from a `council` category.

**Sizing and groupings**
- Sizing is derived per project from its own supply and first snapshot, never copied. Tiers, balance ranges,
  `retailThreshold` and `concentrationBuckets` come from the first snapshot's retail wallets
  (`scripts/lib/deriveHolderTiers.js`, run by the onboarding runner). The scaffold writes
  `megaHolderThreshold` = supply.target / 5 (plus a `retailThreshold` at half of it when that is not above the shared
  default of 1,000). The runner then sets it to `max(supply.target / 5, 1.2 x the largest wallet acknowledged as
  retail, rounded up to 1 / 2.5 / 5 x 10^k, capped at supply.target)`, never lowers it, and a later raise changes
  only that field. Do not set it by hand: the next runner step would overwrite it.
- Token-unit thresholds scale with supply (`scripts/lib/projectSizing.js`): wallet-flows seller floor
  supply/20,000, swap-candidate floor supply/100,000, CEX-candidate floor supply/1,000,000, feed-consistency
  tolerance `max(supply/1e11, 1)` tokens. A 100B supply gives TEL's old constants.
- ONDO pins the old shared values in its `sizing` block. These thresholds are part of the wallet-flows state
  hash, so scaling them would force a full 90-day rescan for any project whose supply is not 100B. Removing
  the pin is an owner decision.
- Treasury chart series come from the feed (the categories present), not from a fixed TEL list.
- Team and holdings wallets are non-circulating on every token except TEL (owner, 2026-11-12). TEL alone keeps
  Telcoin Holdings as circulating. The onboarding answers classes `treasury`, `association`, `team` and
  `holdings` are subtracted from circulating; `escrow` and `reward-vault` are not.

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
  passes: config, every feed healthy by `pipeline-health`'s rules, tier outflows complete on the current tiers, its own
  tiers (or `holders.defaultTiers` recording an owner decision, as ZBCN has), wallet-flows report, ledger, no
  placeholders, no skips.

**Workflows and CI**
- A workflow can only be dispatched by a name that exists on the default branch. Config a data run needs
  must be on `main` first, or the run executes against the old config and fails. The nightly is
  `refresh-holders.yml` (renamed from `refresh-tel-holders.yml`; old runs are filed under the old name).
- The holders job has a per-project limit (`pipeline.workflowTimeoutMinutes`, 60 for ONDO; the first holders-scan step cap is `pipeline.holdersScanTimeoutMinutes`, default 20) and a first scan from a
  deploy block is long. A scan that times out or dies saves `holders-partial-<chain>.json` to the Actions cache
  (`always()`), and the next dispatch resumes from it. Stage 2 (exchange flows, tier outflows, gap fill) shares
  that job's time, so a job can finish the holders feed and still hit the limit in stage 2. The tier scan stops
  itself at `TIER_OUTFLOWS_MAX_MS` (20 min nightly, 310 min standalone) and saves its progress, so a reset rescan
  advances every night instead of being killed unsaved (`scripts/tierOutflowsBudget.test.js`). `scan-exchange-flows.yml`,
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
- After any tier change, regenerate in this order before the next nightly: `rebuild-holders-history.yml`, then
  `refresh-holders.yml` for the project, then `generate-tier-outflows.yml`, then `npm run check:feeds`. Tier labels are
  join keys into history, transitions and tier outflows. The site shows new tiers after the next manual Netlify deploy.
- GitHub creates scheduled runs hours late, and the lag grows through the US day; the cron minute makes no difference.
  The nightly is set to 01:07 UTC (`refresh-ledger.yml` 02:37 UTC) so it lands overnight US Eastern. 01:07 UTC is never
  before midnight UTC, so the settled day is unchanged. Runs started by push or dispatch are created within seconds.
- Do not write `import.meta.glob<...>(` with a type argument in `src/`: vitest skips its on-disk module cache only for
  files containing the exact text `import.meta.glob(`, so a cached project list goes stale after a token is added. A test
  rejects the form.
- Store: git stays the source of truth while the store dual-writes. A store failure must never fail the git path
  (`scripts/store-guard.sh`); the kill switch is the `store` dispatch input or the `HD_STORE` repository variable. Release
  deletion stays off until `scripts/store-probe.js` has measured the GitHub behaviors listed in docs/STORE.md. See [docs/STORE.md](docs/STORE.md).
- A Hedera account scan's wall time is lanes divided by seconds per request; the public mirror node's speed varies, so read
  `snapshotRequestStats` in `data/hedera/holders-checkpoint.json` and the scan's summary line before changing lane counts.

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
- The EVM wallet-flows scan hash covers only the sender set, the token fingerprint and the logic version
  (`scripts/lib/walletFlowsHash.js`); labels, CEX/DEX lists and reconciliation categories are applied when the report is built,
  so a list change never costs a rescan. State is saved per segment and at `WALLET_FLOWS_MAX_MS`. A run that stops at the budget
  commits its state, writes no report, flags itself "partial" and fails once the published report is older than the go-live limit
  (`MAX_REPORT_AGE_HOURS`). After a merge that changes the logic, dispatch `refresh-wallet-flows.yml` for tel (again if partial).
- Hedera wallet flows (`scripts/generate-wallet-flows-hedera.js`) end in one of three states: complete (report, exit 0), budget
  (`HEDERA_WALLET_FLOWS_MAX_MS`: state saved, no report, `partial=true`, exit 0) or error (last consistent state saved, exit 1,
  `partial=true`). There is no soft exit 0. Senders are the project's treasury accounts; the network accounts 0.0.98, 0.0.800,
  0.0.801 and 0.0.54 are listed as not traced. Raw events are labelled with the current venue lists at report time. Onward hops
  from unlabelled recipients are not traced.

**Feeds and health**
- `health.feeds.<file>.placeholder: true` means "intentional stub, never alarms as stale". Remove it as soon as the
  feed populates, or a dead feed looks healthy and `check-go-live.js` fails the project. Do not hand-edit generated feeds.
- Solana tier outflows are venue-anchored by design (`scripts/lib/solana/flowFeeds.js`): CEX deposits and withdrawals
  and DEX swaps are measured; wallet-to-wallet moves and counterparty-tier attribution are not. `attributedDays` is 0
  for ZBCN and `sourceTierSince` is `null`. That is expected and the UI shows its coverage caveat. It is not a bug.
- `cex-flows.json` is a one-day comparison only when both snapshots are comparable and exactly one day apart
  (`scripts/lib/cexFlows.js`); otherwise it carries `comparison.available: false` with a reason and the UI shows no
  change figure. `check-feed-consistency` step 8b fails on missing or mis-ordered stamps and only warns when the net
  differs from `exchange-flow-history.json` (each skip prints its reason). holders-lite ignores a previous snapshot that
  is not exactly one day older (`dailyPreviousSnapshot`).
- Hedera exchange flows (`scripts/scan-hedera-flows.js`) read the mirror node per exchange account and follow `links.next`,
  including empty continuation pages. The stored scan is stamped with a hash of the (account, exchange) set and the classifier
  version; a different set rebuilds from the floor. Tier flows keep an `unattributed` bucket, so tiers plus `unattributed`
  equal the exchange totals. History is forward-only (owner decision).
- Config changes reach the browser at the next manual Netlify deploy (the config is bundled). Data reaches it
  through `live-data.mjs` without a deploy.

## Recent work
- **2026-11-22: owner dropped the "prove the 2026-11-07 fixes (#165–#171)" goal from `CLAUDE.md` (#216).** Docs only.

The store's design and status are in [docs/STORE.md](docs/STORE.md); the entries below name what each
merged PR changed.

- **2026-11-22: store design documented in docs/STORE.md; README refreshed; onboarding updated for the store (#215).** New `docs/STORE.md` (why, size model, pack and release model, tables, lanes and publish, dual-write, failure table, rollback, status). The README layout map, design notes and this section were checked against the code and stale text was removed.
- **2026-11-22: holder snapshots order equal balances by address (#214).** Rows with equal balances now sort by balance descending, then address ascending, through one helper (`scripts/lib/holderOrder.js`): account number for `0.0.<n>` addresses (the order sharded-v1 already rebuilds, so sharded files and Hedera rows do not move), code-unit order for every other address. `holders-checkpoint.json` writes every per-address map with keys in code-unit order, and staking totals are summed in ascending value order. Order only: no balance changes and no row is added or dropped. The next nightly rewrites the tied rows once; check it (gates green, holder counts and balances unchanged, no store failures) before building the balance-table formats.
- **2026-11-22: the store's first real table format (#213).** The ever-held list `holders-ever-checkpoint.json` is read as a stream and rebuilt byte for byte from buckets (`scripts/lib/store/tableFormats.js`, `keyRuns.js`); `tableSpecs.js` exports `tableSpecsFor(slug, layout)` from the registry. The committed files of all four coins round-trip with equal sha256. No workflow passes `--table-specs` yet. The snapshot, the raw-balance checkpoint and the sharded snapshot are not registered because a file cannot be rebuilt byte for byte.
- **2026-11-20 and 2026-11-21: fixes to the store dual-write (#211, #212).** The lane step read a run start field the github context does not have (the plan job now records the attempt's start, and `store-restore.js` fails with a named error on an empty `--attempt-start`); the restore check refused every new coin because the overlay left both a manifest and its `.absent` marker (now `scripts/store-overlay.js`).
- **2026-11-20: the nightly writes to the store too (#209).** First workflow wiring: lanes restore, pack and upload a candidate; a `store-publish` job publishes, restore-checks, compares file hashes, commits `data/manifests/` and runs the sweep as a dry run. Every store command runs through `scripts/store-guard.sh` and cannot fail the git path; kill switch is the `store` input or `HD_STORE`; one "Store dual-write failure" issue per run. Release deletion is off.
- **2026-11-19 to 2026-11-20: the store's code (#199, #201, #203 to #208).** #199 table code (buckets, change files, past-day reads and writes, yearly copy, state check); #201 packs and the blob store; #203 bundle, manifest, candidate and chain acceptance; #204 the sweep and the newest-release-only uploader; #205 pack headers carry item type and coin; #206 adoption, stale-code guard and start record; #207 lane restore and pack scripts; #208 the publish step (manifests, index rows, `store.json`, reserved slugs `store` and `site`).
- **2026-11-19: git permissions and safety gates (#200, #202).** `CLAUDE.md` "Git rule" rewritten; gates, secret scan, audit log and the ruleset "protect main" are described there.
- **2026-11-19: the Hedera account scan runs 60 lanes over 50,000-id ranges and counts what the node does (#198, issue #197).** The scan timed out because the public mirror node answered each page more slowly. Unproven until a runner passes with the new counters (`snapshotRequestStats` in the checkpoint).
- **2026-11-19: one contract for every ledger, proven on a generated ledger (#196).** `scripts/lib/adapter/`: contract, readers, seeded synthetic ledger, conformance suite, and `scripts/adapter-size-run.js` (100 million accounts under a 96 MB heap cap). No real ledger is behind the contract yet.
- **2026-11-18: workflows stage only files that exist, for every coin (#195); guard tests keep every coin treated the same (#194); the pipeline no longer depends on data being in git history (#193).** #193: `stateStore.js` is the only past-state reader, per-date counterparty files, `firstLiveDate`, `generatedAt` in `supply-reconciliation.json`, and `npm test` runs without `public/data/` and `data/` (22 data checks moved to `npm run check:data`).

**Older history** (one clause each; details are in the PRs and `git log`):

- #192 HBAR onboarded, history and tier flows start at the first every-balance snapshot; `ProjectChain.tokens` optional. #191 every positive balance is a holder, sharded snapshots (`sharded-v1`), tiers below 1. #190 single-chain snapshots written slim (`slim-v1`) to fit GitHub's file limit. #186 onboarding runbook starts from a name or ticker. #185 nightly at 01:07 UTC. #184 HBAR registered as onboarding.
- #183 onboarding by one answers file and one dispatch, sizing derived per project, wallet-flows and cex-flows convergence, Hedera flows and forensics, `unknown` holder label, token switcher. #182 Hedera settled end-of-day snapshots. #181 standalone flow scans commit their day cutoffs. #180 and #178 one-command onboarding, treasury and WHBAR classification. #177 Hedera full snapshot proven; ONDO tiers derived from its own wallets. #176 Solana flow scans fall back to Alchemy. #175 chain dispatch through one adapter. #174 `COINSTATS_API_KEY`. #173 unreferenced code removed.
- #171 to #161 (2026-11-07): Solana staking-vault owners non-retail, the `holders-refresh` concurrency group, null-transaction hold on the Solana flow scan, council diagnostic, alignment and consistency-check fixes, incremental EVM wallet-flows (#158), Solana cutoffs persisted (#157).
- #154 one day-cutoff and `asOf` convention with `check:alignment`. #145 to #151 onboarding skill as a step-by-step runbook. #128 to #140 developer-wallets ledger, ONDO project and its first-feed fixes, nightly framework (#132), go-live gate (#135), Solana replay fixes (#127). #126 forensics registry for every project.
- 2026-11-05: stale feeds no longer look current (`flowWindow.ts`, `stale-tail` health status). 2026-10-31: header, landing page and brand text "Holder Distribution". 2026-11-01: nightly cost and reliability work (shared Transfer logs, Multicall3 staker reads, run metrics in `rpc-usage.json`, Stage verdict step).
- Opt-in SQD Portal backfill for EVM wallet flows: `generate-wallet-flows.js --source portal`; see [docs/FORENSICS.md](docs/FORENSICS.md).
- Known issue, as last recorded on 2026-11-01 and not re-checked since: the Dune API CEX sync failed with HTTP 402 (the account's datapoint cap); `--source spellbook` is a free supplement and `sync-cex-wallets.yml` runs it for every registry project.

## Deploying

Production deploys are **manual** from the Netlify dashboard — git pushes (including branch
and PR previews) are suppressed by `ignore = "exit 0"` in `netlify.toml`. Read
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before shipping.
