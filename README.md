# Holder Distribution

On-chain holder analytics for multiple tokens — holder distribution and tiers, supply
breakdown, exchange flows, staking and historical growth — published at
[holderdistribution.com](https://holderdistribution.com) under the **Holder Distribution** brand.
Mapped so far: **TEL** (Telcoin; Ethereum, Polygon, Base) and **ZBCN** (Zebec Network; Solana).
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
config/projects/<slug>.json        per-token config (tel.json, zebec-network.json)
config/*.json                      shared classification: cex-wallets, dex-contracts, exclusions, chains, holder-tiers
public/data/                       generated feeds served to the browser: TEL at the root, others in public/data/<slug>/
data/                              pipeline caches and checkpoints (not served); data/forensics/ = gated wallet flows
```

**Data pipeline (`scripts/`)**
```
scripts/*.js, scripts/*.ts         CLI entry points (holders, history, exchange flows, CEX wallets, Solana, staking)
scripts/lib/                       shared logic with sibling *.test.js; lib/solana/ = Solana adapter and flows
scripts/validate-outputs.js        feed gates: npm run check:feeds, npm run pipeline:health
scripts/encrypt-env.js, decrypt-env.js, loadEnv.js   .env.enc secrets
scripts/CLAUDE.md                  TEL v3 accounting rules
```

**Serverless, build and CI**
```
netlify/functions/live-data.mjs    serves fresh feeds from GitHub without a rebuild
netlify/functions/forensics-gate.cjs   bundled gate (built from netlify/functions-src/ by prebuild)
netlify.toml                       security headers, manual-deploy rule
supabase/functions/wallet-analysis-gate/   Supabase edge function for wallet analysis
.github/workflows/                 ci.yml; refresh-tel-holders.yml (nightly holders); per-project refresh,
                                   rebuild, scan and sync jobs; pipeline-watchdog.yml (self-heal stale feeds)
```

**Docs, design and audit**
```
docs/DEPLOYMENT.md                 deploy and production-readiness runbook
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
See [docs/MULTI-TOKEN.md](docs/MULTI-TOKEN.md) for the layout, the pipeline `--project <slug>`
flag, Solana support and the onboarding checklist.

Historical wallet-flow backfills can read from SQD Portal (`generate-wallet-flows.js --source portal`,
opt-in, EVM only, completeness-gated, no Alchemy CU). See "Backfill via SQD Portal" in
[docs/FORENSICS.md](docs/FORENSICS.md) and step 9 of the onboarding checklist.

## Recent work
- 2026-11-01 forensics: every project now needs a forensics registry (`npm run init:forensics`, enforced by `check:feeds`). Solana tokens get a gated Wallet flows report (`scripts/generate-wallet-flows-solana.js`) with swap proceeds and one- or two-hop tracing of unlabelled recipients (`WALLET_FLOWS_TRACE_DEPTH`, call-budgeted). `sync-cex-wallets.yml` now imports the spellbook CEX list for every registry project. Merged in #126. See `docs/FORENSICS.md` and `docs/MULTI-TOKEN.md` step 11.

- **2026-10-31 22:29 (ET): UI and landing page.** Header is one row: "Holder Distribution" title, the open token's mark beside the chain and timeframe selectors, and a Stale/Delayed pill only when the refresh is behind (no date badge). Brand text is "Holder Distribution" across UI, meta and docs; asset file names are unchanged. SEO descriptor is "Token Holder Distribution & Supply Data". Landing page has a hero with the tagline "Blockchain without the BS.", a "Cutting through the noise" band and the token list. Raw green/red/amber classes moved to semantic tokens; shared `Callout` component added; unused badge variants and the violet/sky tab accents removed. Typecheck, lint and the full suite (173 files, 1541 tests) pass. Not yet checked in a browser at phone width.
- **SQD Portal backfill (opt-in, local):** `generate-wallet-flows.js --source portal` reads EVM logs from SQD Portal instead of Alchemy, with a completeness gate against RPC; `--as-of <date> --out <path>` builds historical reports. See [docs/FORENSICS.md](docs/FORENSICS.md).
- **2026-11-01: nightly pipeline cost and reliability.** ZBCN exchange and tier flows now populate (2026-10-25 onward, forward-only history). The Solana flow scan reads `SOLANA_RPC_0` and `SOLANA_RPC_1` (Helius free tier) before the public node, saves progress every 60 transactions, asks for transaction version 1, and runs up to 40 minutes and 15,000 transactions a night (about 12k a day is ZBCN's venue volume). Run metrics write `data/<slug>/rpc-usage.json` and check month-to-date use against `config/budgets.json` (30M Alchemy CU, 1M Helius credits). The holders pull shares its Transfer logs with the exchange-flow and tier scans (`HD_SHARED_SCAN=off` disables), and staker balances are read through Multicall3. A final "Stage verdict" step turns any failed non-fatal stage into a red run and a failure issue. A ZBCN backlog of about 88k transactions cost about 90k Helius credits.
- **Known issues:** the Dune API CEX sync fails with HTTP 402 (the account's datapoint cap), so the CEX list has not grown since 2026-09-20. `--source spellbook` is a free supplement and runs in `sync-cex-wallets.yml` for every registry project.

## Deploying

Production deploys are **manual** from the Netlify dashboard — git pushes (including branch
and PR previews) are suppressed by `ignore = "exit 0"` in `netlify.toml`. Read
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before shipping.
