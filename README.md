# Holder Distribution

On-chain holder analytics for multiple tokens — holder distribution and tiers, supply
breakdown, exchange flows, staking and historical growth — published at
[holderdistribution.com](https://holderdistribution.com) under the **Holder Analytics** brand.
Mapped so far: **TEL** (Telcoin; Ethereum, Polygon, Base) and **ZBCN** (Zebec Network; Solana).

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

```
src/pages/                 Landing (token picker), Holders (the terminal), NotFound
src/components/            widgets; chart/, terminal/, tierflow/, routing/, ui/ (shadcn primitives)
src/hooks/                 TanStack Query data hooks (keyed by project slug)
src/lib/                   pure helpers: project registry, chain views, charts, supply, staking
src/index.css, tailwind.config.ts   design tokens (Holder Analytics palette)
config/projects.json       token registry; config/projects/<slug>.json = per-token config
config/*.json              shared classification (CEX / DEX / exclusions) and TEL chain map
public/data/               generated feeds: TEL at the root, others in public/data/<slug>/
data/                      pipeline caches and checkpoints (not served)
scripts/                   data pipeline (RPC / Etherscan / Dune / Solana) + tests; lib/ = shared logic
netlify/functions/         live-data.mjs (fresh feeds from GitHub) + bundled forensics-gate.cjs
netlify/functions-src/     forensics gate source (bundled by prebuild)
design-system/             brand spec, tokens, logos
.github/workflows/         ci.yml + scheduled data-pipeline workflows (nightly refresh runs per project)
docs/DEPLOYMENT.md         deploy + production-readiness runbook
docs/FORENSICS.md          password-gated forensics (Wallet flows), gate hardening, password rotation
docs/PIPELINE-RECOVERY.md  recovering a stalled or broken data pipeline
docs/TEL-CONTRACTS.md      TEL contract registry (legacy vs. v3) + supply accounting (legacy + v3 = 100B)
CLAUDE.md                  deeper architecture/handoff notes
```

Mapping a new token is config-only: register it in `config/projects.json`, add
`config/projects/<slug>.json`, and the landing page, sitemap and nightly refresh pick it up.
See [docs/MULTI-TOKEN.md](docs/MULTI-TOKEN.md) for the layout, the pipeline `--project <slug>`
flag, Solana support and the onboarding checklist.

## Deploying

Production deploys are **manual** from the Netlify dashboard — git pushes (including branch
and PR previews) are suppressed by `ignore = "exit 0"` in `netlify.toml`. Read
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before shipping.
