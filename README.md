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
config/projects/<slug>.json        per-token config (tel.json, zebec-network.json, ondo.json)
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
                                   network stake (HBAR is not registered; its onboarding path is built and tested locally)
scripts/scan-hedera-flows.js, generate-wallet-flows-hedera.js   Hedera exchange/tier flows and gated wallet-flows report
scripts/lib/cexFlows.js            cex-flows one-day comparison rule (previous-snapshot rotation, `comparison` block)
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
- **2026-11-13: nightly ready for a long scan, `unknown` holder label, resumed scans bound to their snapshot, token-page redesign (#183).** (1) Holders step limits come from config: `pipeline.holdersScanTimeoutMinutes` (default 20) plus a 35-minute retry, emitted only for the holders job by `scripts/workflow-paths.js matrix <sel> --job holders`. The longest scan runs last. A project whose config fails the limit check is left out, listed by `workflow-paths.js skipped`, and the `skipped-projects` job in `refresh-holders.yml` turns the run red while the other projects still refresh. Hedera asks for a 120-minute scan step in a 270-minute job. (2) A finished Hedera scan is kept and reused when a rerun resolves the same snapshot stamp. An in-progress one resumes only if it is at most 30 minutes older than the snapshot a fresh run would use (6 hours when the run has no pin); otherwise it is rescanned (`resumeStaleReason` in `scripts/lib/hedera/scan.js`). (3) EVM: a partial checkpoint that scanned past the run's pin block is discarded (`partialResumeDecision` in `scripts/lib/partialCheckpoint.js`). Before, it was resumed and balances from after the cutoff were published as the settled day. (4) `largeHolders` accepts `unknown`: traced, identity not established, counts as a holder like `retail`. Two HBAR accounts are recorded that way (`scripts/lib/hedera/nativeDecisions.js`). (5) `cex-flows.json` gains `overall.byChain`; the amount check treats a chain where exchange wallets hold nothing in both snapshots as covered, so TEL (no exchanges on Base) is compared once a nightly rewrites the feed. (6) UI: token switcher in the header (`TokenSwitcher.tsx`, Ctrl/Cmd+K), KPI strip, bottom tab bar on phones, sentence-case labels, Archivo / Inter / IBM Plex Mono. Not yet proven on GitHub: the config-driven step limits, the `skipped-projects` job, and scan reuse against the live mirror. HBAR is still not registered.
- **2026-11-12/13: one answers file, one dispatch, one check; sizing derived per project; UI without TEL shapes; wallet-flows and cex-flows convergence; Hedera flows, forensics and ledger built (#183).** Items 1-2 are the onboarding path (A), 3-4 sizing and go-live rules (B), 6 the circulating rule (C), 5 the UI (D), 7 EVM wallet-flows (E), 8 cex-flows (F), 9 Hedera (G). (1) `npm run onboard -- --address <addr>` now writes an answers template (`tasks/onboard-<slug>.answers.json`); the owner's judgement (staking, wallets with a class, DEX pools, CEX list, history start, large-holder decisions) lives only in that file (`scripts/lib/onboardAnswers.js`, example `config/onboarding.answers.example.json`). `--answers <file> --write` validates it and expands it into the registry entry, project config, ledger, exclusions, CEX file, wallet registry and `config/projects/<slug>/onboarding.answers.json`; a rerun merges idempotently through `fromAnswers` markers, no `--force`. `--write` without answers is refused. Staking has a third decision, `unresolved` (a mechanism exists but its address is not verified): it validates, but `--write` refuses it with a message telling the owner to supply the address or a source, so the site never says "no staking" for a token that has it. `none` now means the docs and explorer were searched and no staking, locking or vote-escrow mechanism exists. (2) Runner (`scripts/onboard-run.js`, `scripts/lib/onboardRun.js`): answers check, a CEX candidate review for Solana projects (after the first snapshot it lists every Dune-spellbook-labelled exchange wallet that holds the token, and blocks until each is under `cex.wallets` or the new `cex.rejected`; `none-known` is done only when the list is empty or fully rejected), large-holder review (every unlabelled wallet above 1% of supply needs a decision), full sizing derived from the project's first snapshot (tiers, ranges, mega and retail thresholds, concentration buckets), strict alignment before the token is listed, history mode must be decided, every stop prints a self-contained `Fix:` block, and the `main` snapshot extracts with tar from a relative path (GNU tar on Windows read `C:` as a host). `npm run onboard:run -- --project <slug> --dry-run --local` evaluates the same plan on the working tree instead of `origin/main` (valid only with `--dry-run`). `npm run onboard:check -- --project <slug>` runs vitest, typecheck, lint, feed consistency, pipeline health and strict go-live with one PASS/FAIL table. (3) Token-unit thresholds scale with supply (`scripts/lib/projectSizing.js`: wallet-flows seller and swap floors, CEX-candidate floor, consistency tolerance with a 1-token floor); ONDO is pinned to the old values in `sizing` so its wallet-flows state hash is unchanged, pending an owner decision. (4) `check-go-live` also fails an empty CEX list, an unresolved DEX pool, answers wallets not excluded as non-retail, a mega threshold outside the supply, own tiers without explicit mega and retail thresholds, and one tier over 90% of wallets; new tests `registrySizing` and `feedCoverage` cover every registered project. (5) UI: chain-neutral supply reconciliation, explorer links per chain including Hedera, treasury chart series built from the feed, Top-N sizes from config, staking labels and deploy date from the feed, tier-flow layout for 2-14 tiers, one compact formatter (`src/lib/format.ts`) with T and sub-1 values, and the association flow panel behind `gated.associationFlows`. (6) Owner rule 2026-11-12: team and holdings wallets are non-circulating on every token except TEL, so ZBCN and ONDO circulating figures change at their next refresh and the next manual deploy (both configs and their `supply-reconciliation.json` were regenerated locally; Treasury and Team stay two rows on the Supply tab). (7) EVM wallet-flows converge (`scripts/lib/walletFlowsHash.js`): the scan hash covers only the sender set, the token fingerprint and the logic version (a stored state under the old hash is adopted when its inputs are unchanged), state is saved per segment and at `WALLET_FLOWS_MAX_MS`, a partial run commits state, writes no report, flags itself and fails when the published report is older than the go-live limit, and swap checks that gave up are retried from leftover budget. After the merge, dispatch `refresh-wallet-flows.yml` for tel (again if it ends partial). (8) cex-flows (`scripts/lib/cexFlows.js`) compares only two comparable snapshots exactly one day apart and carries a `comparison` block (`available`, `reason`, both stamps); `pull-holders-rpc.js` rotates the previous snapshot only under the same rule; `check-feed-consistency` step 8b fails on bad stamps and warns on an amount mismatch against `exchange-flow-history.json`; holders-lite ignores a previous snapshot that is not one day older; the exchange balance change shows no previous value when there is no valid one-day comparison. (9) Hedera (HBAR) is not registered; its onboarding path is built and tested locally and nothing is proven on GitHub. Built: exchange flows and tier outflows by venue from the mirror node (`scripts/scan-hedera-flows.js`, `scripts/lib/hedera/flow*.js`; paging follows `links.next`; account-set hash forces a rebuild; `unattributed` tier bucket), forensics registry, gated wallet flows (`scripts/generate-wallet-flows-hedera.js`; senders are the project's treasury accounts as streams of contiguous ids; 0.0.98, 0.0.800, 0.0.801 and 0.0.54 listed as not traced; explicit partial and error exit states), a ledger branch (`scripts/lib/hedera/ledgerSource.js`), a staked-HBAR tile fed by the `networkStake` block of holders-lite.json (informational, never subtracted), and nightly job entries in `config/nightly-jobs.json`. The runner's `STEP_VMS` now lists hedera for exchange-flows, tier-outflows, wallet-flows and ledger; history stays EVM and Solana only (HBAR history is forward-only by owner decision), and cex-wallets and treasury-cex-history stay EVM only. Not built: DEX/WHBAR look-through, onward-hop tracing, swap decoding, history before the first snapshot. **Unproven until it runs on GitHub:** `onboard-project.yml` end to end with a real token; the `refresh-wallet-flows.yml` partial and commit path and TEL's rescan; the first nightly with the cex-flows `comparison` block; every Hedera workflow step from a runner IP. Also unproven: EVM discovery over real RPC, and a browser check of the UI changes.
- **2026-11-11: HBAR slice 5: settled end-of-day snapshots (#182).** Hedera is now block-pinned like EVM. A run reads the newest mirror snapshot at or before the end of the settled day's last block and replays the transactions after it to that block (`scripts/lib/hedera/settle.js`). Measured on mainnet: over one 902-second snapshot interval (8,416 transactions), all 169 touched accounts matched the next snapshot to the tinybar. `replay.js` now applies a failed transaction's fee legs and no longer cross-checks `staking_reward_transfers`, which can be a tinybar off. Hedera cutoffs resolve with the adapter's block clock in `pull-holders-rpc.js` and `build-cutoffs.js`. `planPins` applies the "checkpoint past the settled block" rule only to forward-scanning VMs (EVM). A day ends at the last block before cutoff[D+1], as for EVM; that block can run a few milliseconds past 00:00 UTC. A settled mainnet run in a scratch worktree (block 102188882, 2,901 transactions replayed) stamped every HBAR feed settled for 2026-11-10, and `check-feed-alignment` reports ALIGNED. A first run's empty holder-transitions feed now carries the snapshot's `asOf`, so a new project's feeds align on day one. HBAR is still not registered.
- **2026-11-11: HBAR through the one-shot path, slice 4: treasury, WHBAR and a supply breakdown that sums to 50B (#180).** `npm run onboard -- --chain hedera` onboards a chain's native coin (no contract): supply and decimals from the mirror node, CoinGecko by coin id. With `--write` it also applies `nativeClassification()` from the Hedera adapter: 551 network treasury accounts (`scripts/lib/hedera/treasury.js`), WHBAR as `dex`, `treasury.categories`, a 180-minute job limit. `scanChain` keeps role-tagged contracts and records the HBAR it leaves out (`unlistedRawTotal`), which reconcile-supply reports as `residualParts.unlisted`. Fixed: `normalizeValidAddress` rejected `0.0.N`, so exclusion, CEX and DEX loaders dropped every Hedera address. The onboarding orchestrator now stops, with a reason, before any workflow that cannot read the project's VM. On the real pipeline in a scratch worktree: retail 43.57B + treasury 5.80B + DEX 0.22B + unlisted 0.41B = 50B exactly. CEX list (owner decisions 2026-11-11): Bybit's proof-of-reserves account plus the HashPack wallet-support list as a lower-confidence tier and 0.0.652978 as Binance, 24 accounts seeded by `scripts/lib/hedera/cexAccounts.js` (research: `docs/hedera-cex-candidates.md`). HBAR is not registered; it still needs cutoffs, history replay, flows, staking, forensics and ledger (`tasks/hedera-plan.md` slices 5-8).
- **2026-11-11: standalone flow scans commit the day cutoffs they create (#181).** A manual `generate-tier-outflows.yml` run for TEL (43021162173) scanned and then failed to push: the scan saved a new day cutoff to `date-blocks.json`, the commit step staged only its own feeds, and `git rebase` stopped on the unstaged file. `generate-tier-outflows.yml` and `scan-exchange-flows.yml` now stage `date-blocks.json` and push through `scripts/push-main.sh`, like the nightly. `scripts/cutoffCommits.test.js` fails any committing job that runs a cutoff-writing script without staging that file.
- **2026-11-11: one-command onboarding, nightly tier scan that converges, one UI for tokens without staking (#178).** (1) `npm run onboard -- --address <addr>` (`scripts/onboard.js`, `scripts/lib/onboard.js`) reads decimals, symbol, name and supply on-chain, the EVM deploy block and date, the CoinGecko id and image, and copies on other chains, then runs `add-project.js` with every flag (dry run unless `--write`). Proven on Jupiter (Solana) over the live network; the EVM path is unit-tested only, because this machine's network blocks most public Ethereum RPC hosts. `add-project.js` now writes `supply.target`, `image`, `staking: []` with the staker feed disabled, `treasury.categories` from the wallets given, `pipeline.historyStart`, and the registry flag `onboarding: true`. (2) `onboard-project.yml` + `scripts/onboard-run.js` (`scripts/lib/onboardRun.js`): one dispatch runs the first-data order for a merged scaffold (CEX sync, snapshot, own tiers, history, exchange flows, treasury/CEX history, tier outflows, staker balances, wallet flows, ledger, check-go-live) and resumes on a rerun; it commits only config edits (derived tiers, the Developer wallets tab, clearing `onboarding`). Dry runs on main report ONDO fully onboarded. Never run against a real new token yet. (3) The landing page and sitemap skip `onboarding` projects, and "Coming soon" drops any token that is listed (ONDO showed twice). (4) A token without staking no longer shows staking copy: the glossary's Staked term, the Holder Growth Staked tab, the Retail Held tip sentence and the supply-breakdown methodology sentence are gated on `staking[]`. (5) `generate-tier-outflows.js` stops at `TIER_OUTFLOWS_MAX_MS` and saves; the nightly sets 20 minutes under its 25-minute step, so a tier reset converges over nights instead of dying unsaved. (6) `check-go-live` also fails a feed `pipeline-health` calls unhealthy (stale file or stale newest row), tier outflows that are incomplete or on other tiers, and a project with no tiers of its own; ZBCN records the owner's 2026-11-09 decision as `holders.defaultTiers`. `check-go-live --all` still passes for TEL, ZBCN and ONDO. Unproven until a scheduled run passes: the nightly tier budget.
- **2026-11-11: ONDO feeds regenerated on its own tiers (data runs after #177, no code change).** All one-off, manual workflow runs; no nightly replays history. (1) `rebuild-holders-history.yml` for ondo, `chain=ethereum`, `start=2024-01-18` (11 min): all 1,029 days use the new tiers, and the latest day's tier counts sum to its holder count. (2) `refresh-holders.yml` for ondo: snapshot, holders-lite, history and transitions regenerated. Its tier-outflows step can't finish a rescan after a tier change: 25 minutes on public RPC, nothing saved when killed. (3) The standalone `generate-tier-outflows.yml` for ondo (keyed RPC, 5.5 min): new tier fingerprint, `complete: true`, 368 days. **Regeneration order after any tier change, all before the next nightly:** `rebuild-holders-history.yml`, then `refresh-holders.yml` for the project, then `generate-tier-outflows.yml`, then `npm run check:feeds`. The site shows the new tiers after the next manual Netlify deploy.
- **2026-11-10: Hedera (HBAR) full snapshot proven, still not registered (#177).** Registry validation and the scaffold accept a native-coin chain (`--chain hedera:native:8`, `asset: { kind: "native", decimals }` instead of `tokens[]`). The `/balances` scan saves progress after every full page and resumes a pinned snapshot at any age, and a scan that throws flushes its progress first. Every balance at the snapshot, contracts and dust included, must add up to total supply, or `scanChain` refuses the snapshot. A dry run to scratch (one attempt, 93 minutes, 126k requests) found 681,678 holders of at least 1 HBAR, with all balances summing to exactly 50,000,000,000 HBAR. Unreleased supply matched total minus released at the same snapshot to the tinybar, once 0.0.900-1000 was dropped from the unreleased list. `scripts/lib/hedera/replay.js` applies one day's HBAR transfers to a baseline; nothing calls it yet. No project is registered, so TEL, ONDO and ZBCN are unchanged.
- **2026-11-10: ONDO gets tiers derived from its own wallets (#177).** Owner rule: no project reuses TEL's or another project's tiers, as is or scaled by supply. ONDO's tiers were TEL's divided by 10. `scripts/derive-holder-tiers.js` (logic in `scripts/lib/deriveHolderTiers.js`) sets distribution edges at fixed holder ranks from the top of a project's own snapshot (0.01% of wallets down to 60%), rounded to 1 / 2.5 / 5 x 10^k, and Wallet Holdings ranges as even powers of ten. From ONDO's 2026-11-07 snapshot (174,016 holders): 50M+, 10M-50M, 1M-10M, 100K-1M, 50K-100K, 10K-50K, 5K-10K, 1K-5K, 100-1K, 1-100 (largest tier 35.6% of wallets), and its own Wallet Holdings ranges 1-10 to 1M+. Tier labels are join keys, so ONDO's history is replayed with `rebuild-holders-history.yml` and the downstream feeds regenerated in the order given in the 2026-11-06 entry. The onboard-project skill and `docs/MULTI-TOKEN.md` now derive tiers per project after the first snapshot. TEL and ZBCN tiers are unchanged.
- **2026-11-08: Solana flow scans can fall back to Alchemy (#176).** Helius stays first. `scripts/lib/solana/flowBackup.js` retries a failed `getTransaction` on Alchemy (`SOLANA_FLOW_RPC_0/1` in `.env.enc`), and asks it once more before a transaction would be given up. No other Solana path can reach Alchemy. Capped at 10M CU a month (`config/budgets.json`, `monthly.solanaBackupAlchemyCu`), because the 30M CU pool is shared; backup CU can't trip EVM or staking job budgets. No feed path changed.
- **2026-11-08: chain dispatch goes through one adapter, Hedera adapter added, not registered (#175).** Hardcoded evm-or-solana branches now route through `scripts/lib/chainAdapters.js`, and an unknown chain type fails loudly instead of being treated as EVM or Solana. `scripts/lib/hedera/` reads the public Hedera mirror node with a single pinned snapshot and a confirmed end to every range. No project uses it yet, so TEL, ONDO and ZBCN are unchanged.
- **2026-11-08: added `COINSTATS_API_KEY` to `.env.enc` (#174).** Encrypted alongside the other keys for read-only onboarding discovery (chain cross-check, top-holder evidence). No script or workflow uses it yet; no feed changed.
- **2026-11-08: removed unreferenced code (#173).** Deleted the unreferenced components `DataFreshness`, `HeadlineBody` and `ui/hover-card` (and their entry in `projectCopyCoverage.test.ts`), the finished TEL one-off `scripts/backfill-cumulative-holders-gap.js`, and the two stale audit result files `audit/audit-results.json` and `audit/local-audit-results.json`. No feed, workflow or data path changed.
- **2026-11-07: new tokens, Solana especially, onboard through the same fixes as the merged ones (#171).** `docs/MULTI-TOKEN.md`, `docs/NIGHTLY-FRAMEWORK.md` and the onboard-project skill now cover the null-tx cursor hold, the `holders-refresh` concurrency group, the unpinned treasury stale guard, `--skip-if-no-query` and token-account owners; `add-project.js` scaffolds an empty per-project exclusions file. New gates: `check-go-live --section feeds` (go-live only, no workflow runs it, so the daily refresh is never blocked) fails a Solana project while a flow cursor is held (`unavailable[].attempts` below 3), every Dune call must carry `--skip-if-no-query` and none may use TEL's query 3761086, an unlabelled ledger association wallet fails instead of skipping, and no Solana role-account owner may count as retail. Owner decision 2026-11-07 (Treasury = Team): ONDO gets `config/projects/ondo/exclusions.json` labelling its 4 association wallets as treasury (no supply change today, they hold no ONDO), and TEL labels `0xe71e…5105` "Association CoW Safe" as treasury (supply-reconciliation.json regenerated offline from the committed snapshot). Owner decision 2026-11-07 also marks the TEL selling operation as Telcoin Holdings (category holdings): the sell hub `0x17fc…4143`, its 10 ParaSwap sell bots and the USDC proceeds collector `0x7c3d…dc55`; the two KuCoin relays (`0x1128…bb41`, `0x5b34…b4b0`) are recorded as KuCoin deposit addresses in `config/cex-wallets.json`, and the ledger hub is relabelled "Telcoin Holdings sell hub". Reclassified 118.8M TEL from retail to holdings (circulating unchanged).
- **2026-11-07: Dune CEX sync runs only for projects with a query id (#169).** The `dune_sync` step in sync-cex-wallets.yml now passes `--skip-if-no-query`, so a project without `pipeline.duneCexQueryId` (and not legacy TEL) exits 0 with a notice instead of failing or spending Dune credits (402 on the cap).
- **2026-11-07: Solana staking-vault owners count as non-retail in every feed (#170).** `projectNonRetailPaths(project, root, snapshot)` now adds the token-account owners of `contracts{}` role accounts (from `tokenAccountOwnersByChain`) to the non-retail set, via one shared `projectRoleAccounts` helper that `pull-holders-rpc.js` also uses. Resync, lite, history and transitions previously counted those owner wallets as retail while reconcile-supply labelled them staking, so retail disagreed by the staking amount (41,894,169 ZBCN on 2026-11-02) and `check:feeds` failed.
- **2026-11-07: feed consistency no longer compares a head read with the last settled treasury row (#168).** Run 42389235832 failed with council 461.7M (supply-reconciliation, head) vs 561.7M (treasury-history 11-07, settled before a real 100M council transfer on Polygon at ~14:13Z). `check-feed-consistency.js` check 3 now skips on an unpinned snapshot, like check 1, but still fails if treasury-history's newest row is older than the day before the snapshot date. New `scripts/checkFeedConsistency.test.js`.
- **2026-11-07: every workflow that pushes to main shares the `holders-refresh` concurrency group (#167).** An ondo commit hit a rebase conflict when another run pushed the same `public/data` files mid-run. fill-history-gaps, generate-tier-outflows, scan-exchange-flows, rebuild/recompute-holders-history, refresh-staker-balances, refresh-ledger (it also commits `rpc-usage.json`) and sync-cex-wallets now queue behind each other; missing timeouts were added. `scripts/workflowConcurrency.test.js` fails any main writer outside the group unless allowlisted with a reason (detect-cex-candidates, strip-dead-rpc-key).
- **2026-11-07: Solana flow scan no longer skips past a null transaction (#166).** When `getTransaction` returns null, `scripts/lib/solana/flowScan.js` now holds the venue cursor below it for up to `NULL_TX_RETRY_RUNS` (3) runs, retrying it first each run; every null in the chunk is charged per run, slots are never split. After the budget it advances and stays recorded in `unavailable`/`missing`. Old checkpoints without `attempts` load as 0.
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
- **2026-11-06: ONDO gets its own holder tiers.** ONDO had no `holders` block, so it inherited `config/holder-tiers.default.json` (TEL's tiers, sized for a 100B supply): 99.8% of its 214K wallets sat in the '1-250K' tier and the 250M-500M and 100M-250M tiers were empty, which made the Distribution concentration look wrong. `config/projects/ondo.json` now declares tiers sized for its 10B supply (50M+, 25M-50M, 10M-25M, 5M-10M, 2.5M-5M, 1M-2.5M, 500K-1M, 100K-500K, 25K-100K, 1-25K; TEL's divided by 10) and `megaHolderThreshold` 2B (20% of supply, TEL's ratio). `scripts/lib/registryTiers.test.js` checks every registered project's tiers are contiguous, ordered, open at the top, start at 1 and have unique labels. Tier labels are join keys into `holders-history`, `holder-transitions` and `tier-outflows`, so changing them needs a regeneration (current order: the 2026-11-11 entry). Until the history is rebuilt the Distribution table shows no change column for ONDO (old labels do not match). When you onboard a token, derive its tiers from its own first snapshot before the first rebuild (`scripts/derive-holder-tiers.js`; superseded the supply-sizing rule on 2026-11-10). The largest ONDO retail wallet (0x460a..., 729.5M, an unlabeled wallet that looks like a trading hub, not Foundation-funded) is deliberately left in retail.
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
