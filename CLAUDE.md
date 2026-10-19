# Holder Distribution — Claude Handoff

## What this repo is

A single-page React app that shows on-chain analytics for the TEL token: holder distribution, supply breakdown, exchange flows, and historical growth trends. It lives at **holderdistribution.com** and is deployed on Netlify.

The site was originally extracted from a larger Telcoin Hub multi-page app. It is now its own standalone product under the **Holder Analytics** brand — rebranding from "TelcoinHub" to "Holder Distribution / Holder Analytics" is in progress.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Framework | React 18, TypeScript, Vite |
| Styling | Tailwind CSS v3, `tailwind.config.ts` holds all design tokens |
| UI primitives | Radix UI (accordion, dialog, tabs, tooltip, select, etc.) |
| Charts | Recharts |
| Data fetching | TanStack Query v5 |
| Backend | Supabase (auth + database) |
| Animations | Framer Motion |
| Deployment | Netlify (manual deploys only — git pushes do NOT trigger builds) |
| Functions | Netlify Functions (`netlify/functions/`) via esbuild bundler |

---

## Project structure

```
holderdistribution/
├── src/
│   ├── App.tsx               — router; single route: / and /holders → Holders page
│   ├── pages/
│   │   └── Holders.tsx       — THE page. Three tabs: Holders, Distribution, Supply
│   ├── components/           — all UI components (see below)
│   ├── hooks/                — data-fetching hooks (all named use*.ts)
│   ├── lib/                  — pure utilities (timeRange, baseline, heroCollapse, etc.)
│   ├── integrations/
│   │   └── supabase/         — Supabase client, type defs, auth storage
│   ├── assets/               — SVG logos (holder-analytics-*.svg)
│   └── index.css             — CSS custom properties / design tokens
├── netlify/
│   └── functions/
│       └── forensics-gate.cjs — serverless function gating premium forensics content
├── public/
│   ├── sitemap.xml
│   └── manifest.json
├── data/                     — static JSON data files served as /data/*
├── config/
│   ├── cex-wallets.json      — known CEX wallet addresses
│   ├── chains.json           — chain config + TEL contract registry (legacy + v3, see docs/TEL-CONTRACTS.md)
│   ├── exclusions.json       — addresses excluded from holder counts
│   └── dex-contracts.json    — DEX contract addresses
├── scripts/                  — Node.js data pipeline scripts (run locally/CI)
├── audit/                    — site audit tooling scripts
├── design-system/            — Holder Analytics design system (tokens, logos, components)
├── tailwind.config.ts        — all design tokens (colors, typography, radius, shadows)
└── netlify.toml              — deploy config (manual-only) + security headers
```

---

## Key components

| Component | What it does |
|-----------|-------------|
| `HolderKpiHero` | Top KPI strip — 4 tiles (holders, retail held, staked, CEX) that deep-link into tabs |
| `HolderGrowthWidget` | Line chart of holder growth over time, tabbed by sub-panel (trends/balances/staking/flows) |
| `DistributionAnalysisWidget` | Whale/tier breakdown charts |
| `SupplyBreakdown` | Circulating supply reconciliation |
| `ExchangeFlowWidget` | CEX inflow/outflow charts |
| `ForensicsGate` | Premium gated content UI |
| `Navigation` | Top nav — auto-hides hamburger when empty |
| `Footer` | 2-column (Official Sites + Social Media) + donation section |

---

## Data hooks (src/hooks/)

All hooks fetch from Supabase or parse local JSON. Pattern: `use*.ts` → TanStack Query → component.

Key hooks:
- `useHolderSnapshot` — snapshot of current holder counts/tiers
- `useHoldersHistoryData` — time-series holder history
- `useSupplyReconciliation` — supply breakdown data
- `useExchangeFlow` — CEX flow data
- `useTreasuryHistory` — treasury wallet history
- `useEcosystemHeadlineTiles` — drives the 4 KPI hero tiles

---

## Design system

Full spec lives in `design-system/` and `BRAND.md` inside it.

**Brand:** Holder Analytics — on-chain holder tracking tool. Tone: precise, current, data-first.

**Key tokens** (defined in `tailwind.config.ts` + `src/index.css`):
- `brand` — dark teal, primary identity color
- `accent` (gold) — premium/featured moments only, never everyday actions
- `positive` / `negative` — green/red for actual holder inflows/outflows only
- `warning` — caution, separate from accent
- `ha-accent` — alias for gold accent in Tailwind

**Fonts:** Inter (UI text) + IBM Plex Mono (chain-native values: amounts, addresses, hashes)

**Logos:** Three lockups in `src/assets/` and `design-system/logos/`:
- `holder-analytics-icon.svg` — mark only (favicon, avatars)
- `holder-analytics-stacked.svg` — icon above wordmark (portrait/square placements)
- `holder-analytics-horizontal.svg` — icon beside wordmark (nav bar)

---

## Deployment

**Deploys are manual-only.** Git pushes do NOT trigger Netlify builds.

To deploy:
1. Push code to `main` on GitHub
2. Go to the Netlify dashboard → trigger a manual deploy

Why: data refresh commits run frequently and shouldn't trigger full rebuilds.

**Build command:** `npm run build`
**Publish dir:** `dist`
**Functions dir:** `netlify/functions`

The `prebuild` script runs `generate-sitemap.ts` and `bundle-forensics-gate.js` automatically before `vite build`.

---

## Data pipeline (scripts/)

Node.js scripts that pull on-chain data and update JSON files in `data/`. Run locally or via cron.

Key scripts:
- `pull-holders-rpc.js` — fetch holder counts from RPC
- `generate-holders-history.js` — build time-series history
- `scan-exchange-flows.js` — detect CEX wallet flows
- `reconcile-supply.js` — supply breakdown reconciliation
- `generate-sitemap.ts` — auto-generate sitemap (runs on build)
- `pipeline-health.js` — health check for the data pipeline

### TEL v3 (two tokens, one 100B supply)

Telcoin upgraded TEL: legacy TEL (2 decimals, per-chain address) is swapped 1:1 for TEL v3 (18 decimals, one
address on every chain) through `TokenMigration`, which locks the legacy TEL and mints the v3. The pipeline
therefore tracks **both** tokens (`config/chains.json` `tokens.legacy` / `tokens.v3`, with `deployBlock`):

- A wallet's balance (`*_balance` in `tel-holders.json`) = legacy + v3, each normalised with its own decimals
  (`scripts/lib/telTokens.js`). The v3 share is also published as `ethereum_v3` / `polygon_v3` / `base_v3`
  (only when non-zero), so pre-v3 snapshots stay valid unchanged.
- Legacy TEL that the upgrade contracts received **in the same tx that minted v3** is "retired" (netted out of
  the contract's wallet); legacy sent there with no swap stays counted once. `TokenMigration` and
  `MigrationVault` are labelled `escrow` in `config/exclusions.json`.
- v3 is checkpointed separately (`holders-checkpoint.json` → `chains.<chain>.v3`) and scanned from its deploy
  block. `--as-of` rebuilds are legacy-only and refuse dates on/after the v3 deploy.
- Supply identity (`scripts/lib/supply.js`): total = legacy supply on Ethereum (100B); `totals.crossCheckTotal`
  (Σ chains of legacy+v3 − Ethereum bridge locks) must land on it. `node scripts/verify-tel-supply.js` re-derives
  the whole proof from public RPCs. Derivation and numbers: `docs/TEL-CONTRACTS.md`, "Supply accounting".

- Balances are replayed from zero, so each chain's legacy scan must start at the token's **deploy block**
  (`fromBlock`; Polygon 11,264,036 — it used to be 21.5M, which dropped ~298M TEL of early holders). The
  checkpoint records the `fromBlock` it was built from and is rebuilt (legacy part only) if config changes it.
  The first run after such a change is a full Polygon rescan.

**Important:** data-refresh commits are tagged `[skip netlify]` or rely on the `ignore = "exit 0"` rule — they do not trigger deploys.

---

## Environment variables

Required for Supabase and RPC access. Use `scripts/loadEnv.js` for local dev.
Secrets are encrypted via `scripts/encrypt-env.js` / `decrypt-env.js`.

---

## Current goals / active work

- **Rebrand status (2026-10-18):** the UI, theme tokens, logo, favicons, OG image, meta tags and canonical URLs are now Holder Analytics / holderdistribution.com. `src/index.css` maps the shadcn variables to the Holder Analytics palette; `--ha-*` tokens are defined there. See `README.md` and `docs/DEPLOYMENT.md` for run/deploy/security notes.

- **Rebranding** from "TelcoinHub" → "Holder Distribution" / "Holder Analytics" brand is partially complete. The Footer, copyright, and design system are updated. Some component interiors and meta tags may still reference the old brand.
- **Design system rollout** — tokens are in `tailwind.config.ts` and `design-system/tokens.css`. Components should progressively adopt the semantic tokens (`brand`, `positive`, `negative`, `ha-accent`, etc.) instead of raw Tailwind color classes.
- **Forensics Gate** — premium content gate in `netlify/functions/forensics-gate.cjs`. Gated via `ForensicsGate.tsx` + `SubscriptionGate.tsx` components.

---

## Common commands

```bash
npm run dev          # start dev server (also runs generate-sitemap first)
npm run build        # production build
npm run typecheck    # TypeScript check (both tsconfig.app.json + tsconfig.node.json)
npm run lint         # ESLint
npm run test         # Vitest
npm run pipeline:health  # check data pipeline status
npm run check:feeds  # validate data feed outputs
```

---

## Repo

GitHub: `https://github.com/fabcrowd/holderdistribution`
Branch: `main`
Live site: `https://holderdistribution.com`
