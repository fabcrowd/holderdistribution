---
name: onboard-project
description: Runbook for an LLM to onboard a new token (EVM, Solana, or mixed) into Holder Distribution in one pass from its contract address or mint. Ordered steps, each with exact commands, a pass check and a stop condition. Use when the owner gives a contract address/mint and wants it on the site.
---

# Onboard a token: one-shot runbook

Input: a contract address or mint. Output: a live `/<slug>` page whose `node scripts/check-go-live.js --project <slug>` passes, with data gates green and a visual check done.

How to run this: execute the steps in order. Every step has **Do**, **Pass** and **Stop if**. Do not skip a Pass check, do not move on until it holds, and do not ask the owner anything that discovery can answer. Ask only in Step 3, once, with a recommended default on every question.

Reference: `docs/MULTI-TOKEN.md` ("Adding the next project"), `docs/FORENSICS.md`, `docs/LEDGER.md`, `scripts/add-project.js` (header lists every flag).

## Rules that hold in every step
- Never branch, commit or push unless the owner says so. Edit locally, show the diff, stop. When told to commit: identity `fabcrowd` via env vars on the command, no Claude trailer, one PR, and the PR must update `README.md` ("Recent work" with PR numbers, project list, layout map).
- Only verified addresses. Never guess a wallet, label or confidence.
- Branch on `chains[].vm` (`evm` | `solana`), never on a slug. No slug in workflow YAML.
- No workarounds before live: never use `pipeline.feedsPending`, a `placeholder` flag, a `breaksSeries` event or a skip to hide a data gap. Fix the cause.
- Never print RPC URLs, keys or secrets. Name env vars only.
- Do not run `npm run dev` / `npm run build` (they rewrite `public/sitemap.xml`). Use `npx vite --port <n>` and `npx vite build --outDir <scratch>` with `VITE_LIVE_DATA=off`.
- TEL must stay byte-identical apart from `generatedAt`, and must never import `scripts/lib/solana/*`.
- Generated files in `public/data/` are never hand-edited. Regenerate by script or workflow.
- Dispatch a workflow only after its code is on the branch it runs from (a dispatch on `main` runs `main`).
- Free public RPC first; paid keys allowed for log scans. Check `config/budgets.json` before a big scan.

## Step 1 - Pre-flight (no questions)
**Do:** `git status` (say what is already modified), confirm `npm ci` is done and env decrypt works (names only). Infer the VM: `0x` + 40 hex = EVM; base58 of 32-44 chars = Solana mint; anything else = unsupported VM, stop.
**Pass:** clean or understood tree, VM known.
**Stop if:** unsupported VM.

## Step 2 - Discovery (read-only; keep results in the scratchpad)
**Do:**
1. On-chain facts: decimals, symbol, name, total supply. Solana: `node scripts/solana-smoke.js --mint <mint>`. EVM: `eth_call` `symbol()`, `decimals()`, `totalSupply()`.
2. Other chains and bridged copies: `node scripts/detect-token-chains.js --address <addr> --chain <origin> --ticker <T> --coingecko`. Write the result as `chains-inventory.json` (schema in `scripts/lib/chainInventory.js`): every deployed chain is `configured`; every other chain listed is `excluded` or `not-found` with a reason.
3. CoinGecko id and image; legacy/v2 pairs; wrapped or impostor tokens to exclude.
4. Staking: search the token's docs and explorer for a staking, lock or vesting contract. Discovery decides staking per token. An empty `staking[]` is a valid finding (the UI then shows a "no staking" note).
5. Treasury, team, foundation, escrow and reward-vault wallets from project docs and explorer labels. Record source and confidence for each.
6. The top 25 holders by balance. For every wallet above 1% of supply, trace it (labels, funding source, contract vs EOA). Tag it only when the trace supports it; otherwise record the trace in `docs/<slug>-wallet-candidates.md`. Never leave a large holder untagged without a recorded trace.
7. Volume estimate for the cost gate: one-day `eth_getLogs` count (EVM) or signature rate on venue accounts (Solana).
**Pass:** a table of every derived value with source and confidence.
**Stop if:** decimals or supply cannot be verified on-chain.

## Step 3 - Owner questions (one pass, 4 questions per call max)
Use AskUserQuestion. Recommended default first, marked "(Recommended)". Skip anything discovery answered with high confidence and list it as "assumed". Then print one summary of every answer and assumption and continue without asking again.

| # | Question | Default |
|---|---|---|
| 1 | Slug (`[a-z0-9-]`), display name, ticker | derived |
| 2 | Chains and origin chain | only chains verified on-chain |
| 3 | Bridge type per extra chain (`native` / `lock-mint` / `burn-mint`) | none; if unknown, exclude the chain |
| 4 | Tokens to exclude | all found impostors/legacy |
| 5 | `supply.target` | verified total supply |
| 6 | Treasury/team/escrow/reward-vault wallets and categories | those found in Step 2.5 (reward vaults go in Team) |
| 7 | Staking contracts and kind (`stakeChanged`, `zebecStakeV1`, other = new adapter) | what discovery found; none if none |
| 8 | Holder tiers | scaled from supply, see Step 5 |
| 9 | Developer wallets for the ledger | the Team wallets from Q6 |
| 10 | Cost gate: expected nightly CU/credits vs remaining budget | stop and ask if it would breach |

## Step 4 - Scaffold
**Do:**
```
node scripts/add-project.js --slug <slug> --name "<Name>" --ticker <T> \
  --chain <chain>:<address>:<decimals>[:chainId[:deployBlock]] [--chain ...] \
  [--wallet <address>:<label>[:treasury|holdings|association]] ... \
  --inventory chains-inventory.json --coingecko <id> [--stable <chain>:<addr>:<SYM>:<dec>]
```
Run with `--dry-run` first and read the output. It writes the registry entry (never `default: true`), `config/projects/<slug>.json`, `config/projects/<slug>/ledger.json`, the empty wallet registry and the validated inventory.
Then: cache the CoinGecko image to `public/tokens/<slug>.<ext>` (read `image.large`, drop the `?` query, keep the format) and set `"image"` in the config. Add `copy` overrides only where the generic wording is wrong for this token.
**Pass:** the script's own validation passes; `config/projects/<slug>.json` has every chain, `supply.target`, `staking[]` (possibly empty) and `classification.*`.

## Step 5 - Config that the scaffold does not decide
**Do, in `config/projects/<slug>.json`:**
1. **Holder tiers (mandatory).** A project with no `holders` block inherits TEL's tiers (sized for 100B). ONDO (10B) put 99.8% of its wallets in one tier that way. Add a `holders` block with `distributionTiers` = TEL's tiers (`config/holder-tiers.default.json`) scaled by `supply.target / 100B`, rounded to clean numbers, plus `megaHolderThreshold` at about 20% of supply and a `$comment` that explains the sizing. After the first snapshot, check that no single tier holds more than about 90% of wallets.
2. **RPC.** `chains[].rpc.envPrefix` is the prefix BEFORE `_RPC_<n>` (Solana = `"SOLANA"`, never `"SOLANA_RPC"`; the loader rejects a prefix ending in `_RPC`). Solana needs a keyed pool (`SOLANA_RPC_0`, `SOLANA_RPC_1`) because public RPC refuses `getProgramAccounts`; ask the owner for keys only if the env vars are missing.
3. **Classification:** exclusions, treasury/team/vault addresses from Q6, DEX contracts (`role: "dex"` or `classification.dexContracts`; list every pool the team trades on before any wallet-flow run).
4. **Forensics:** set `gated.forensics: true` and `gated.walletFlows { coingeckoId, chains }`.
5. **Lock the owner's answers in a test:** `scripts/lib/<slug>Config.test.js`, modeled on `registryTiers.test.js` and `zebecNetworkConfig.test.js` (supply target, exclusions, vault classification, tier sanity). Assert config values only, never live feed numbers.
**Pass:** `npx vitest run scripts/lib` and `npm run typecheck` pass.

## Step 6 - First data, in this order
Each command below is a workflow dispatch with `-f project=<slug>` (`gh workflow run <file>.yml -f project=<slug>`), or the script with `--project <slug>` for a local run when an RPC key is available. Wait for each to finish and read its log before the next.

1. **CEX wallets.** `node scripts/sync-cex-wallets-dune.js --project <slug> --source spellbook` (free). EVM adds net-new addresses when `classification.cexWallets` exists; Solana writes review candidates only. Review the candidates; never auto-promote. CEX wallets are required before go-live.
2. **Snapshot.** `refresh-holders.yml` (or `node scripts/pull-holders-rpc.js --project <slug>`). On Solana check the pool log line `RPC pool <chain>: N/M usable; K ..._RPC_n set, J distinct` shows K and J above 0.
   **Pass:** `public/data/<slug>/holders.json` exists; supply gap within `SNAPSHOT_SUPPLY_TOLERANCE` (1%); no vault/treasury address in retail; no tier above about 90% of wallets.
3. **History.** EVM: `rebuild-holders-history.yml` (`start` = first date wanted; one chain at a time if it will not finish in 6h; roughly 20 minutes per chain-year for a busy token). Solana: `rebuild-holders-history-solana.yml`. The rebuild must use the same holder definition as the snapshot (`dropRoundedDust: true` is already passed; confirm decimals, because at 18 decimals dust admits phantom holders).
   **Pass:** `check-feed-consistency` shows no holder-count WARN at the first snapshot row.
4. **Exchange flows.** `scan-exchange-flows.yml`. If it stops at `max_blocks_per_run`, dispatch again until the feed's last row is within 3 days of today (the `stale-tail` gate in `pipeline-health.js` enforces this). Solana: `scan-solana-flows.js` runs oldest-first at `SOLANA_FLOW_MAX_TX` (15,000) per run and needs several runs; tell the owner the expected runs and Helius credits (about 1 credit per transaction).
5. **Treasury / CEX balance history.** `backfill-treasury-cex-history.yml` with `write=false` first (dry run), then `write=true` over the history range. Without it the replayed CEX balance is one constant for every date.
   **Pass:** the dry run reports no drift above 2% (`allow_drift` stays off).
6. **Tier outflows and transitions.** `generate-tier-outflows.yml` (repeat until `complete: true` and `latestDate` is yesterday). It resets itself when tiers change. `generate-holder-transitions.js` runs in the nightly; its windows are limited by the git archive depth, so ranges may be shallow at first.
7. **Staking** (only if Step 2.4 found one): the `staking[]` entry plus `refresh-staker-balances.yml`. Staked is a separate tile, never added to retail, and vault accounts are never retail. If none, confirm the UI shows the no-staking note and omits the Staked tile.
8. **Forensics.**
   - Solana: tag treasury/holdings wallets in `chains[].contracts` (`role`, `$comment` with confidence and a Solscan link), `node scripts/init-forensics-registry.js --project <slug>`, review labels, `node scripts/generate-wallet-flows-solana.js --project <slug> --dry-run` (check the credit estimate), then without `--dry-run`.
   - EVM: hand-write `data/<slug>/forensics/wallet-flows.registry.json` from `data/forensics/wallet-flows.registry.json` (`knownWallets` with `entityClass`, `confidence`, `source`, `chains`), then dispatch `refresh-wallet-flows.yml`.
   - Mixed EVM + Solana: both generators write one report path; flag this to the owner instead of letting the second run overwrite the first.
   **Pass:** the report covers 90 days on every chain (repeat the dispatch until coverage is not partial) and `validateWalletFlowsReport` passes.
9. **Developer ledger.** Confirm `developerWallets` in `config/projects/<slug>/ledger.json` (each must be in the forensics registry), dispatch `refresh-ledger.yml`, confirm `data/<slug>/ledger/ledger.json` and `bot-proceeds.json`, then set `capabilities.projectWallets: true`.
10. **Day cutoffs and asOf alignment** (right after the feeds above first exist). `node scripts/build-cutoffs.js --project <slug> --from <first holders date>` (fills `date-blocks.json` `cutoffs` for every chain), then run the first settled nightly (or `node scripts/fill-history-gaps.js --project <slug>`) so every feed is regenerated and stamped with `asOf`, then `npm run check:alignment -- --project <slug> --strict`.
    **Pass:** the alignment check prints ALIGNED (every feed stamped, settled end dates equal, live-chain dates within 1 day, blocks equal) and `date-blocks.json` has a `cutoffs` entry for every chain.
    **Stop if:** a feed stays unstamped or misaligned after a regeneration; fix its writer, never hand-edit the feed.
11. **Scheduling.** Nothing to edit: `node scripts/workflow-paths.js --project <slug>` and `node scripts/workflow-paths.js matrix all` must list the project. `refresh-holders.yml` loops every registry project. Any new non-fatal stage needs an `id` and an entry in the Stage verdict step (`stageVerdict.test.js` enforces it).

## Step 7 - Gates (all must pass)
```
npx vitest run
npm run typecheck
npm run lint
node scripts/check-feed-consistency.js --all --strict
node scripts/pipeline-health.js
node scripts/check-go-live.js --project <slug> --alignment strict
```
Also: no `placeholder` or `feedsPending` anywhere for the project; TEL feeds unchanged; no hardcoded feed numbers in tests (assert shape and invariants).
**Stop if:** any gate fails. Fix the cause and re-run the gate. After the same failure twice, change approach instead of patching the symptom.

## Step 8 - Visual check (mandatory; data gates do not catch UI problems)
**Do:** start `npx vite --port <n>` (dev reads `/data/...` directly). Drive `/<slug>` with headless Playwright using system Chrome via `executablePath`, at 1440x900 and 390x844 (measure `scrollWidth` for phone overflow).
Check each of these against the feed files:
- Landing tile, header, chain picker, Supply tiles sum to supply.
- Distribution: tier counts, Change column, no all-wallets-in-one-tier, no dagger unless a real reclassification.
- Holders history chart and its date range.
- Exchange Net Flow on every range (1D, 7D, 30D, 90D, YTD): the number must change with the range, and a stale feed shows "Data through <date>".
- Tier flow: no "NaN" or blank cells; rows use the project's tier labels.
- Staked panel or the no-staking note; explorer links (case-exact base58).
- Glossary and info tips: no "Staked <ticker>" text for a token without staking.
- Gated wallet-flows panel: no empty cards, addresses truncate, onward totals never exceed received.
**Pass:** every item matches its feed, with a screenshot path recorded for each page and width.
**Stop if:** you did not actually render the page. Say so; never report a visual check you did not do.

## Step 9 - Adversarial sign-off
Spawn the `verifier` agent with the task contract (the Step 7 and 8 passes). It is read-only and reports; do not edit from its output without re-checking. Fix what it proves, re-run Step 7.

## Step 10 - Report and keep the docs current
One message: what is automatic, what is manual, assumptions made, estimated vs actual cost, open items, files changed.
Then update, in the same change: `README.md` (project list, layout map, "Recent work" with PR numbers), `docs/MULTI-TOKEN.md` if a step or command changed, `tasks/lessons.md` for any mistake caught, and this file. Offer the commit only after the owner approves. Deploys are manual from the Netlify dashboard; config changes reach the browser only at the next deploy, data reaches it through `live-data.mjs`.

## Known traps (each one cost a session)
- Default tiers on a non-100B token (ONDO): see Step 5.1.
- Replay vs snapshot holder definition (18-decimal dust, -2.7% step): Step 6.3.
- Nightly `fill-history-gaps` replays a missed day from the project's own newest committed checkpoint (`pull-holders-rpc.js --as-of`; fixed in #151, it used to anchor on TEL's 2026-08-21 and failed for ONDO). Never put a fixed date, block or address default in a shared script: derive it per project. After onboarding, confirm one nightly's "Fill holders-history gaps" step is green for the new project.
- Never label a snapshot row with the run time. Row D means end of D: the state at `cutoff[D+1] - 1`.
- Solana flow feeds (`exchange-flow-history`, `tier-outflows`) stamp from slot cutoffs (`asOfFromSolanaScan`): a complete scan stamps a settled day; an incomplete scan stamps `date: null, settled: false, incomplete` and claims no day. Solana holder snapshots are live reads and stay `asOf.settled: false` with `live: ["<chain>"]` until slot pinning exists; the alignment check allows those 1 day.
- A rebuild that produced `T00:00` rows: run `node scripts/relabel-midnight-history.js --project <slug>` (dry run by default, prints what it would change), then add `--apply` to write.
- A feed's last row used as "now" makes a year-old feed look current: gate on `stale-tail`.
- `breaksSeries` daggers every Distribution Change cell: never use it to explain a bug.
- `envPrefix` ending in `_RPC` read the wrong env vars and ran public-only: Step 5.2.
- A helper-run rebuild that crosses UTC midnight writes a row that disagrees with the snapshot: regenerate through the workflow.
- CI after data commits on `main`: `gh pr update-branch <n>`; a plain rerun reuses the old merge commit.
- A helper's finding is a claim, not a fact: reproduce it in the browser or code before acting.
- Tests that copy numbers from a nightly feed go red within hours: assert shape.
- Not built yet: one address-array scan per chain across all EVM projects (needed with 2+ EVM projects), sales tracing on EVM, a Solana CEX detector, a per-project budget block, a mixed EVM+Solana forensics merge.
