---
name: onboard-project
description: Runbook to onboard a new token (EVM, Solana) into Holder Distribution from its contract address or mint. One answers file holds all judgement; one scaffold command, one workflow dispatch and one local check do the rest. Use when the owner gives a contract address or mint and wants it on the site.
---

# Onboard a token

Input: a contract address or mint. Output: a `/<slug>` page where `npm run onboard:check -- --project <slug>` passes, plus a real visual check.

## The flow
1. `npm run onboard -- --address <addr>` runs discovery and writes an answers template to `tasks/onboard-<slug>.answers.json`. It writes nothing tracked.
2. Fill the answers file (every `FILL_ME`). Check it with `npm run onboard -- --address <addr> --answers <file>` (dry run, prints the validation errors).
3. `npm run onboard -- --address <addr> --answers <file> --write`. Show the diff. The owner merges the PR (README updated in it).
4. `gh workflow run onboard-project.yml -f project=<slug>`. After every stop, fix it and dispatch again; it resumes where it stopped.
5. `npm run onboard:check -- --project <slug>`, then the visual check, then the report.

The answers file is the ONLY place judgement goes. Never hand-edit `config/projects/<slug>.json`, the ledger, exclusions, CEX list or wallet registry for anything the answers file covers: edit the answers, re-run step 3 (it merges, no `--force`). Every stop prints a `Fix:` block. Follow it literally. Example of a complete file: `config/onboarding.answers.example.json` (fictional addresses).

## Rules that hold in every step
- No branch, commit or push unless the owner says so. Edit locally, show the diff, stop. When told to commit: author and committer `fabcrowd` + the GitHub noreply email through env vars, no Claude trailer, one PR that also updates `README.md` (project list, layout map, "Recent work").
- Only verified addresses. Never guess a wallet, label or confidence. Every decision gets evidence (a URL or one sentence).
- Never use `--force` (needs `ONBOARD_FORCE=<slug>`; it rewrites every scaffold file).
- Never print RPC URLs, keys or secrets. Name env vars only.
- No `npm run dev` or `npm run build` (they rewrite `public/sitemap.xml`). Use `npx vite --port <n>` and `VITE_LIVE_DATA=off npx vite build --outDir <scratch>`.
- Never hand-edit `public/data/`. Regenerate by script or workflow.
- No `pipeline.feedsPending`, `placeholder` flag, `breaksSeries` event or skip to hide a gap. Fix the cause.
- Dispatch only after the code is on `main` (a dispatch runs `main`). TEL stays byte-identical apart from `generatedAt`.
- Branch on `chains[].vm`, never on a slug.

## Step 1. Discovery (no questions)
**Do:** `git status` and say what is already modified. Run `npm run onboard -- --address <addr>`. Add `--chain <origin>` if it cannot find the chain. Unsupported address shapes stop with a message (`0.0.N` is a Hedera token, not supported; HBAR itself is `npm run onboard -- --chain hedera`).
**Pass:** it prints slug, name, ticker, decimals, `supply.target`, deploy block, CoinGecko id, chains, and says `Wrote the answers template`. Decimals and supply are on-chain reads, so they are the project's own facts, but they have one source. Cross-check both against one independent source: Solana Solscan, SolanaFM or explorer.solana.com; EVM the chain's Etherscan-family explorer; CoinGecko for supply. If an explorer blocks fetches, use the next one on the list. If none is reachable, write "decimals/supply unverified (on-chain read only)" in the report and go on; do not stop.
**Stop if:** decimals or supply cannot be read. If public nodes fail (SSL or 429), set `PUBLIC_RPC_URLS_<CHAIN>=<url>` and rerun. Copies on other chains are listed in `$includeCandidates`.

## Owner questions (one pass, before Step 2)
One AskUserQuestion call, max 4 questions, recommended default first, only for what discovery could not settle: slug, name or ticker if ambiguous; which chains go in `include`; every `low` confidence row (see wallets below). Everything else is an assumption in the report. Ask once, before `--write`. If nobody can answer, leave `low` rows out of the answers file and list them in your final report. Any that hold more than 1% of supply come back through the `large-holders` step.

## Step 2. Fill the answers file
Work through the sections below. Delete the `FILL_ME` example row in `wallets`. Fields starting with `$` are ignored. Evidence means a URL or a sentence naming what you searched.

**historyStart:** `"YYYY-MM-DD"` or `"forward-only"` (no backfill). EVM: the answers template already holds the deploy date if discovery found one (discovery prints only a deploy block). If the template holds `FILL_ME`, read the contract-creation transaction date on the chain's explorer and write it. Solana and every other non-EVM chain: if the template holds `FILL_ME`, write `"forward-only"`. Use a date on a non-EVM chain only if the owner asks for a backfill. A backfill runs `rebuild-holders-history-solana.yml`: it replays every transaction from the token's first one (the date only trims the published rows), up to 330 minutes per run, resuming over several dispatches, so a busy token needs many runs. A chain deployed after the date cannot have rows that early: use the latest deploy date.

**staking:** open the project docs or app and search for "stake", "staking", "vault", "lockup", "vote-escrow". Then open the token's top holders on the explorer and look for a contract holding a large balance. Three decisions:
- `"contracts"`: you found the mechanism and verified its address. List each (`kind` `stakeChanged` needs the integer `deployBlock` from the explorer's creation tx; `zebecStakeV1` is Solana only; `custody-only` is a vault with no staker adapter).
- `"none"`: only after three checks all show no staking: (1) the project's own site and docs, (2) the token's top 20 holders on the explorer (no contract labelled stake, lock, vault, escrow or reward), (3) the token's CoinGecko page. Evidence names all three checks. The site then states the token has no staking, and a nightly waiver quotes your evidence.
- `"unresolved"`: any check shows staking but you cannot find the contract address. Set it, put what you found in `evidence`, and STOP. `--write` refuses it until the owner gives the address or a source. Ask the owner. Once the owner answers, use `"contracts"` (kind `custody-only` if no adapter exists for that mechanism).

**wallets (at least one is required):** sources in order: the project docs or tokenomics page, a published wallet-disclosure post, the explorer's labelled top holders. A wallet needs `source` and `confidence`:
- `high`: the project's own site, docs or official post, or a verified explorer label, names the address.
- `medium`: a third party names it (explorer community tag, analytics site, CoinGecko).
- `low`: inferred from behavior only (funding pattern, similar name). Ask the owner about every `low` row (see Owner questions).
Never use an address that was truncated, abbreviated or reconstructed: copy the full address from the source and compare it character by character. A burn or dead address is not a wallet row. Class by name: a wallet called community, ecosystem, foundation or DAO treasury (a project-controlled allocation) is `treasury`; team, contributors or investors vesting is `team`; an operating company's reserve is `holdings`. A contract that the docs or explorer call rewards, emissions or incentives is `reward-vault`; no owner question is needed. Pick one class per address:

| class | meaning | subtracted from circulating | shows on the site |
|---|---|---|---|
| `treasury` | project treasury or foundation | yes | Supply: "Treasury & association wallets" |
| `association` | association or company wallet, also labelled non-retail in exclusions | yes | same slice |
| `team` | team, vesting, allocation wallets | yes | Supply: "Team & holdings wallets" |
| `holdings` | other project holdings | yes | same slice |
| `escrow` | escrow, migration, lock contracts | no | Supply: "Escrow"; forensics registry only (not in the ledger) |
| `reward-vault` | staking reward vault | no | Supply: "Reward vaults"; ledger group "Reward vault" |

Validation errors: an address in both `wallets` and `cex.wallets` on one chain; a list field given as null or a non-list.

Standing owner rules. A project-controlled wallet is always `treasury`, `association`, `team` or `holdings`, never retail; pick by the name rule above and do not ask the owner which (owner, 2026-11-07). The site shows them as the two rows in the table. Treasury wallets are subtracted from circulating supply on every token; team and holdings wallets on every token except TEL (owner, 2026-11-12); escrow and reward vaults are not subtracted. TEL alone keeps Telcoin Holdings as circulating.

**dex:** open `https://dexscreener.com/<chain>/<token address>` and list the pools; cross-check the CoinGecko markets tab. If DexScreener blocks fetches, use GeckoTerminal (`https://www.geckoterminal.com/<network>/tokens/<token address>`). `decision "pools"` with each pool and its page as `source`; `"none"` only if no pool exists, with evidence of where you looked.
- EVM: the pool contract address.
- Solana: the address that appears as the OWNER of the pool's token account in the token's holder list (Solscan: token page, Holders tab, "Owner" column). Not the pool/AMM state address and not the token account itself ("Account" column). Why: the flow scan calls `getTokenAccountsByOwner(<listed address>, {mint})` and matches transfers by token-balance owner (`scripts/lib/solana/flowScan.js`, `flowConfig.js`), so only an owner address finds the pool's flows. A listed token account is also marked non-retail (its owner is resolved from `tokenAccountOwnersByChain`, `roleAccountOwner` in `scripts/lib/projects.js`), but it yields no flows.
- How many: the top 5 pools by liquidity on the DEX listing, plus any pool address that appears in the token's top 100 holders.

**cex:** EVM-only token: `decision "spellbook"` (the free Dune spellbook sync fills the list). Mixed EVM + Solana token: `"spellbook"` is refused and the `cex-review` step does not run; `"list"` is the only option. Any non-EVM chain, in two passes:
- First pass (this file): `"list"` with each exchange wallet you can verify (`exchange`, `source`, `confidence`; Solscan or Arkham label, or an exchange proof of reserves). On Solana choose `"none-known"` only when the token's CoinGecko markets list shows no centralized exchange; write what you checked as evidence.
- Second pass (after the first snapshot): for Solana the runner builds a candidate list itself (the Dune spellbook's labelled exchange wallets that hold the token) and stops at `cex-review` until every candidate is under `cex.wallets` (accepted) or `cex.rejected` (`{chain, address, note}`). `none-known` is done only when that list is empty or fully rejected. Hedera has no spellbook list, so it keeps its adapter-seeded list.

**largeHolders:** may be empty now. The runner stops after the first snapshot only for a wallet above 1% of supply that has no usable `largeHolders` row. For each one, check the explorer label, then the wallet's first inbound transfer of the token:
- Labelled exchange, contract or project wallet: `"labelled"`, and add it to `cex.wallets` or `wallets` with that class. (A `"labelled"` row is valid only if the wallet is also under wallets, dex.pools, cex.wallets or staking.contracts.)
- First funded by a wallet already in your answers: same class as that wallet.
- Otherwise `"retail"`, and the note says what you checked.
- Traced, but the identity cannot be established and it is not an exchange/treasury/team wallet: `"unknown"`. It counts as a holder exactly like `"retail"` (the runner raises `megaHolderThreshold` the same way); use it when you cannot vouch it is an ordinary holder.
Wallets already labelled non-retail never reach the review.

**include:** a chain key only for addresses that the project's docs, or the CoinGecko contracts list for the same coin, give for this token (`$includeCandidates`). Otherwise leave it out and say so.

**Disagreeing sources:** if sources disagree on decimals or supply, the on-chain value from discovery wins. Record the disagreement in the evidence text.

## Step 3. Scaffold
**Do:** `npm run onboard -- --address <addr> --answers <file>` (dry run, must say `Answers are valid`), then the same with `--write`. It writes the registry entry (`onboarding: true`), `config/projects/<slug>.json`, ledger, exclusions, CEX file, wallet registry, chains inventory, `config/projects/<slug>/onboarding.answers.json` (the record the runner reads), and the token image under `public/tokens/`. `--wallet` and `--history-start` cannot be combined with `--answers`.
`--write` refuses staking `"unresolved"` (see staking above) and stops before writing anything. With `--root <dir>` the printed paths and the "Next" commands carry it.
**Pass:** no validation error; `git status` shows the new files. The scaffold prints the next steps: run `npx vitest run scripts/lib` and `npm run typecheck`, show the diff, the owner merges one PR that updates `README.md`, then `gh workflow run onboard-project.yml -f project=<slug>`, then `npm run onboard:check -- --project <slug>`. It also prints what is still manual: verify every address, add the token image if discovery found none, an optional `botCluster` in `config/projects/<slug>/ledger.json`, and a `nightly.waivers.<jobId>` reason or the missing capability for any nightly job it lists as "n/a". The runner does everything else (Developer wallets tab, go-live, clearing `onboarding`).
Re-applying a changed answers file prints `reclassified <addr>: <old> -> <new>`, `removed <file>: <addr>` and `WARNING kept hand-written <file>: <addr>`. A hand-written row is never overwritten: fix the answers or the hand-written row.
**Stop if:** validation lists errors (each names the field and allowed values). Fix the answers, rerun.
Then show the diff and stop for the owner to merge.

## Step 4. Dispatch
**Do:** `gh workflow run onboard-project.yml -f project=<slug>`. Watch with `gh run list --workflow onboard-project.yml --limit 3`. `npm run onboard:run -- --project <slug> --dry-run` prints the checklist and next step from `origin/main` (uncommitted local config is invisible to it). Add `--local` (dry run only) to evaluate the same plan on the working tree instead: `npm run onboard:run -- --project <slug> --dry-run --local`. `npm run onboard:check` runs the gates on local state.
**Pass:** the run ends with `<slug> is onboarded`. The runner removes `onboarding: true` once `check-go-live` passes.

## What the runner does (in order)
answers check (schema plus config on main still matches the answers) -> CEX list (EVM: `sync-cex-wallets.yml`) -> snapshot (`refresh-holders.yml`) -> CEX candidate review (Solana only) -> large-holder review -> derive tiers and sizing (committed) -> `mega-threshold` (raises `holders.megaHolderThreshold` above wallets you marked retail; committed) -> snapshot on those tiers -> history (`rebuild-holders-history.yml` per EVM chain, Solana `rebuild-holders-history-solana.yml`; skipped for `forward-only`) -> exchange flows -> treasury/CEX history (EVM) -> tier outflows -> staker balances (runs only if the answers list a `stakeChanged` contract; `zebecStakeV1` and `custody-only` do not trigger it) -> wallet flows -> ledger -> Developer wallets tab (committed) -> strict alignment -> go-live -> `list-on-site` (clears `onboarding`; committed). Each step is read from files on `main`, so a rerun resumes. Exit codes: 0 done, 1 workflow failed, 2 blocked on a person, 3 a config edit awaits review. `refresh-wallet-flows.yml` may end "partial" (the scan is still catching up and no report is written yet). The runner dispatches it again, up to 6 runs per step. A partial run that leaves an existing stale report fails with "re-dispatch this workflow".

## When it stops
Every stop ends with `Fix:`. Do what it says, merge to `main`, dispatch again.

| Stop | Meaning | Fix it prints (summary) |
|---|---|---|
| `answers` | answers invalid, or main's config no longer matches them | correct the named fields, rerun step 3, merge, dispatch |
| `cex-wallets` blocked (non-EVM) | no verified source syncs CEX wallets for that VM | set `cex` to `list` (verified wallets) or `none-known` (with evidence), rerun step 3 |
| `cex-review` (Solana) | labelled exchange wallets hold the token and are in neither `cex.wallets` nor `cex.rejected` | open each link; accepted ones go to `cex.wallets` with `decision "list"`, the rest to `cex.rejected` with a note; rerun step 3. If the list could not be fetched, rerun, or run `node scripts/sync-cex-wallets-dune.js --project <slug> --source spellbook --candidates` locally |
| `large-holders` | wallets above 1% of supply have no `largeHolders` row | open each explorer link, decide by the `largeHolders` rule in step 2, add a row (`labelled` also needs the wallet under wallets, dex, cex or staking), rerun step 3 |
| `mega-threshold` | wallets marked retail sit above `holders.megaHolderThreshold` (they would be dropped from counts) | the runner raises the threshold itself (exit 3 without `--commit`: review and merge). It stops only when it cannot raise it; follow the printed `Fix:` |
| tiers blocked | one derived tier holds over 90% of wallets, or `supply.target` is unset | set `holders` fields in `config/projects/<slug>.json` as printed |
| `history` blocked | `historyStart` missing or differs from config | set it in the answers, rerun step 3 |
| `history` or `treasury-cex-history` stuck | a chain deployed after `historyStart` | set a later date or `forward-only` in the answers |
| `wallet-flows` blocked | forensics registry has no wallets | add a wallet to the answers, rerun step 3 |
| `alignment` stuck | feeds do not share `asOf` and day cutoffs | `node scripts/build-cutoffs.js --project <slug> --from <first holders date>`, commit `date-blocks.json`, merge, dispatch |
| `go-live` | `check-go-live` problems | each problem has a `fix:` hint with file and field; a problem without one is a stale report: dispatch the named refresh workflow |
| workflow failed (exit 1) | a dispatched workflow ended not-success | `gh run view <id> --log-failed`, fix the named file, merge, dispatch |
| not built for vm | a step has no workflow for that VM (`STEP_VMS` in `scripts/lib/onboardRun.js`; for hedera a dated `historyStart` would need `history` and `treasury-cex-history`, which hedera lacks) | set `historyStart` to `forward-only` (HBAR's recorded decision) |
| still not done after 6 runs | a scan keeps not finishing | read the printed log commands; fix; dispatch |
| exit 3 | the runner edited config (tiers, tab) without `--commit` | review, commit, merge, dispatch |

## Hedera (HBAR, the native coin)
HBAR is registered as onboarding (2026-11-13). Its path is built and tested locally; nothing is proven on GitHub until `onboard-project.yml` has run for it. It has no contract, so it has no answers file and no owner question pass.
1. `npm run onboard -- --chain hedera` (dry run), then the same with `--write`. `0.0.N` addresses are Hedera tokens and are refused. The scaffold reads supply and decimals from the mirror node and writes the registry entry (`onboarding: true`), the project config, ledger config, exclusions (network treasury accounts, 0.0.98, 0.0.800, 0.0.801), WHBAR as role `dex`, the CEX list (24 seeded accounts, `scripts/lib/hedera/cexAccounts.js`; research in `docs/hedera-cex-candidates.md`), the forensics registry, `treasury.categories ["treasury"]`, a 180-minute job limit and the image. Owner decisions (`historyStart` forward-only, `largeHolders` rows) live in `scripts/lib/hedera/nativeDecisions.js`, not in the config.
2. Show the diff; the owner merges; `gh workflow run onboard-project.yml -f project=<slug>`.
3. Runner steps that apply: snapshot, large-holders, tiers and sizing, mega-threshold, snapshot on those tiers, exchange flows, tier outflows, wallet flows, ledger, Developer wallets tab, strict alignment, go-live, list-on-site. They do not apply: CEX sync (list comes from the scaffold), CEX candidate review (Solana only), history and treasury/CEX history (forward-only), staker balances.
4. A `large-holders` stop for HBAR says to add a row to `HEDERA_LARGE_HOLDERS` in `scripts/lib/hedera/nativeDecisions.js` (a code edit, then merge).

## Sizing is derived, never copied
Tiers, balance ranges, `retailThreshold` (lower bound of the second-lowest tier) and `concentrationBuckets` come from the token's own first snapshot, retail wallets only (`scripts/lib/deriveHolderTiers.js`, run by the runner; `node scripts/derive-holder-tiers.js --project <slug>` prints them). `megaHolderThreshold`: the scaffold writes supply.target / 5 (and a `retailThreshold` at half of it if that is not above the default 1,000). The runner derives `max(supply.target / 5, 1.2 x the largest wallet acknowledged as retail, rounded up to 1 / 2.5 / 5 x 10^k, capped at supply.target)`, never lowers it, and later raises only that field. Never set it by hand: the next step overwrites it. Answers write `treasury.categories` as `treasury` only, and only when a treasury or association wallet exists (a bucket that can empty aborts the daily treasury history). Wallet-flow seller and swap thresholds and the CEX-candidate floor scale with supply (`scripts/lib/projectSizing.js`; 0.005%, 0.001%, 0.0001% of `supply.target`); a `sizing` block in the config overrides them (ONDO is pinned to the old values). Never copy another project's values. The runner treats `holders.defaultTiers` as already sized, but go-live requires explicit `megaHolderThreshold` and `retailThreshold` for own `distributionTiers`. Go-live also fails when one tier holds over 90% of wallets.

## Step 5. Gates, visual check, report
### 5a. Gates
`npm run onboard:check -- --project <slug>` runs, one after another, vitest, typecheck, lint, `check-feed-consistency --all --strict`, `pipeline-health` and `check-go-live --alignment strict`. It prints PASS/FAIL per gate with a log path under `tasks/`. `--skip-tests` drops the first three. All must pass; none may be skipped or allowlisted. After the same failure twice, change approach.

### 5b. Visual check (mandatory; gates do not catch UI problems)
Start `npx vite --port <n>`; drive `/<slug>` with headless Playwright (system Chrome via `executablePath`) at 1440x900 and 390x844 (measure `scrollWidth`). Check against the feed files: landing tile, header, chain picker; Supply tiles sum to supply; tier counts, no all-wallets-in-one-tier; holders history range; Exchange Net Flow changes across 1D, 7D, 30D, 90D, YTD; tier flow has no NaN or blank cells; Staked panel or the no-staking note; explorer links (case-exact base58); no "Staked <ticker>" text for a token without staking; gated wallet-flows panel has no empty cards and onward totals never exceed received.
**Pass:** every number on the page equals the feed value at the displayed precision (rounding only); anything else is a failure to report, not to fix by hand. Include a screenshot path per page and width.
**Stop if:** you did not render the page. Say so. Never report a visual check you did not do.

### 5c. Sign-off and report
Spawn the `verifier` agent with the 5a and 5b results; it is read-only. Fix what it proves, rerun 5a. Then one report: what was automatic, what was manual, assumptions, open items, files changed. Update in the same change: `README.md`, `docs/MULTI-TOKEN.md` if a step changed, `tasks/lessons.md` for any mistake caught, this file. Deploys are manual (Netlify dashboard); config reaches the browser at the next deploy, data through `live-data.mjs`.

## Known traps
- Replay vs snapshot holder definition (18-decimal dust): the rebuild passes `dropRoundedDust`; confirm decimals before a rebuild.
- Never label a snapshot row with the run time. Row D is the state at the end of D.
- Solana flow feeds stamp from slot cutoffs: an incomplete scan stamps `date: null, settled: false`. Solana holder snapshots are live reads (`live: ["<chain>"]`); alignment allows 1 day.
- A rebuild that wrote `T00:00` rows: `node scripts/relabel-midnight-history.js --project <slug>` (dry run), then `--apply`.
- A feed's last row used as "now" hides a stale feed: gate on `stale-tail`.
- `breaksSeries` daggers every Distribution Change cell: never use it to explain a bug.
- A helper-run rebuild crossing UTC midnight writes a row that disagrees with the snapshot: regenerate through the workflow.
- CI after data commits on `main`: `gh pr update-branch <n>`; a plain rerun reuses the old merge commit.
- A helper's finding is a claim: reproduce it in code or browser before acting.
- Tests that copy numbers from a feed go red within hours: assert shape.
- Not built yet: one address-array scan per chain across EVM projects, EVM sales tracing, a Solana CEX detector, a per-project budget block, a mixed EVM+Solana forensics merge (both generators write one report path), and for Hedera: DEX/WHBAR look-through, swap decoding, onward-hop tracing of unlabelled recipients, history before the first snapshot, tracing of 0.0.54 and the protocol accounts.

## Unproven
`onboard-project.yml` has never carried a real new token end to end. EVM discovery over real RPC is unit-tested only on this machine (its network blocks most public Ethereum RPC hosts).
