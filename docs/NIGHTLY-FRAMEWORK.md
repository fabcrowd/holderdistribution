# Nightly framework

Reviewer guide for the shared nightly job plan, the Alchemy compute-unit (CU) budget guard, the public ledger source, and chain-inventory onboarding. This file describes the branch `feature/nightly-framework` (PR #132). It does not change runtime behavior.

Two commits:

| SHA | What |
|---|---|
| `310e69b` | The framework (patch from `5a2ceef`, applied onto main at `9f329a2`). |
| `65c054b` | `pipeline.feedsPending` so CI can pass while ONDO has no committed feeds. |

Nothing under `public/data/` is in either commit. A local `npm run build` rewrites `netlify/functions/forensics-gate.cjs`; that rewrite was reverted and is not in the branch.

## Goal

Every registered project (TEL, ZBCN, ONDO, and the next one) runs the same nightly jobs and produces the same data sets. A job a project does not run is either `n/a` (it lacks a required capability) or `waived` with a written reason. Silence is not a skip.

Alchemy CU is reserved for backfills and for the few calls that have no free source. Provider order is cheapest first and Alchemy last. Solana never uses Alchemy: this account has no Alchemy Solana nodes, so `alchemy` is stripped from the provider list, the per-run budget becomes 0 CU in `enforce` mode, and Solana RPC pools drop Alchemy URLs.

## Architecture

```
config/projects.json          which projects exist
config/projects/<slug>.json   chains, staking, nightly.waivers
config/nightly-jobs.json      the shared job list
        │
        ▼
scripts/lib/nightlyPlan.js    run / waived / n/a, provider list, HD_JOB_* env
        │
        ├─ scripts/workflow-paths.js matrix <sel> --job <id>
        │     GitHub matrix: "all" keeps projects that run the job;
        │     a named slug always runs (manual dispatch)
        ├─ scripts/workflow-paths.js job <id>
        │     prints HD_JOB_* for the step
        └─ scripts/write-pipeline-status.js
              <dataDir>/pipeline-status.json
```

### Job list (`config/nightly-jobs.json`)

Each job declares:

- `dataset` — the data set it produces. Chain-specific twins share a dataset (`staker-balances` and `solana-staking` are both `staking`; `exchange-flows` and `solana-flows` are both `exchange-flows`).
- `requires` — capabilities the project must have. Empty means every project.
- `providers` — order to try sources. `alchemy`, when present, is last. `loadNightlyJobs` rejects any other order, an unknown provider, or an `alchemyOnly` job that lists anything besides `alchemy`.
- `alchemyCuPerNight` — per-project per-run Alchemy CU budget (`HD_JOB_ALCHEMY_CU_BUDGET`).
- `budgetMode` — `enforce` or `warn`.
- `alchemyOnly` — no free source. When the budget is spent the step is skipped, not degraded onto a worse source.
- `outputs[].maxAgeHours` — freshness SLA. Paths are written in the TEL layout and mapped per project (`public/data/<f>` → `<dataDir>/<f>`, `data/<f>` → `data/<slug>/<f>`, `{slug}` stays per-project even for TEL).
- `workflow` — the Actions file that runs it.

Capabilities come from config and from files on disk, never from the slug (`projectCapabilities`):

| Capability | Present when |
|---|---|
| `evm` / `solana` | `chains[]` has that VM |
| `stakeChanged` | a staking contract of kind `stakeChanged` (TEL staker balances) |
| `zebecStakeV1` | a Zebec stake program (Solana staking) |
| `forensicsRegistry` | `<workDir>/forensics/wallet-flows.registry.json` exists |
| `ledgerConfig` | `config/projects/<slug>/ledger.json` exists |

`providersFor` then drops `alchemy` when the project has no EVM chain, and drops `helius` when it has no Solana chain. `jobEnv` does the same for the guard: no EVM chain forces `HD_JOB_ALCHEMY_CU_BUDGET=0` and `HD_JOB_BUDGET_MODE=enforce`, even if the job's own mode is `warn`. `resolveJobEnv` repeats that when the workflow sets `HD_HAS_EVM=false` (`workflow-paths.js`).

### Current plan

| job | requires | providers (in order) | CU/run | mode | tel | zbcn | ondo |
|---|---|---|---|---|---|---|---|
| holders | – | public, helius, alchemy | 5000 | warn | run | run | run |
| exchange-flows | – | public, helius, alchemy | 2000 | warn | run | run | run |
| tier-outflows | – | public, helius, alchemy | 2000 | warn | run | run | run |
| solana-flows | solana | helius, public | 0 | enforce | n/a | run | n/a |
| staker-balances | stakeChanged | public, alchemy | 1000 | enforce | run | n/a | waived |
| solana-staking | zebecStakeV1 | helius, public | 0 | enforce | n/a | run | n/a |
| history-gaps | evm | alchemy only | 5000 | warn | run | waived | run |
| wallet-flows | forensicsRegistry | public, helius, coingecko, alchemy | 0 | enforce | run | run | run |
| ledger | ledgerConfig | public, etherscan, helius, alchemy | 0 | enforce | run | run | run |
| cex-candidates | evm (weekly) | public | 0 | enforce | run | waived | run |
| cex-sync | – (semimonthly) | public, helius | 0 | enforce | run | run | run |

For ZBCN (Solana only) every row that lists `alchemy` is rewritten to drop it, and the guard hard-blocks Alchemy (budget 0, enforce). `history-gaps` is `alchemyOnly`, so with no EVM chain it does not run; the waiver records why.

Waivers in config today:

- TEL: `nightly.waivers` is `{}`. Every applicable job runs.
- ZBCN: `history-gaps` (the gap filler is EVM block timestamps; there is no Solana port) and `cex-candidates` (EVM transfer graph only; ZBCN exchange wallets come from `cex-sync`).
- ONDO: `staker-balances`. ONDO has no StakeChanged contract and no Zebec program, so both staking jobs would otherwise be `n/a` and the `staking` dataset would have no run and no waiver. The parity test requires each dataset to run, or to be waived with a reason.

A waiver with an empty reason throws (`jobStatusFor`, and `validateProjectConfig`). A waiver for an unknown job id throws inside `nightlyPlan`.

### Budget guard

`scripts/lib/rpcMetrics.js`, called from `scripts/lib/rpc.js` before every Alchemy request. Active only when `HD_JOB_ID` is set, so local runs and tests that do not set it are unchanged.

Two limits, both estimates from the published Alchemy rate card (`ALCHEMY_CU`; unlisted methods use 26 CU). The Alchemy dashboard remains the billing source of truth.

1. **Per run.** `HD_JOB_ALCHEMY_CU_BUDGET` (from `alchemyCuPerNight` when the step only sets `HD_JOB_ID`).
2. **Per month.** `config/budgets.json` `monthly.alchemyCu` is **30,000,000**. `monthlyAlchemy` sums `data/rpc-usage.json` (TEL) and `data/<slug>/rpc-usage.json` for the current UTC month, plus CU this process has already sent.

`budgetMode`:

- `enforce` — throw `AlchemyBudgetError` (`code: "ALCHEMY_BUDGET"`). `getUsableRpcUrls` drops Alchemy keys so the pool falls through to the next provider. An `alchemyOnly` job with nowhere to go throws and the step skips.
- `warn` — log one `::warning::` per reason per process and let the call through. Used where a hard stop could leave a feed stale (holders, exchange-flows, tier-outflows, history-gaps). The comment in `nightly-jobs.json` says to tighten these to `enforce` after a month inside budget.

`alchemyBlocked()` is the up-front form of the same check (a 0 CU enforced budget is blocked before the first call).

### Public ledger source

`scripts/lib/ledger/evmSource.js` `logsAssetTransfers` reads ERC-20 `Transfer` logs with `eth_getLogs` and returns rows in the `alchemy_getAssetTransfers` shape (`blockNum`, `uniqueId`, `hash`, `from`, `to`, `rawContract`, `metadata.blockTimestamp`). `getLogs` bisects a range a public node refuses. Block timestamps are `eth_getBlockByNumber`, cached per block.

`ledgerEvmProviderOrder` follows `HD_JOB_PROVIDERS`. With no job env the order stays `["alchemy"]`, which is the previous behavior. The nightly ledger step sets `HD_JOB_ID=ledger`, so the order is public, then Alchemy, with a 0 CU enforced budget. `scripts/build-ledger.js` tries each URL in that order and records which provider actually served the chain. Etherscan is still the cross-check (`--skip-cross-check` turns that off), not the primary scan.

Cost note: public mode does one `eth_getBlockByNumber` per block that has transfers. A full ONDO backfill on public RPC is slow; use Alchemy for that backfill. The nightly incremental run is the 0 CU target.

### Pipeline status and the watchdog

`node scripts/write-pipeline-status.js [--project <slug> | --all] [--check] [--json] [--out-dir <dir>] [--no-write]`

Writes `<dataDir>/pipeline-status.json` (TEL: `public/data/pipeline-status.json`). One row per job: status, reason, providers, budget, Alchemy CU from the latest day in that project's `rpc-usage.json` (summed across the job's scripts), and each output's age against `maxAgeHours`. Timestamps come from `generatedAt` / `generated` / `updatedAt`, else the last git commit that touched the file, else `no-timestamp`. `--check` exits 1 when a scheduled job is missing, stale, or over budget.

`.github/workflows/pipeline-watchdog.yml` runs `write-pipeline-status.js --all --no-write --json` on its existing daily cron and files or comments on a `pipeline-stale` issue titled "Nightly jobs: missing, stale or over-budget outputs". It does not write the status files (the refresh workflows commit `pipeline-status.json`).

### Workflows

Scheduled data workflows no longer default `HD_PROJECT` to `tel`. A `plan` job runs `node scripts/workflow-paths.js matrix "$SELECTION" --job <id>`. `SELECTION` empty means every project the plan marks `run`. Each matrix job exports `HD_PROJECT` and `HD_JOB_ID`. `refresh-holders.yml` is still the one daily workflow; its stages set their own `HD_JOB_ID` (`staker-balances`, `solana-staking`, `holders`, `solana-flows`, `exchange-flows`, `tier-outflows`, `history-gaps`). The other per-job workflows are `refresh-wallet-flows.yml`, `refresh-ledger.yml`, `detect-cex-candidates.yml` (weekly), and `sync-cex-wallets.yml` (semimonthly).

Manual `workflow_dispatch` with a project slug still runs that slug even when the plan would skip it.

### Chain inventory and `add-project.js`

Onboarding step 1, before any scaffold or scan. `config/projects/<slug>/chains-inventory.json` lists every chain the token was checked on.

| status | meaning |
|---|---|
| `configured` | in `chains[]`, same token addresses. Seeded and shown. |
| `excluded` | found and left out. Needs a `reason`. |
| `not-found` | checked, no deployment. Needs a `reason`. |
| `candidate` | found, not decided. **Fails validation.** |

`scripts/lib/chainInventory.js` `validateInventory` is the gate: every configured chain and token address appears as `configured`, every other row is decided and has a source, excluded and not-found rows have a reason. `scripts/lib/chainInventory.test.js` runs that check on every registered project.

`scripts/chain-inventory.js` writes the file. Network use is keyless public RPC (`eth_call` `totalSupply`, Solana `getTokenSupply`) and CoinGecko's keyless coin endpoint. Alchemy URLs are never used (0 CU). `--check` is offline.

```bash
node scripts/detect-token-chains.js --address 0x… --chain <origin> --ticker <T> --coingecko --out /tmp/d.json
node scripts/chain-inventory.js --project <slug> --discovery /tmp/d.json [--extra rows.json]
node scripts/chain-inventory.js --project <slug> --check
```

`scripts/add-project.js` **requires** `--inventory <file>` and refuses to scaffold when it is missing, when a `--chain` is absent, when a row is still `candidate`, or when an excluded or not-found row has no reason. It copies the validated inventory to `config/projects/<slug>/chains-inventory.json`.

ONDO, recorded in `config/projects/ondo/chains-inventory.json`: Ethereum only, `0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3`, 10B supply (CoinGecko and docs.ondo.foundation). BSC `0x93265B17…7512` is excluded (unofficial: 9 decimals, 1T supply, not in Ondo's docs or on CoinGecko). No ONDO Solana mint (Ondo's bridge carries USDY and Ondo Stocks, not ONDO). Every other checked chain is `not-found`.

## Per-file change list

### New

| File | Why |
|---|---|
| `config/nightly-jobs.json` | The shared job list: dataset, providers, CU budget, mode, outputs, workflow. |
| `scripts/lib/nightlyPlan.js` | Loads that list, derives capabilities, decides run / waived / n/a, builds `HD_JOB_*`, maps output paths. |
| `scripts/lib/nightlyPlan.test.js` | Schema, Alchemy-last, ledger 0 CU, dataset parity, matrix filtering, `jobEnv`. |
| `scripts/lib/budgetGuard.test.js` | Guard is a no-op without `HD_JOB_ID`; enforce vs warn; 0 CU block; config fill-in; monthly sum across projects. |
| `scripts/lib/nightlyMultiChain.test.js` | An EVM+Solana fixture keeps both providers (Alchemy last). A Solana-only project, including real ZBCN, never lists Alchemy, and the guard hard-blocks it. Solana pools drop Alchemy URLs. |
| `scripts/lib/chainInventory.js` | Inventory schema and `validateInventory` / `buildInventory`. Pure; no network. |
| `scripts/lib/chainInventory.test.js` | Every committed inventory covers its config. A multi-chain build computes supply shares and rejects an undecided candidate. |
| `scripts/chain-inventory.js` | CLI: public-RPC supply, CoinGecko, `--check`. |
| `scripts/write-pipeline-status.js` | Per-project status file and the watchdog's `--check` input. |
| `scripts/lib/ledger/evmLogsSource.test.js` | Public `eth_getLogs` rows match `alchemy_getAssetTransfers` rows, including a full incremental scan. Unset `HD_JOB_PROVIDERS` stays on Alchemy. |
| `config/projects/tel/chains-inventory.json` | TEL's committed chain inventory. |
| `config/projects/zebec-network/chains-inventory.json` | ZBCN's committed chain inventory. |
| `config/projects/ondo/chains-inventory.json` | ONDO's committed chain inventory (see above). |
| `docs/NIGHTLY-FRAMEWORK.md` | This guide. |

### Modified

| File | Why |
|---|---|
| `scripts/lib/rpcMetrics.js` | Alchemy CU rate card was already here. Adds `resolveJobEnv`, `guardAlchemyCall`, `alchemyBlocked`, `AlchemyBudgetError`, and the monthly sum. |
| `scripts/lib/rpc.js` | Calls the guard before an Alchemy request. When the enforced budget is spent, drops Alchemy keys from the pool (or throws for `alchemyOnly`). |
| `scripts/lib/solana/rpc.js` | `notAlchemy` filters every Solana pool. `solanaCall` refuses an Alchemy URL. |
| `scripts/lib/ledger/evmSource.js` | `logsAssetTransfers` and `ledgerEvmProviderOrder`. |
| `scripts/build-ledger.js` | Tries public `eth_getLogs` first when the job says so, then one Alchemy URL. Records the provider that served the chain. |
| `scripts/workflow-paths.js` | `matrix --job` filters to projects that run the job. `job <id>` prints `HD_JOB_*`. |
| `scripts/lib/projects.js` | `validateProjectConfig` rejects a waiver with no reason. |
| `scripts/add-project.js` | `--inventory` is required. Copies it next to the project after validation. Prints the nightly plan for the new slug. |
| `scripts/add-project.test.js` | Refuses a missing inventory, a missing chain, a candidate, and an excluded row with no reason. A valid inventory is written into the scaffold. |
| `scripts/add-project.e2e.test.js` | The fake EVM and Solana scaffolds pass an inventory. |
| `config/projects/tel.json` | `nightly.waivers: {}` so the empty set is explicit. |
| `config/projects/zebec-network.json` | Waivers for `history-gaps` and `cex-candidates`, each with a reason. |
| `config/projects/ondo.json` | Waiver for `staker-balances`. `pipeline.feedsPending` is the follow-up commit. |
| `.github/workflows/refresh-holders.yml` | Matrix from `--job holders`. Each stage sets `HD_JOB_ID`. Staker step comment records the 618 CU/day measurement and why it stays on keys. |
| `.github/workflows/refresh-wallet-flows.yml` | Matrix `--job wallet-flows`, `HD_JOB_ID=wallet-flows` (0 CU, enforce). |
| `.github/workflows/refresh-ledger.yml` | Matrix `--job ledger`, `HD_JOB_ID=ledger` (public first, 0 CU, enforce). |
| `.github/workflows/detect-cex-candidates.yml` | Matrix `--job cex-candidates` instead of a hardcoded TEL default. |
| `.github/workflows/sync-cex-wallets.yml` | Matrix `--job cex-sync`. |
| `.github/workflows/pipeline-watchdog.yml` | Second issue source: nightly status across every project. |
| `docs/MULTI-TOKEN.md` | Onboarding step 1 (inventory) and the nightly checklist that points at this plan. |
| `scripts/validate-outputs.js` | `feedsPending` skip. Follow-up commit, not the framework patch. |
| `scripts/check-feed-consistency.js` | Same skip. |
| `scripts/lib/projectPipelinePorts.test.js` | Proves the skip exits 0 and writes nothing when the data dir is absent. |

## How to run tests, and what they prove

From a clean install, with `RPC_PREFER_PUBLIC` unset (one `rpc` test asserts the keyless default; three cases fail only when that variable is `1` — see Known issues):

```bash
npm ci
env -u RPC_PREFER_PUBLIC npx vitest run
npm run typecheck
npm run lint
npm run check:feeds
npm run build
```

Do not point these at live Alchemy. The new tests are fixtures and mocks. `chain-inventory.js` without `--check` does call public RPC; the tests do not.

On this branch, before this doc commit: vitest 210 files, 1,992 tests passed; `tsc --noEmit` passed; eslint 0 errors (4 pre-existing `react-refresh/only-export-components` warnings in UI files); `check:feeds` passed; `vite build` passed.

| Test | Proves |
|---|---|
| `scripts/lib/nightlyPlan.test.js` | Every job has a dataset, a provider list, a finite CU budget, `enforce` or `warn`, and a workflow file that exists. Alchemy is last. Only `alchemyOnly` jobs have no free provider. Ledger is public-first, 0 CU, enforce. Every registered project loads, and every dataset runs or is waived with a reason longer than 10 characters. An empty waiver throws. `workflowMatrix("all", …, { job })` equals the projects whose status is `run`; a named slug is included even when the job would not schedule it. The five scheduled workflows do not hardcode `inputs.project \|\| 'tel'`. `jobEnv` exports provider order and budget. Output paths map like `workflow-paths` files mode, and `{slug}` is per-project for TEL too. |
| `scripts/lib/budgetGuard.test.js` | No `HD_JOB_ID` means the guard does nothing. `enforce` throws on the call that would cross the per-run budget and `alchemyBlocked` becomes true. `warn` logs and allows the call, including at 0 CU. `enforce` at 0 CU blocks the first call. Setting only `HD_JOB_ID` fills budget, mode, and `alchemyOnly` from `nightly-jobs.json` (`ledger` → 0 / enforce; `history-gaps` → alchemyOnly, warn). The monthly ceiling sums `data/rpc-usage.json` plus `data/<slug>/rpc-usage.json` for this UTC month. |
| `scripts/lib/nightlyMultiChain.test.js` | A fixture with Ethereum, Base, and Solana gets both VMs' capabilities, runs every applicable job, and keeps Alchemy (last) and Helius. `projectStatus` lists runs and waivers with reasons. A Solana-only fixture and the real `zebec-network` config list no `alchemy` provider; `alchemyOnly` jobs do not run. `resolveJobEnv` with `HD_HAS_EVM=false` forces budget 0 and enforce even for a warn-mode job. Solana candidate lists and the failover path never call an Alchemy URL. |
| `scripts/lib/ledger/evmLogsSource.test.js` | The same fixture logs become identical transfer rows from `logsAssetTransfers` and from the Alchemy normalizer. A full incremental scan yields the same transfers, bot transfers, cursor, and swap flags. Provider order is opt-in via `HD_JOB_PROVIDERS`; unset stays `["alchemy"]`. |
| `scripts/lib/chainInventory.test.js` | TEL, ZBCN, and ONDO inventories match their configs (no undecided candidate, every excluded or not-found row has a reason). `buildInventory` emits EVM and Solana rows, computes supply share over canonical tokens, and `validateInventory` fails a leftover candidate. |
| `scripts/add-project.test.js` | Scaffold still writes registry, project config, ledger config, and an empty wallet registry. It throws if `--inventory` is omitted, if the inventory misses the `--chain`, if any row is `candidate`, or if an excluded row has no reason. A valid inventory is copied to `config/projects/<slug>/chains-inventory.json`. |
| `scripts/add-project.e2e.test.js` | Fake EVM and Solana projects scaffolded with an inventory show up in the tab, the gate keys, and the workflow matrix. |
| `scripts/lib/projectPipelinePorts.test.js` (new case) | `validate-outputs.js` and `check-feed-consistency.js` exit 0 with `SKIP pending: pipeline.feedsPending` when `pipeline.feedsPending` is true and the data directory does not exist. They do not create that directory. |

`npm run check:feeds` is `validate-outputs.js --all` then `check-feed-consistency.js --all`. CI (`.github/workflows/ci.yml`) runs lint, typecheck, `npm test`, `check:feeds`, and `build` on pull requests. Markdown-only pushes are in `paths-ignore`, so a docs commit does not re-run that workflow.

## CU before and after

Figures are estimates in `data/rpc-usage.json` (TEL), not the Alchemy invoice.

**Before** (1–4 Nov 2026, one run each day): the only Alchemy spend recorded is `pull-staker-balances.js`, **618 CU/day, 33 Alchemy calls, 0 public calls**. `pull-holders-rpc.js`, `scan-exchange-flows.js`, and `generate-tier-outflows.js` recorded 0 Alchemy CU (they already run with `RPC_PREFER_PUBLIC=1`). The ledger's default source was `alchemy_getAssetTransfers` (120 CU per call on the rate card) whenever a ledger run used Alchemy. No `build-ledger.js` row appears in those four days.

**After**, for a nightly run with `HD_JOB_ID` set:

| Job | Budget | Mode | Expected Alchemy |
|---|---|---|---|
| staker-balances (TEL) | 1000 | enforce | Still about 618 CU/day. Public Polygon was too slow (see Known issues). The cap refuses the call that would cross 1000 and the pool falls through to public. |
| ledger | 0 | enforce | Public `eth_getLogs` first. Alchemy is refused. Target 0 CU. |
| wallet-flows, solana-flows, solana-staking, cex-candidates, cex-sync | 0 | enforce | No Alchemy by budget (and Solana jobs never had an Alchemy provider). |
| holders, exchange-flows, tier-outflows | 5000 / 2000 / 2000 | warn | Logged, not blocked, if they exceed the budget. Today they record 0. |
| history-gaps | 5000 | warn | Alchemy only. Skipped, not degraded, when the enforced monthly ceiling or a future enforce-mode budget is spent. ZBCN is waived. |

The monthly ceiling stays 30,000,000 CU in `config/budgets.json`, summed across every project's `rpc-usage.json`.

## The `feedsPending` commit

`65c054b` — "Skip feed gates for ONDO until its first snapshot is committed."

Main's CI was already red before this branch. Run [41781822880](https://github.com/fabcrowd/holderdistribution/actions/runs/41781822880) ("Add the ONDO project") failed `npm run check:feeds` because `public/data/ondo/` does not exist (`tel-holders.json`, `holders-summary.json`, `holders-history.json`, `cex-wallets.json`, `holders-lite.json` all ENOENT). ONDO is a registered project, so `--all` includes it. Generating those feeds would be a live scan and a `public/data` change; both were out of scope for this PR.

Removed: the owner ruled out skips, so `feedsPending` no longer exists and `check:feeds` fails until ONDO has real feeds. Original behavior: `config/projects/ondo.json` set `pipeline.feedsPending: true`. `validate-outputs.js` and `check-feed-consistency.js` exit 0 with a `SKIP` line only when that flag is true **and** the data directory is absent. TEL and ZBCN do not set the flag, so their gates are unchanged. If the directory exists, the flag does not skip: shape and consistency checks run. Remove `feedsPending` in the commit that adds the first ONDO snapshot.

## Known issues / open items

Measured 4 Nov 2026 with `scripts/probe-log-ranges.js` (public endpoints, 0 Alchemy CU). The follow-up commit fixes the log-range items below; the tests are `scripts/lib/logRangeLimits.test.js` and `scripts/lib/rpcParity.test.js`.

### Public log-range limits (fixed)

Limits live in `config/public-rpc-limits.json`, keyed by **host** (never by project), and every scanner that calls `rpc.js` `rpcCall`/`getLogs` gets them: holders, wallet-flows, ledger (`logsAssetTransfers`), exchange flows, tier outflows and gap-fill (`fill-history-gaps.js` via `rpcCall`).

| Host | Measured | Config |
|---|---|---|
| Tenderly Ethereum / Polygon | 20k-result cap, suggests a sub-range | `maxGetLogsResults: 20000` |
| Tenderly Base | 1,000 blocks without an access key | `maxBlockRange: 1000` |
| mevblocker | 10k blocks or 10k logs; HTML 429 with `Retry-After: 0` | `maxBlockRange: 10000`, 2 rps, 1 concurrent |
| polygon publicnode | 10k blocks | `maxBlockRange: 10000` |
| pocket | 10,001 blocks | `maxBlockRange: 10001` |
| blxrbdn Base | wide but slow | rate only |
| polkachu | down | rate only |
| Alchemy (keyed, not listed) | Free plan: 10 blocks on every chain | learned per key URL |

- **Stated caps are used as-is.** "maximum 1000 blocks", "maximum block range: 10000", "max 10001 blocks" set the span to that number (`statedBlockCap`); nothing halves 10000 → 625 any more. A configured `maxBlockRange` is used from the first request.
- **Result-count caps are density-dependent.** A rejection shrinks only the current stretch; the span doubles back after each success. Only if a regrow is rejected again does it hold (and re-probe 2x every 8 wins), and that held span is where the next call on the URL starts.
- **`Retry-After: 0` or missing is a minimum backoff** (500 ms floor, exponential with jitter), and a 429 halves the host's rate for every caller.
- **Alchemy's 10-block limit is remembered per key URL**, so only the first call on a free-tier key pays the rejection; other keys are not affected.

### Mid-scan holders checkpoint (fixed)

`pull-holders-rpc.js` writes `holders-partial-<chain>.json` in the project's work dir (`projectWork(project)`, `data/` for TEL, `data/<slug>/` otherwise) every `HD_PARTIAL_CHECKPOINT_SECS` (300) seconds, on SIGINT/SIGTERM and on a scan error, and deletes it when the chain finishes. The next run resumes at `lastBlock + 1` if the partial was built on the same token, start block and base checkpoint. `refresh-tel-holders.yml` restores it from the Actions cache before the holders steps and saves it with `if: always()` after them, for every project. It is not committed, because:

- the file is scratch for the next run only, and can be several MB (the full raw balance map);
- a failed holders step never reaches the commit steps;
- keeping it out of git means feeds, `check:feeds` and the committed paths stay exactly as before.

**Waivers:**

- *TEL v3 scan* (`v3Scan.js`): it is sparse and resumes from the final checkpoint's `v3` section.
- *Wallet-flows*: these are windowed per-wallet scans, re-run in full each night.
- *Ledger*: it already keeps a per-chain cursor (`ledger-checkpoint.json`) and a chain that fails keeps its previous cursor.
- *Solana holders*: these are a token-account snapshot, not a block-range scan, so there is nothing to resume.
`refresh-holders.yml` gives each project `pipeline.workflowTimeoutMinutes` (ONDO: 60). Main has no partial holders checkpoint for ONDO (`public/data/ondo/` is absent, and there is no committed `holders-checkpoint.json` for it). The first holders scan is a full history, not an incremental catch-up, and is likely to hit the job timeout before it can write a checkpoint the next night can resume from.

Solana calls go through `rpc.js` `rpcCall` (`scripts/lib/solana/rpc.js`), so the public `api.mainnet-beta.solana.com` endpoint gets the same host limiter (3.5 rps, 4 concurrent, as published). Solana never uses Alchemy.

### Staker step stays on keys

`pull-staker-balances.js` is about **618 CU/day** (33 Alchemy calls, 1–4 Nov, `data/rpc-usage.json`). A full public scan of Polygon took more than 20 minutes, which is the step's `timeout-minutes`. The workflow therefore does not set `RPC_PREFER_PUBLIC` on that step. The guard caps it at 1,000 CU (`enforce`) and would fall through to public if the cap were hit. Moving this step to public RPC needs a faster scan or a longer timeout, not just the flag.

### `RPC_PREFER_PUBLIC=1` and `rpc` tests

Three cases in the `rpc` tests fail only when `RPC_PREFER_PUBLIC=1` is set. They pass with the variable unset, which is how CI runs `npm test`. One case asserts the keyless default (keys first, public as fallback). Set the variable only on the log-scanner workflow steps that already do (`pull-holders-rpc`, `scan-exchange-flows`, `generate-tier-outflows` in `refresh-holders.yml`). Do not export it for the whole test run.
