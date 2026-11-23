---
name: onboard-project
description: Runbook to onboard a new token (EVM, Solana, HBAR) into Holder Distribution from a name, ticker, contract address or mint. One answers file holds all judgement; one scaffold command, one PR, one workflow dispatch and one local check do the rest. Use when the owner names a coin (name, ticker, address or mint) and wants it on the site.
---

# Onboard a token

Input: a name, ticker, contract address or mint. Output: a `/<slug>` page where `npm run onboard:check -- --project <slug>` passes, plus a real visual check.

## Start to finish (what the owner expects)
Owner, 2026-11-14: "the next time we onboard, it's a one shot where I just tell you the name or ticker and you know how to do it all." So: no questions about how; this file is the how, and naming the coin is the go-ahead for its PR, merge and dispatches (see "Rules that hold in every step"). Stop only for the one owner-question pass (if something is truly unsettled), staking `"unresolved"`, and anything outside the onboarding.

Order of work, with the commands that are not in the steps below:
1. **Resolve** the name or ticker to an address (Step 0).
2. **Preflight.** `git status` clean, on `main`, `git pull --ff-only`. `gh run list --limit 10`: nothing may be running or queued in the `holders-refresh` group (holders, ledger, watchdog, wallet flows, CEX sync all share it; GitHub keeps one running and ONE pending run per group, and a third arrival cancels the pending one). Check the clock: the nightly slot is 01:07 UTC and GitHub creates it hours late (it has landed 05:00 to 10:00 UTC). An onboarding run holds that group for its whole length, so start it only when it will finish before then, or after the nightly has landed. HBAR's two full balance scans take about 67 to 93 minutes each (measured locally).
3. **Steps 1 to 3** (discovery, answers, scaffold). Research goes to Sonnet helpers; every address is verified character by character.
4. **Local gates:** `npx vitest run`, `npm run typecheck`, `npm run lint`, `npm run check:feeds`, `npm run check:store-files -- --project <slug>`, `npm run check:data` (CI skips the last two once `check:feeds` fails, so they must be green here before the red merge). `check:feeds` must pass for every existing token and fail ONLY for the new slug with `ENOENT` on its feeds (it has none yet). Any other failure is real. If `src/lib/projects.test.ts` fails with a stale project list, see Known traps.
5. **PR.** Branch `feat/onboard-<slug>` from `main`. Update `README.md` in the same commit (project list, layout map, first bullet under "Recent work" with the PR number; the next number is the highest issue/PR number plus one: `gh api "repos/fabcrowd/holderdistribution/issues?state=all&per_page=1&sort=created&direction=desc" --jq '.[0].number'`; check it after `gh pr create`). Commit identity through env vars on the command (`GIT_AUTHOR_NAME=fabcrowd GIT_AUTHOR_EMAIL="226306925+fabcrowd@users.noreply.github.com"` and the same two `GIT_COMMITTER_*`), never `git config`, no Claude trailer, no Claude line in the PR body. The PR body says that `verify` is expected red at `npm run check:feeds`.
6. **Merge.** Wait for checks. This is the one merge with a red check that the "Scaffold PR exception" in `CLAUDE.md` allows, and only under its condition. `verify` is red; confirm with `gh run view <id> --log-failed` that the only failing step is `npm run check:feeds` and the only `FAIL` lines are the new slug's missing feeds (ONDO #130 and HBAR #184 merged this way). Then `gh pr merge <n> --squash --delete-branch`. If `main` moved (data commits land all day), merge `main` into the branch; a `README.md` conflict under "Recent work" is resolved by keeping both bullets, newest first.
7. **Step 4** (dispatch with `--ref main`) and watch it. Each stop prints `Fix:`; each fix is its own small PR through 4 to 6 above, then dispatch again. Only the scaffold PR may merge with a red check; a fix PR merges on green checks only.
8. **Store classification** (before go-live; the runner's first snapshot must exist, so do it while the runner is stopped or after "onboarded" and before the report): every file the coin writes must be stored or excluded by `scripts/lib/storeFiles.js`. Run `npm run check:store-files -- --project <slug>` (exit 1 and one `UNCLASSIFIED` line per offending file; hand-kept files go in the coin's `excludedFiles`, stray files are removed). It must pass before go-live.
9. **Step 5** (gates, visual check, verifier, report). Confirm `npm run check:feeds` is green on `main` again. Tell the owner the Netlify deploy is theirs: config and UI reach the browser only then.
10. **Write it down:** this file (anything that was different from what it says), `README.md`, `.claude/HANDOFF.md`, `tasks/lessons.md`.
11. **Day after:** the store check below.

Do not dispatch `refresh-holders.yml` by hand for a token whose nightly has already run that day: on 2026-11-14 a second run on the same day published `cex-flows.json` with no comparison (it has no previous snapshot). Check `gh run list --workflow refresh-holders.yml` first.

## Store inputs (state them in the report; no questions)
The nightly also writes the coin to the store (dual-write since 2026-11-21; `docs/STORE.md`). Git stays the data path. The store needs two inputs from onboarding: H (holders estimate from the first snapshot) and the list of files the coin writes. The store handles size itself: the ever-held list is split into buckets by H once the workflow passes `--table-specs` (not yet; today every file is stored whole), every other file is stored whole, and there are no per-coin cases (`docs/MULTI-TOKEN.md` "Store dual-write for a new coin"). Reserved slugs `store` and `site` are refused (`SLUG_RE`); never use them. During the first nights the store may report pack failures until table formats cover the coin's files; that never blocks the git data path and is not a reason to hold the onboarding.

## Step 0. From a name or ticker
1. Search CoinGecko: `https://api.coingecko.com/api/v3/search?query=<name or ticker>`. Take the coin whose name or symbol matches exactly; if several match, the one with the best `market_cap_rank`. Say which you picked and why. Ask the owner only if two different coins are equally plausible.
2. Read `https://api.coingecko.com/api/v3/coins/<id>?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`. `platforms` lists the contract address or mint per chain. Cross-check the address on the project's own site or docs before using it; an address from one source is not verified.
3. Pick the origin chain: the chain the token was first issued on (the project's docs say so; a bridged copy is a mirror). That address goes to Step 1. The other chains' addresses are `include` candidates (Step 2).
4. What can be onboarded: an EVM token (chains in `config/chains.json`), a Solana SPL or Token-2022 mint, and HBAR (`npm run onboard -- --chain hedera`, see "Hedera"). What cannot, yet: any other native coin (BTC, ETH, SOL itself), a Hedera token (`0.0.N`), a token on a VM with no adapter. Say so in one line and stop; building a new adapter is a separate job the owner decides.
5. Already in `config/projects.json`? Then it is a rerun: go to Step 4.

## The flow
1. `npm run onboard -- --address <addr>` runs discovery and writes an answers template to `tasks/onboard-<slug>.answers.json`. It writes nothing tracked.
2. Fill the answers file (every `FILL_ME`). Check it with `npm run onboard -- --address <addr> --answers <file>` (dry run, prints the validation errors).
3. `npm run onboard -- --address <addr> --answers <file> --write`. Open the PR (README updated in it) and merge it once the checks are as expected.
4. `gh workflow run onboard-project.yml -f project=<slug>`. After every stop, fix it and dispatch again; it resumes where it stopped.
5. `npm run onboard:check -- --project <slug>`, then the visual check, then the report.

The answers file is the ONLY place judgement goes. Never hand-edit `config/projects/<slug>.json`, the ledger, exclusions, CEX list or wallet registry for anything the answers file covers: edit the answers, re-run step 3 (it merges, no `--force`). Every stop prints a `Fix:` block. Follow it literally. Example of a complete file: `config/onboarding.answers.example.json` (fictional addresses).

## Rules that hold in every step
- When the owner names a coin to onboard, that request approves the scaffold PR, its merge, the workflow dispatches and the fix PRs the runner asks for. Anything outside the onboarding still needs a separate go-ahead.
- Every commit: author and committer `fabcrowd` + the GitHub noreply email through env vars, no Claude trailer, one PR that also updates `README.md` (project list, layout map, "Recent work").
- The holder balance must match what blockchain explorers show, for every token (owner, repo-wide, 2026-11-14). Never fix a size, speed or display problem by changing a wallet's balance. Every address with a positive balance is listed: no minimum-balance floor, and a contract is a holder unless a classification list says otherwise. A snapshot that is too large is fixed by its storage layout, never by fewer rows.
- Only verified addresses. Never guess a wallet, label or confidence. Every decision gets evidence (a URL or one sentence).
- Never use `--force` (needs `ONBOARD_FORCE=<slug>`; it rewrites every scaffold file).
- Never use the slugs `store` or `site` (reserved).
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
If nothing is unsettled, ask nothing. Otherwise one AskUserQuestion call, max 4 questions, recommended default first, only for what discovery could not settle: slug, name or ticker if ambiguous; which chains go in `include`; every `low` confidence row (see wallets below). Everything else is an assumption in the report. Ask once, before `--write`. If nobody can answer, leave `low` rows out of the answers file and list them in your final report. Any that hold more than 1% of supply come back through the `large-holders` step.

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
- Second pass (after the first snapshot): for Solana the runner builds a candidate list itself (the Dune spellbook's labelled exchange wallets that hold the token) and stops at `cex-review` until every candidate is under `cex.wallets` (accepted) or `cex.rejected` (`{chain, address, note}`). `none-known` is done only when that list is empty or fully rejected. Hedera has no spellbook list, so it keeps its adapter-seeded list (owner-maintained; see `docs/hedera-cex-candidates.md`). A VM with no spellbook model is skipped by the sync with a notice; wiring a new chain/VM is one record (`url` + `minRows`) in `SPELLBOOK_CEX_MODELS` in `scripts/lib/duneCex.js`. Never ask the owner for a Dune query id: none is used.

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
Then go on to the local gates, PR and merge ("Start to finish", 4 to 6).

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
HBAR was onboarded and listed on 2026-11-15. It has no contract, so it has no answers file and no owner question pass. Proven on GitHub (2026-11-15): the every-balance scan in the nightly (65.5 minutes of a 120-minute step; 4,839,308 rows), the push of the sharded snapshot (11 shard files, 83.3 MiB in total, largest 10.5 MiB; `holders-ever-checkpoint.json` 64.4 MiB as one file), and the runner from tiers to list-on-site in one 8-minute run (13 tiers, three below 1 HBAR).
Holder rule (owner, 2026-11-14): every account with a positive balance is a holder, contracts included; accounts holding only HTS tokens (0 HBAR) are not. That is about 4.84M accounts, 86% of them under 1 HBAR. The adapter refuses a snapshot whose rows do not add up to total supply. A snapshot this large is stored as a small head file plus shard files (`tel-holders.d/`, `scripts/lib/snapshotShards.js`); read and write it only through `scripts/lib/snapshotIo.js`.
1. `npm run onboard -- --chain hedera` (dry run), then the same with `--write`. `0.0.N` addresses are Hedera tokens and are refused. The scaffold reads supply and decimals from the mirror node and writes the registry entry (`onboarding: true`), the project config, ledger config, exclusions (network treasury accounts, 0.0.98, 0.0.800, 0.0.801), WHBAR as role `dex`, the CEX list (24 seeded accounts, `scripts/lib/hedera/cexAccounts.js`; research in `docs/hedera-cex-candidates.md`), the forensics registry, `treasury.categories ["treasury"]`, a 180-minute job limit and the image. Owner decisions (`historyStart` forward-only, `largeHolders` rows) live in `scripts/lib/hedera/nativeDecisions.js`, not in the config.
2. PR and merge ("Start to finish", 4 to 6); `gh workflow run onboard-project.yml --ref main -f project=<slug>`.
3. Runner steps that apply: snapshot, large-holders, tiers and sizing, mega-threshold, snapshot on those tiers, exchange flows, tier outflows, wallet flows, ledger, Developer wallets tab, strict alignment, go-live, list-on-site. They do not apply: CEX sync (list comes from the scaffold), CEX candidate review (Solana only), history and treasury/CEX history (forward-only), staker balances.
4. A `large-holders` stop for HBAR says to add a row to `HEDERA_LARGE_HOLDERS` in `scripts/lib/hedera/nativeDecisions.js` (a code edit, then merge).

## Sizing is derived, never copied
Tiers, balance ranges, `retailThreshold` (lower bound of the second-lowest tier) and `concentrationBuckets` come from the token's own first snapshot, retail wallets only (`scripts/lib/deriveHolderTiers.js`, run by the runner; `node scripts/derive-holder-tiers.js --project <slug>` prints them). Balances below 1 are left out of the ladder unless folding them into the bottom tier would put more than 90% of wallets there; then tiers below 1 are added (`0.001-1`, `<0.001`; HBAR), a `<1` range is added to `balanceRanges`, and `retailThreshold` still comes from the at-or-above-1 ladder. `megaHolderThreshold`: the scaffold writes supply.target / 5 (and a `retailThreshold` at half of it if that is not above the default 1,000). The runner derives `max(supply.target / 5, 1.2 x the largest wallet acknowledged as retail, rounded up to 1 / 2.5 / 5 x 10^k, capped at supply.target)`, never lowers it, and later raises only that field. Never set it by hand: the next step overwrites it. Answers write `treasury.categories` as `treasury` only, and only when a treasury or association wallet exists (a bucket that can empty aborts the daily treasury history). Wallet-flow seller and swap thresholds and the CEX-candidate floor scale with supply (`scripts/lib/projectSizing.js`; 0.005%, 0.001%, 0.0001% of `supply.target`); a `sizing` block in the config overrides them (ONDO is pinned to the old values). Never copy another project's values. The runner treats `holders.defaultTiers` as already sized, but go-live requires explicit `megaHolderThreshold` and `retailThreshold` for own `distributionTiers`. Go-live also fails when one tier holds over 90% of wallets.

## Step 5. Gates, visual check, report
### 5a. Gates
`npm run onboard:check -- --project <slug>` runs, one after another, vitest, typecheck, lint, `check-feed-consistency --all --strict`, `pipeline-health` and `check-go-live --alignment strict`. It prints PASS/FAIL per gate with a log path under `tasks/`. `--skip-tests` drops the first three. All must pass; none may be skipped or allowlisted. After the same failure twice, change approach.

### 5b. Visual check (mandatory; gates do not catch UI problems)
Start the preview with `npx vite --port 5197 --strictPort --host 127.0.0.1` (never `npm run dev` or `npm run build`; they rewrite `public/sitemap.xml`), then run `node .claude/skills/onboard-project/visual-check.mjs --slug <slug> --out <scratch dir>` (add `--base http://127.0.0.1:<port>` if the preview runs on another port). It drives the landing page and `/<slug>` in headless system Chrome at 1440x900 and 390x844, clicks each tab, and writes a `.png` and a `.txt` text dump per view plus `report.json`, printing PASS/FAIL per view. Exit codes: 0 clean, 1 defects found (console error, sideways scroll, error page, NaN/undefined, near-empty page, missing tab), 2 could not run (nothing on `--base`, playwright-core or Chrome missing, a navigation failed). playwright-core is not a repo dependency: install it into a scratch dir (`npm install --prefix <scratch dir> playwright-core`) and pass `--playwright <scratch dir>/node_modules`. Never install it into this repo. The script does not compare numbers: read the `.txt` dumps against the feed files for each of these: landing tile, header, chain picker; Supply tiles sum to supply; tier counts, no all-wallets-in-one-tier; holders history range; Exchange Net Flow changes across 1D, 7D, 30D, 90D, YTD; tier flow has no NaN or blank cells; Staked panel or the no-staking note; explorer links (case-exact base58); no "Staked <ticker>" text for a token without staking; gated wallet-flows panel has no empty cards and onward totals never exceed received.
**Pass:** every number on the page equals the feed value at the displayed precision (rounding only); anything else is a failure to report, not to fix by hand. Include a screenshot path per page and width.
**Stop if:** you did not render the page. Say so. Never report a visual check you did not do.

### 5c. Sign-off and report
Spawn the `verifier` agent with the 5a and 5b results; it is read-only. Fix what it proves, rerun 5a. Then one report: what was automatic, what was manual, assumptions, open items, files changed. Update in the same change: `README.md`, `docs/MULTI-TOKEN.md` if a step changed, `tasks/lessons.md` for any mistake caught, this file. Deploys are manual (Netlify dashboard); config reaches the browser at the next deploy, data through `live-data.mjs`.

## Day-after store check
After the first scheduled nightly that includes the coin (not a dispatch; one run per day):
1. In that run, the store steps are green: each holders lane and the `store-publish` job (`gh run view <id>`).
2. `data/manifests/<slug>.json` and `data/manifests/index/<slug>.json` exist on `main` (`git pull`, then look).
3. No open issue titled "Store dual-write failure" (`gh issue list --search "Store dual-write failure" --state open`).
If one fails, report it with the log lines; do not edit the pipeline to hide it. To switch the store off without touching data, the owner sets the repository variable `HD_STORE=off` (a repository setting, gated); it takes effect from the next scheduled night. The `store=off` input applies only to a dispatch that is allowed anyway, such as a recovery run for a failed night. Never dispatch only to turn the store off: that is a second run for every coin that already has the day's data.

## Known traps
- Replay vs snapshot holder definition (18-decimal dust): the rebuild passes `dropRoundedDust`; confirm decimals before a rebuild.
- Never label a snapshot row with the run time. Row D is the state at the end of D.
- Solana flow feeds stamp from slot cutoffs: an incomplete scan stamps `date: null, settled: false`. Solana holder snapshots are live reads (`live: ["<chain>"]`); alignment allows 1 day.
- A rebuild that wrote `T00:00` rows: `node scripts/relabel-midnight-history.js --project <slug>` (dry run), then `--apply`.
- A feed's last row used as "now" hides a stale feed: gate on `stale-tail`.
- `breaksSeries` daggers every Distribution Change cell: never use it to explain a bug.
- A helper-run rebuild crossing UTC midnight writes a row that disagrees with the snapshot: regenerate through the workflow.
- CI after data commits on `main`: `gh pr update-branch <n>`; a plain rerun reuses the old merge commit.
- `verify` is red on `main` from the scaffold merge until the token's first feeds are committed (`check:feeds` finds no feeds for it). Expected; it must turn green after the onboarding run.
- A stale project list in local tests after adding a token (`projects.test.ts` fails, CI passes): vitest's on-disk module cache skips only files containing the exact text `import.meta.glob(`. Never write `import.meta.glob<T>(`; a test rejects it under `src/`.
- Two holders runs for one token on one day: the second has no previous snapshot (`<x>-holders-previous.json` is a same-run scratch file), so before the same-day gate it published `cex-flows.json` with `comparison.available: false` and `check:feeds` still passed. GitHub's scheduled run can arrive hours after a manual one. Check `gh run list --workflow refresh-holders.yml` before any manual dispatch.
- A "labelled wallet absent from today's snapshot" failure in "Append today's treasury balances" is not proof of a drain: check which previous snapshot the guard read (2026-11-14: a stale tracked `public/data/tel-holders-previous.json` on a second same-day run). Do not add the address to `treasury.allowVanished` without an on-chain check.
- An onboarding run in flight uses the `onboardRun.js` it started with. Do not merge a change to `refresh-holders.yml` inputs or to the runner while one is running.
- A ghost run blocks a step: GitHub can leave a scheduled run "queued" with no jobs for days (2026-11-14: a wallet-flows run from 11-11; the runner waited on it for 2.5 hours at `wallet-flows`). The runner now ignores a run that has been active for more than 24 hours and prints the `gh run cancel <id>` for it. A runner that sits on one step with no child run in `gh run list --status in_progress` is waiting on something: read its log.
- The auto-mode classifier can refuse a `gh workflow run`. Do not work around it: tell the owner and give them the command.
- GitHub rejects any file of 100 MiB or more, at the push, after the scan has run. Check the size of a locally built snapshot before the first dispatch; `writeSnapshotFiles` switches a single-chain snapshot to shards from 50 MiB and refuses at 95 MiB. Never answer a size problem with a balance floor (2026-11-14: HBAR's first run scanned for 72 minutes, then could not push 137.79 MB).
- A script that reads `tel-holders.json` with a bare `JSON.parse` sees no `wallets` in a sharded snapshot and publishes zeros. `scripts/lib/snapshotReadGuard.test.js` fails on such a read; use `readSnapshot`.
- Resetting a token's history while its old snapshot stays on `main`: any workflow that runs `generate-holders-history.js` before the next holders run (the Dune CEX sync, for one) writes a row from the old snapshot (2026-11-15: HBAR got a 681,597-holder row in front of its first 4,838,755 row, and `check:feeds --strict` reported a 609.9% move). Delete `holders-history.json`, run `node scripts/generate-holders-history.js --project <slug>` on the new snapshot, and commit the result.
- The runner's go-live step runs `check-go-live` with strict alignment; it does not run `check-feed-consistency --strict` or vitest against the config it derived (2026-11-15: HBAR was listed while a registry-wide tier test and the strict feed check both failed). `npm run onboard:check` runs both; run it after the runner says "onboarded" and before telling the owner to deploy.
- A native coin's chain has no `tokens` list (`ProjectChain.tokens` is optional). Site code that reads `c.tokens` unguarded renders the error page for that token only (2026-11-15: `/hedera`, found by the visual check, not by any gate).
- `generate-holder-transitions.js` finds past snapshots by commit date, and a settled day's snapshot is committed the next day. It never uses a base snapshot dated before the first `holders-history.json` row (`scripts/lib/transitionBase.js`), so a token whose history was restarted is not compared against its old snapshots.
- A helper's finding is a claim: reproduce it in code or browser before acting.
- Tests that copy numbers from a feed go red within hours: assert shape.
- Not built yet: one address-array scan per chain across EVM projects, EVM sales tracing, a Solana CEX detector, a per-project budget block, a mixed EVM+Solana forensics merge (both generators write one report path), and for Hedera: DEX/WHBAR look-through, swap decoding, onward-hop tracing of unlabelled recipients, history before the first snapshot, tracing of 0.0.54 and the protocol accounts.

## Unproven
`onboard-project.yml` has carried one token to go-live (HBAR, 2026-11-15), but in two runs with a holder-rule change between them; a new token in one uninterrupted run is unproven, and so is any EVM or Solana token through the runner. The sharded layout is proven for `0.0.N` addresses only. EVM discovery over real RPC is unit-tested only on this machine (its network blocks most public Ethereum RPC hosts).
