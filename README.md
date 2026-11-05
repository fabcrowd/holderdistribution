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
scripts/check-go-live.js           go-live gate (lib/goLive.js): no skips, placeholders fail
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

## Recent work
- **Merged to `main`:** #128 developer wallets ledger and view (EVM and Solana bot-proceeds tracing, one-command add-project), #129 developer-wallets headline asserted from DOM text, #130 ONDO project on the nightly wallet-flows schedule.
- **Open PRs:** #132 nightly framework (shared job plan, per-job Alchemy budget guard, chain-inventory onboarding; under review, not merged); #127 Solana replay fixes (fail fast without a keyed RPC, history-start note; supersedes #105).
- **Local, unpushed:** the nightly holders workflow is renamed from `refresh-tel-holders.yml` to `refresh-holders.yml`, and the docs no longer describe TEL as the product. `check-go-live.js` is the single completeness gate; wallet-flows now runs for every registry project; wallet-flow and ledger jobs fail on a missing or stale report; `add-project` leaves the Developer wallets tab off until a ledger exists; onboarding covers wallet-flow history and developer wallets. Built on #132 with its review fixes: `feedsPending` removed (`check:feeds` fails until ONDO has feeds), the ledger's Alchemy path is budget-guarded, job provider order is enforced, the monthly ceiling also stops warn jobs, budgets add up across a job's processes, and warn mode has a review date. #133 ONDO tagging is merged in; `check-go-live` also fails when a treasury, holdings or association wallet in a project's forensics registry is missing from its `ledger.json` (ONDO's five distribution wallets were added).
- 2026-11-01 forensics: every project now needs a forensics registry (`npm run init:forensics`, enforced by `check:feeds`). Solana tokens get a gated Wallet flows report (`scripts/generate-wallet-flows-solana.js`) with swap proceeds and one- or two-hop tracing of unlabelled recipients (`WALLET_FLOWS_TRACE_DEPTH`, call-budgeted). `sync-cex-wallets.yml` now imports the spellbook CEX list for every registry project. Merged in #126. See `docs/FORENSICS.md` and `docs/MULTI-TOKEN.md` step 11.

- **2026-11-05: history-gap fill for a new token.** `fill-history-gaps.js` counted the 14 days before a project's first history row as gaps and then failed trying to rebuild them (no earlier checkpoint exists), which failed ONDO's first run and would have failed it nightly for two weeks. Days before the first row are now ignored (`missingHistoryDates`). A project's history is forward-only from its first snapshot, as ZBCN's is.
- **2026-11-05: first-run holder transitions.** A new token's first refresh failed at "Verify generated files": `generate-holder-transitions.js` builds its windows from the git history of the committed snapshot, which does not exist until the commit step that follows, so it wrote nothing. It now writes a valid empty feed (`ranges: {}`, which the UI already reads as no data) on a first run; the next night builds the real windows. ZBCN had worked around this by committing its first feeds by hand.
- **2026-11-05: ONDO refresh speed and treasury categories (#138).** The first ONDO scan lost ~2 minutes on every dense eth_getLogs range: `rpc.js` retried mevblocker's `-32005 "query returned more than 10000 results"` six times as if it were rate limiting, though that answer never changes. A `-32005` that matches the range-limit wording now fails at once so the range is split immediately (plain `-32005` rate limits still retry). ONDO also declares `treasury.categories: ["treasury"]`, because `append-treasury-history` defaulted to TEL's four categories and aborted on the missing `council`. `council` stays a naming tag on TEL wallets (Compliance Council, TELx Council); it carries no special logic.
- **2026-11-05: ONDO config for its first feeds.** The ONDO refresh failed at `reconcile-supply` because `main`'s `config/projects/ondo.json` had no `supply.target`. This brings over the ONDO config from #133 (10B target, Foundation treasury and distribution-Safe roles, circulating and developer-holdings rules, CEX wallets, developer-wallet ledger). `pipeline.feedsPending` stays on until the first feeds are committed; the go-live gate (#135) removes it.
- **2026-10-31 22:29 (ET): UI and landing page.** Header is one row: "Holder Distribution" title, the open token's mark beside the chain and timeframe selectors, and a Stale/Delayed pill only when the refresh is behind (no date badge). Brand text is "Holder Distribution" across UI, meta and docs; asset file names are unchanged. SEO descriptor is "Token Holder Distribution & Supply Data". Landing page has a hero with the tagline "Blockchain without the BS.", a "Cutting through the noise" band and the token list. Raw green/red/amber classes moved to semantic tokens; shared `Callout` component added; unused badge variants and the violet/sky tab accents removed. Typecheck, lint and the full suite (173 files, 1541 tests) pass. Not yet checked in a browser at phone width.
- **SQD Portal backfill (opt-in, local):** `generate-wallet-flows.js --source portal` reads EVM logs from SQD Portal instead of Alchemy, with a completeness gate against RPC; `--as-of <date> --out <path>` builds historical reports. See [docs/FORENSICS.md](docs/FORENSICS.md).
- **2026-11-01: nightly pipeline cost and reliability.** ZBCN exchange and tier flows are still being brought up; their feeds stay marked placeholder in `config/projects/zebec-network.json` until they populate (2026-10-25 onward, forward-only history). The Solana flow scan reads `SOLANA_RPC_0` and `SOLANA_RPC_1` (Helius free tier) before the public node, saves progress every 60 transactions, asks for transaction version 1, and runs up to 40 minutes and 15,000 transactions a night (about 12k a day is ZBCN's venue volume). Run metrics write `data/<slug>/rpc-usage.json` and check month-to-date use against `config/budgets.json` (30M Alchemy CU, 1M Helius credits). The holders pull shares its Transfer logs with the exchange-flow and tier scans (`HD_SHARED_SCAN=off` disables), and staker balances are read through Multicall3. A final "Stage verdict" step turns any failed non-fatal stage into a red run and a failure issue. A ZBCN backlog of about 88k transactions cost about 90k Helius credits.
- **Known issues:** the Dune API CEX sync fails with HTTP 402 (the account's datapoint cap), so the CEX list has not grown since 2026-09-20; `--source spellbook` is a free supplement, and `sync-cex-wallets.yml` runs it for every registry project (EVM adds addresses; other chains get review candidates only). ZBCN has a forensics registry (`data/zebec-network/forensics/`), but its wallet flows are not yet confirmed and its exchange and tier-outflow feeds are still placeholders.

## Deploying

Production deploys are **manual** from the Netlify dashboard — git pushes (including branch
and PR previews) are suppressed by `ignore = "exit 0"` in `netlify.toml`. Read
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before shipping.
